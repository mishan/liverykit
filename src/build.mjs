// ---------------------------------------------------------------------------
// Orchestration: car profile + livery -> a folder of DDS files -> a ZIP that
// Content Manager installs without asking questions.
// ---------------------------------------------------------------------------

import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

import { mulberry32, seedFrom } from './engine/rng.mjs';
import { composeLayers, toDDS, toPNG, isPngTexture, makeBadge, rasterize, magickBin } from './engine/pipeline.mjs';
import { packageZip, makePreview } from './engine/package.mjs';
import { uvGridSvg, gridShape, probeSvg, makeProbes } from './engine/uvgrid.mjs';
import { resolveTreatments } from './registry.mjs';
import { renderTexture } from './render.mjs';
import { texture, resolveTargets } from './profile.mjs';
import { applyFit, regionIds, unusedFitIds } from './fit.mjs';

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

  let firstPng = null;
  const written = [];

  for (const { role, spec, primary } of targets) {
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
        spec.regions.filter((r) => !(r.once && !primary)),
        fit, { profile, role, used: fitUsed, notes },
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
