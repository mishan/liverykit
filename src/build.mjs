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
import { texture } from './profile.mjs';

const DEFAULTS = { seed: 'default', glowSigma: 14, font: 'sans-serif' };

/**
 * Render every painted texture in a livery.
 *
 * `scale` multiplies each texture's native size, so one livery renders at 2K or
 * 4K without edits — every coordinate in the system is a fraction, never a
 * pixel.
 */
export async function buildSkin({ profile, livery, outDir, scale = 1, seed, flat = false, pngDir = null, liveryDir = null, log = console.log }) {
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

  const roles = Object.keys(livery.paint ?? {});
  if (!roles.length) throw new Error(`Livery "${livery.name}" paints no textures.`);

  let firstPng = null;
  const written = [];

  for (const role of roles) {
    const tex = texture(profile, role);
    const spec = livery.paint[role];
    const width = Math.round(tex.width * scale);
    const height = Math.round(tex.height * scale);

    const layers = renderTexture({
      profile,
      role,
      // --flat proves the plumbing before any art exists: if the car doesn't
      // turn a solid colour, the DDS format or a filename is wrong and no
      // amount of artwork will fix it.
      regions: flat ? [] : spec.regions,
      background: spec.background,
      treatments,
      palette: livery.palette ?? {},
      rng: mulberry32(seedFrom(seedStr + tex.file)),
      font: render.font,
      tokens,
    });

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

  await writeMetadata({ outDir, livery, firstPng });
  return { outDir, files: written, firstPng };
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
      width, height, label: `${role}  ${tex.file.replace(/\.dds$/i, '')}`, font, cols: cells,
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
