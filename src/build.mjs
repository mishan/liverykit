// ---------------------------------------------------------------------------
// Orchestration: profile + livery -> rendered surfaces -> an output, which for
// Assetto Corsa is a folder of DDS files and a ZIP Content Manager installs
// without asking questions (src/engine/skin.mjs).
// ---------------------------------------------------------------------------

import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import sharp from 'sharp';

import { mulberry32, seedFrom } from './engine/rng.mjs';
import { composeLayers, rasterize, stockPng, stockHrefs } from './engine/pipeline.mjs';
import { uvGridSvg, gridShape, probeSvg, makeProbes } from './engine/uvgrid.mjs';
import { resolveTreatments } from './registry.mjs';
import { renderTexture } from './render.mjs';
import { texture, resolveTargets } from './profile.mjs';
import { allRegionKeys, applyFit, regionIds, unusedFitIds } from './fit.mjs';
import { hidePlan } from './hide.mjs';
import { loadModel } from './model.mjs';
import { pngOutput } from './output.mjs';

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
//
// A tiled material splits the same way. `tiled` says the surface was painted
// and only its placed artwork was not; `unplaceable` is that artwork, one note
// per region, and it was not painted.
const MISSING = new Set(['absent', 'unbound', 'no-match', 'unplaceable']);

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
export async function buildSkin({ profile, livery, outDir, scale = 1, seed, flat = false, fit = null, pngDir = null, liveryDir = null, decals = new Map(), modelPath = null, output = pngOutput, log = console.log }) {
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

  const targets = requested;
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
  // Every painted role's finished art, kept for the showroom preview below —
  // the same pixels that just got written to the DDS, not a re-render.
  const pngByRole = new Map();

  // The car's own textures, read from the model once and only if some
  // surface paints over one (`background: 'stock'`).
  let modelTextures = null;
  const stockFor = async (file) => {
    if (!modelPath) return null;
    modelTextures ??= loadModel(modelPath, { keepTextureData: true })
      .then((m) => new Map((m.textures ?? []).map((t) => [t.name.toLowerCase(), t.data])))
      .catch((e) => { log(`  ! could not read ${modelPath} for its stock textures: ${e.message}`); return new Map(); });
    const bytes = (await modelTextures).get(file.toLowerCase());
    return bytes ? stockPng(bytes, file).catch((e) => { log(`  ! ${e.message}`); return null; }) : null;
  };

  for (const { from, role, spec, primary } of targets) {
    const tex = texture(profile, role);
    const stock = spec.background === 'stock' ? await stockFor(tex.file) : null;
    // Regions that matched no panel are collected here and reported with
    // everything else at the end, rather than one line at a time mid-build.
    const regionNotes = [];
    const width = Math.round(tex.width * scale);
    const height = Math.round(tex.height * scale);

    const layers = renderTexture({
      profile,
      role,
      // --flat proves the plumbing before any art exists: if the car doesn't
      // turn a solid color, the DDS format or a filename is wrong and no
      // amount of artwork will fix it.
      // Fit first, so an override that names a panel replaces the tag selection
      // before anything is expanded. `applyFit` also leaves off this texture a
      // region that is not drawn on it (`role`, `once`: see `drawnOn`), after
      // stamping its key, so the keys after it do not move.
      regions: flat ? [] : applyFit(
        spec.regions ?? [],
        // `surfaceKey` is not optional here, whatever the default says. A region
        // the design gave no id is addressed by POSITION, and the key is made
        // from the surface it sits on: the editor writes `body#0`, so a build
        // that computed `#0` matched none of them. The editor's own output then
        // adjusted nothing, and said so only as a stale-id note at the end.
        //
        // `reserved` is every key the livery declares anywhere, so a copy cannot
        // take a name belonging to a region on another surface.
        fit, { profile, role, surfaceKey: from, used: fitUsed, notes, reserved, primary },
      ).regions,
      background: spec.background,
      treatments,
      palette: livery.palette ?? {},
      rng: mulberry32(seedFrom(seedStr + tex.file)),
      font: render.font,
      tokens,
      // The livery's own images, for any region that places one. Empty for a
      // design that is a single file: only a livery folder has a decals/
      // directory to carry them in.
      decals,
      regionNotes,
      stock: stock && await stockHrefs(stock),
    });
    notes.push(...regionNotes);

    let png = await composeLayers({
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

    // The glow composites over the masked base, so the alpha is the car's
    // again afterwards, exactly.
    if (stock) {
      const alpha = await sharp(stock).resize(width, height, { fit: 'fill' }).ensureAlpha().extractChannel(3).toBuffer();
      png = await sharp(png).removeAlpha().joinChannel(alpha).png().toBuffer();
    }

    const out = await output.writeSurface({ png, tex, width, height, outDir, pngDir: pngDir ?? outDir, keep: !!pngDir });

    firstPng ??= png;
    pngByRole.set(role, png);
    written.push(out.file);
    log(`  ${out.file.padEnd(24)} ${out.width}x${out.height}`.padEnd(46) +
      `${out.format.padEnd(4)}  ${(out.bytes / 1024).toFixed(0)} KB` +
      (out.width === width && out.height === height ? '' : `  (drawn at ${width}x${height})`));
  }

  // Lights the design adds, which only an output that can carry them writes.
  if (livery.underglow || livery.lights?.length) {
    if (!output.writeLights) {
      notes.push({ term: 'lights', status: 'light', text: 'lights: this output cannot carry the design\'s lights, so none were written' });
    } else {
      const file = await output.writeLights({ livery, modelPath, outDir, notes, log });
      if (file) written.push(file);
    }
  }

  // Surfaces the design hides. A transparent sheet where one will work; a note
  // in every other case, because "hidden in the editor" and "hidden in the
  // game" were two different things for longer than anybody knew.
  // `targets`, not the design's `paint` keys: a surface term resolves to roles
  // through the profile's bind table, and a role painted that way is painted
  // just as much as one named outright.
  for (const h of hidePlan(profile, livery, { paintedRoles: new Set(targets.map((t) => t.role)) })) {
    if (h.action === 'ship-transparent' && !output.hideSurface) {
      notes.push({ term: h.role, status: 'hide-cannot', text: `${h.role}: this output has no way to hide a surface, so ${h.file} is drawn as it is` });
    } else if (h.action === 'ship-transparent') {
      const out = await output.hideSurface({ file: h.file, outDir, pngDir });
      written.push(out.file);
      log(`  ${out.file.padEnd(24)} ${out.width}x${out.height}`.padEnd(46) + `${out.format.padEnd(4)}  transparent (hidden)`);
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
    // An `optional` region that found nothing is not news: its design said, in
    // the file, that it may miss. The portability report still lists it.
    const warnings = notes.filter((n) => !isMissingNote(n) && n.status !== 'optional');
    log('');
    log(`  ${targets.length} surface(s) painted` +
        (missing.length ? `; ${missing.length} asked for and not painted:` : '.'));
    for (const n of missing) log(`    ! ${n.text}`);
    if (warnings.length) {
      log(`  ${warnings.length} painted, but worth a look:`);
      for (const n of warnings) log(`    ? ${n.text}`);
    }
  }

  await output.finish?.({ outDir, livery, firstPng, profile, targets, pngByRole, modelPath, log });
  return { outDir, files: written, firstPng, notes };
}

/**
 * The calibration skin: every texture painted as a labelled coordinate system.
 *
 * Installed alongside the real livery rather than over it, so both show up in
 * Content Manager and you can flip between them without reinstalling anything.
 */
export async function buildCalibration({ profile, outDir, folder, cells = 20, probes = [], font = 'sans-serif', pngDir = null, output = pngOutput, log = console.log }) {
  if (!Number.isInteger(cells) || cells < 2 || cells > 260) {
    throw new Error(`--cells must be a whole number between 2 and 260, got ${cells}`);
  }
  // Validated BEFORE anything is deleted or rendered: a case collision here used
  // to surface only after wiping the previous output and encoding six textures.
  const probeList = makeProbes(probes);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  if (pngDir) await mkdir(pngDir, { recursive: true });

  let firstPng = null;

  // Only textures worth calibrating: a profile generated from a model lists
  // every texture the car references, and one with no panels has nothing a
  // grid could help place.
  const worth = Object.entries(profile.textures).filter(([role, tex]) => {
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

    const out = await output.writeSurface({ png, tex, width, height, outDir, pngDir: pngDir ?? outDir });

    firstPng ??= png;
    log(`  ${out.file.padEnd(24)} ${out.width}x${out.height}`.padEnd(46) +
      `${shape.cols}x${shape.rows} cells  (${pct(100 / shape.cols)} x ${pct(100 / shape.rows)})`);
  }

  for (const p of probeList) {
    const size = 1024;
    const png = await rasterize(probeSvg({ width: size, height: size, ...p, font }));
    const out = await output.writeSurface({ png, tex: { file: p.file, alpha: false }, width: size, height: size,
      outDir, pngDir: pngDir ?? outDir, keep: !!pngDir });
    log(`  ${out.file.padEnd(24)} probe ${p.color}`);
  }

  await output.finish?.({
    outDir,
    livery: { name: `${profile.name ?? profile.id} — UV GRID`, identity: { team: 'UV GRID', driver: 'calibration', number: '00' } },
    firstPng,
    previewLabel: 'UV GRID',
    log,
  });
  return { outDir, folder };
}

const pct = (n) => `${Number(n.toFixed(1))}%`;

function resolveAo(path, liveryDir) {
  if (!path) return null;
  if (isAbsolute(path) || !liveryDir) return path;
  return resolve(liveryDir, path);
}

/**
 * Scale a rendered SVG document by rewriting its width/height while leaving the
 * viewBox alone. Cheaper and sharper than rasterizing at 1x and resampling.
 */
function scaleSvg(svg, scale) {
  if (scale === 1) return svg;
  return svg.replace(/^<svg([^>]*)width="(\d+)" height="(\d+)"/, (_, attrs, w, h) =>
    `<svg${attrs}width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"`);
}
