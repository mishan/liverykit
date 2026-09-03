// ---------------------------------------------------------------------------
// Orchestration: car profile + livery -> a folder of DDS files -> a ZIP that
// Content Manager installs without asking questions.
// ---------------------------------------------------------------------------

import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import sharp from 'sharp';

import { mulberry32, seedFrom } from './engine/rng.mjs';
import { composeLayers, toDDS, toPNG, isPngTexture, makeBadge, rasterize, magickBin } from './engine/pipeline.mjs';
import { packageZip, makePreview } from './engine/package.mjs';
import { uvGridSvg, gridShape, probeSvg, makeProbes } from './engine/uvgrid.mjs';
import { resolveTreatments } from './registry.mjs';
import { renderTexture } from './render.mjs';
import { texture, resolveTargets } from './profile.mjs';
import { allRegionKeys, applyFit, regionIds, unusedFitIds } from './fit.mjs';
import { hidePlan } from './hide.mjs';

// Re-exported: `hidePlan` lived here first, and the build is where anybody
// looking for what `hide` does would go.
export { hidePlan } from './hide.mjs';

const DEFAULTS = { seed: 'default', glowSigma: 14, font: 'sans-serif' };

// Note statuses that mean "this surface was NOT painted", as opposed to the ones
// that mean "it was painted and here is a caveat". Only the first group belongs
// under a heading that says nothing was painted.
//
// `fit-stale` belongs to the second group. A fit override that cannot be applied
// leaves the region exactly where the livery put it, so the surface still gets
// painted; filing it under "asked for and not painted" would report artwork that
// is on the car as absent from it.
const MISSING = new Set(['absent', 'unbound', 'unencodable', 'no-match']);

/** Was this surface actually left unpainted, or merely painted with a caveat? */
export function isMissingNote(note) {
  return MISSING.has(note.status);
}

/** A fully transparent PNG at the texture's size, for the encoder to turn into DXT5. */
async function transparentPng(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png().toBuffer();
}

/**
 * The size a hidden surface's clear sheet is shipped at. A texture with no
 * texels worth seeing needs no texels: the game stretches whatever it is given
 * over the mesh, and nothing-times-1024 is the same nothing as nothing-times-4.
 * At the original size the NSX's two IGT plates came to 2.8 MB of transparent
 * DXT5; at 4x4, the smallest a DXT block allows, they are a few hundred bytes.
 */
const CLEAR_SHEET = 4;

/**
 * Render every painted texture in a livery.
 *
 * `scale` multiplies each texture's native size, so one livery renders at 2K or
 * 4K without edits — every coordinate in the system is a fraction, never a
 * pixel.
 */
export async function buildSkin({ profile, livery, outDir, scale = 1, seed, flat = false, fit = null, pngDir = null, liveryDir = null, log = console.log }) {
  await magickBin();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  // Intermediate PNGs go in a SIBLING directory, never in the skin folder —
  // packaging zips everything it finds there, and nobody wants six multi-megabyte
  // PNGs installed into their game alongside the textures.
  if (pngDir) await mkdir(pngDir, { recursive: true });

  const render = { ...DEFAULTS, ...(livery.render ?? {}) };
  const seedStr = seed ?? render.seed;
  const treatments = resolveTreatments(livery.packs ?? ['core']);
  const tokens = { ...(livery.identity ?? {}) };

  // Region ids are validated even without a fit: a duplicate id is a latent
  // ambiguity, and it should surface when the livery is written rather than the
  // first time somebody tries to adjust it.
  regionIds(livery);
  const fitUsed = new Set();

  // `paint` names this car's roles; `surfaces` names vocabulary terms and gets
  // translated through the profile's bind table.
  const { targets: requested, notes } = resolveTargets(profile, livery);

  // Pre-flight, before anything is encoded. Some cars ship textures at sizes DDS
  // cannot carry a mip chain for — the Abarth's steering wheel is 68x64 — and
  // hitting one of those halfway through used to abort the build after writing
  // five perfectly good files. A surface this tool cannot encode is effectively
  // one the car does not have, so it is reported and skipped like any other.
  const targets = [];
  for (const t of requested) {
    const tex = texture(profile, t.role);
    if (!isPngTexture(tex.file) && (!isPow2(tex.width) || !isPow2(tex.height))) {
      notes.push({
        term: t.from, status: 'unencodable',
        text: `${t.from} -> ${tex.file} is ${tex.width}x${tex.height}; DDS needs powers of two, so it cannot be painted`,
      });
      continue;
    }
    targets.push(t);
  }
  if (!targets.length) {
    throw new Error(
      `Livery "${livery.name}" has nothing it can paint on car "${profile.id}":\n  ` +
      notes.map((n) => n.text).join('\n  ')
    );
  }

  // Every id a fit could address across the whole livery, computed once. Fit ids
  // are flat while this loop runs once per surface, so "is this name taken?" is
  // not a question any single pass can answer.
  const reserved = allRegionKeys(targets);

  let firstPng = null;
  const written = [];

  for (const { from, role, spec, primary } of targets) {
    const tex = texture(profile, role);
    // Regions that matched no panel are collected here and reported with
    // everything else at the end, rather than one line at a time mid-build.
    const regionNotes = [];
    const width = Math.round(tex.width * scale);
    const height = Math.round(tex.height * scale);

    const layers = renderTexture({
      profile,
      role,
      // --flat proves the plumbing before any art exists: if the car doesn't
      // turn a solid colour, the DDS format or a filename is wrong and no
      // amount of artwork will fix it.
      // Fit first, so an override that names a panel replaces the tag selection
      // before anything is expanded. Then `once`, which keeps a region on a
      // term's PRIMARY texture: a term can resolve to several — `body` on the
      // RSS4 is two chassis textures — and a pattern belongs on all of them
      // while a car number belongs on the car once, not once per texture.
      regions: flat ? [] : applyFit(
        (spec.regions ?? []).filter((r) => !(r.once && !primary)),
        // `surfaceKey` is not optional here, whatever the default says. A region
        // the design gave no id is addressed by POSITION, and the key is made
        // from the surface it sits on: the editor writes `body#0`, so a build
        // that computed `#0` matched none of them. The editor's own output then
        // adjusted nothing, and said so only as a stale-id note at the end.
        //
        // `reserved` is every key the livery declares anywhere, so a copy cannot
        // take a name belonging to a region on another surface.
        fit, { profile, role, surfaceKey: from, used: fitUsed, notes, reserved },
      ).regions,
      background: spec.background,
      treatments,
      palette: livery.palette ?? {},
      rng: mulberry32(seedFrom(seedStr + tex.file)),
      font: render.font,
      tokens,
      regionNotes,
    });
    notes.push(...regionNotes);

    const png = await composeLayers({
      base: scaleSvg(layers.base, scale),
      emissive: scaleSvg(layers.emissive, scale),
      hasEmissive: layers.hasEmissive,
      width,
      height,
      glowSigma: render.glowSigma * (Math.max(width, height) / 2048),
      // AO paths are resolved against the livery file rather than the process
      // CWD, so a livery keeps working when built from another directory.
      aoPath: flat ? null : resolveAo(livery.ao?.[role], liveryDir),
    });

    const asPng = isPngTexture(tex.file);
    const pngPath = join(pngDir ?? outDir, tex.file.replace(/\.(dds|png)$/i, '.png'));
    const outPath = join(outDir, tex.file);
    await writeFile(pngPath, png);
    if (asPng) await toPNG(pngPath, outPath);
    else await toDDS(pngPath, outPath, { width, height, alpha: tex.alpha ?? false });
    if (!pngDir && pngPath !== outPath) await rm(pngPath);

    firstPng ??= png;
    written.push(tex.file);
    const kb = (await stat(outPath)).size / 1024;
    log(`  ${tex.file.padEnd(24)} ${width}x${height}`.padEnd(46) +
      `${asPng ? 'PNG ' : tex.alpha ? 'DXT5' : 'DXT1'}  ${kb.toFixed(0)} KB`);
  }

  // Surfaces the design hides. A transparent sheet where one will work; a note
  // in every other case, because "hidden in the editor" and "hidden in the
  // game" were two different things for longer than anybody knew.
  // `targets`, not the design's `paint` keys: a surface term resolves to roles
  // through the profile's bind table, and a role painted that way is painted
  // just as much as one named outright. It is also the list AFTER the
  // unencodable ones were dropped above — a surface the build could not paint
  // is one this may still hide.
  for (const h of hidePlan(profile, livery, { paintedRoles: new Set(targets.map((t) => t.role)) })) {
    if (h.action === 'ship-transparent') {
      const outPath = join(outDir, h.file);
      const png = await transparentPng(CLEAR_SHEET, CLEAR_SHEET);
      if (isPngTexture(h.file)) {
        await writeFile(outPath, png);
      } else {
        const pngPath = join(pngDir ?? outDir, h.file.replace(/\.dds$/i, '.png'));
        await writeFile(pngPath, png);
        await toDDS(pngPath, outPath, { width: CLEAR_SHEET, height: CLEAR_SHEET, alpha: true });
        if (!pngDir) await rm(pngPath);
      }
      written.push(h.file);
      log(`  ${h.file.padEnd(24)} ${CLEAR_SHEET}x${CLEAR_SHEET}`.padEnd(46) + `${isPngTexture(h.file) ? 'PNG ' : 'DXT5'}  transparent (hidden)`);
    } else if (h.action === 'cannot' || h.action === 'painted') {
      notes.push({ term: h.role, status: 'hide-' + h.action, text: h.why });
    } else {
      // `car-hides` and `absent` are the quiet outcomes, and even those get a
      // line: a hide that did nothing should be visibly nothing.
      log(`  ${h.role.padEnd(24)} ${h.action === 'car-hides' ? 'no file; hidden by the car\'s own config (in the game only)' : 'not on this car'}`);
    }
  }

  // A fit naming a region the livery no longer declares is the other half of
  // the drift problem, and just as silent if unreported.
  for (const id of unusedFitIds(fit, fitUsed)) {
    notes.push({
      term: id, status: 'fit-stale',
      text: `fit: "${id}" matches no region in this livery — the design may have been edited`,
    });
  }

  // Say what the design asked for and did not get. This is the failure mode the
  // project keeps rediscovering in a new costume: a texture name that matches
  // nothing overrides nothing, silently, and looks identical to a livery that
  // simply didn't work.
  //
  // Two kinds of note, and lumping them together makes the report a liar. A
  // surface the car does not have was NOT painted; an unconfirmed binding was
  // painted and merely deserves a second look. Counting the second as the first
  // inflates the number and buries the signal that actually matters.
  if (notes.length) {
    const missing = notes.filter(isMissingNote);
    const warnings = notes.filter((n) => !isMissingNote(n));
    log('');
    log(`  ${targets.length} surface(s) painted` +
        (missing.length ? `; ${missing.length} asked for and not painted:` : '.'));
    for (const n of missing) log(`    ! ${n.text}`);
    if (warnings.length) {
      log(`  ${warnings.length} painted, but worth a look:`);
      for (const n of warnings) log(`    ? ${n.text}`);
    }
  }

  await writeMetadata({ outDir, livery, firstPng });
  return { outDir, files: written, firstPng, notes };
}

/**
 * The calibration skin: every texture painted as a labelled coordinate system.
 *
 * Installed alongside the real livery rather than over it, so both show up in
 * Content Manager and you can flip between them without reinstalling anything.
 */
export async function buildCalibration({ profile, outDir, folder, cells = 20, probes = [], font = 'sans-serif', pngDir = null, log = console.log }) {
  if (!Number.isInteger(cells) || cells < 2 || cells > 260) {
    throw new Error(`--cells must be a whole number between 2 and 260, got ${cells}`);
  }
  // Validated BEFORE anything is deleted or rendered: a case collision here used
  // to surface only after wiping the previous output and encoding six textures.
  const probeList = makeProbes(probes);

  await magickBin();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  if (pngDir) await mkdir(pngDir, { recursive: true });

  let firstPng = null;

  // Only textures worth calibrating. A profile generated from a model lists
  // every texture the car references — dozens of them, including 28x28 trim
  // scraps that cannot be DDS-encoded at all and would be unreadable as a grid
  // even if they could.
  const worth = Object.entries(profile.textures).filter(([role, tex]) => {
    if (!isPngTexture(tex.file) && (!isPow2(tex.width) || !isPow2(tex.height))) {
      log(`  - ${tex.file} skipped: ${tex.width}x${tex.height} is not a power of two`);
      return false;
    }
    if (!Object.keys(profile.panels?.[role] ?? {}).length) {
      log(`  - ${tex.file} skipped: no panels mapped, nothing to calibrate`);
      return false;
    }
    return true;
  });

  for (const [role, tex] of worth) {
    const { width, height } = tex;
    const shape = gridShape(width, height, cells);
    const png = await rasterize(uvGridSvg({
      width, height, label: `${role}  ${tex.file.replace(/\.(dds|png)$/i, '')}`, font, cols: cells,
    }));

    const pngPath = join(pngDir ?? outDir, tex.file.replace(/\.(dds|png)$/i, '.png'));
    const outPath = join(outDir, tex.file);
    await writeFile(pngPath, png);
    if (isPngTexture(tex.file)) await toPNG(pngPath, outPath);
    else await toDDS(pngPath, outPath, { width, height, alpha: tex.alpha ?? false });
    if (!pngDir && pngPath !== outPath) await rm(pngPath);

    firstPng ??= png;
    log(`  ${tex.file.padEnd(24)} ${width}x${height}`.padEnd(46) +
      `${shape.cols}x${shape.rows} cells  (${pct(100 / shape.cols)} x ${pct(100 / shape.rows)})`);
  }

  for (const p of probeList) {
    const size = 1024;
    const png = await rasterize(probeSvg({ width: size, height: size, ...p, font }));
    const pngPath = join(pngDir ?? outDir, p.file.replace(/\.dds$/i, '.png'));
    await writeFile(pngPath, png);
    await toDDS(pngPath, join(outDir, p.file), { width: size, height: size, alpha: false });
    if (!pngDir) await rm(pngPath);
    log(`  ${p.file.padEnd(24)} probe ${p.color}`);
  }

  await writeMetadata({
    outDir,
    livery: { name: `${profile.name ?? profile.id} — UV GRID`, identity: { team: 'UV GRID', driver: 'calibration', number: '00' } },
    firstPng,
    previewLabel: 'UV GRID',
  });
  return { outDir, folder };
}

async function writeMetadata({ outDir, livery, firstPng, previewLabel }) {
  const id = livery.identity ?? {};
  await writeFile(
    join(outDir, 'ui_skin.json'),
    JSON.stringify({
      skinname: livery.name,
      drivername: id.driver ?? '',
      team: id.team ?? '',
      number: id.number ?? '',
      country: id.country ?? '',
    }, null, 2)
  );
  if (firstPng) {
    await makeBadge(firstPng, join(outDir, 'livery.png'));
    await makePreview(firstPng, join(outDir, 'preview.jpg'), { label: previewLabel ?? id.number ?? '' });
  }
}

/** ZIP carrying the full content/cars/<id>/skins/<folder>/ path. */
export async function packSkin({ skinDir, zipPath, carId, folder }) {
  return packageZip({ skinDir, zipPath, carId, skinFolder: folder });
}

const pct = (n) => `${Number(n.toFixed(1))}%`;
const isPow2 = (n) => Number.isInteger(Math.log2(n));

function resolveAo(path, liveryDir) {
  if (!path) return null;
  if (isAbsolute(path) || !liveryDir) return path;
  return resolve(liveryDir, path);
}

/**
 * Scale a rendered SVG document by rewriting its width/height while leaving the
 * viewBox alone. Cheaper and sharper than rasterising at 1x and resampling.
 */
function scaleSvg(svg, scale) {
  if (scale === 1) return svg;
  return svg.replace(/^<svg([^>]*)width="(\d+)" height="(\d+)"/, (_, attrs, w, h) =>
    `<svg${attrs}width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"`);
}
