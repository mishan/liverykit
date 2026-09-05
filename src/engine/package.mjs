import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import { makeZip } from './zip.mjs';
import { rasterise } from './shot.mjs';

/**
 * Content Manager will happily install a ZIP whose internal layout mirrors the
 * game's own tree. Anything ambiguous makes CM ask which car it belongs to, so
 * the full content/cars/<id>/skins/<name>/ path is written out.
 */
export async function packageZip({ skinDir, zipPath, carId, skinFolder }) {
  const files = (await readdir(skinDir)).sort();
  const prefix = `content/cars/${carId}/skins/${skinFolder}`;
  const entries = await Promise.all(
    files.map(async (f) => ({ name: `${prefix}/${f}`, data: await readFile(join(skinDir, f)) }))
  );
  await writeFile(zipPath, makeZip(entries));
  return files.length;
}

/**
 * A stand-in preview so the skin isn't a blank tile in the car list — the
 * blurred first texture the livery paints, with a label over it.
 *
 * Used only when there is no car model to render from: the calibration skin,
 * which has no business claiming to show the car, and an ordinary build run
 * without a kn5 on hand. Whenever a model IS available, `makeShowroomPreview`
 * below replaces this with an actual picture of the car — see `buildSkin`.
 */
export async function makePreview(pngBuffer, outPath, {
  label = '', width = PREVIEW_FRAME.width, height = PREVIEW_FRAME.height,
} = {}) {
  // The same frame the real render would have used, so a skin that falls back
  // to the placeholder is not also the odd size in the list.
  const W = width;
  const H = height;
  const bg = await sharp(pngBuffer, { unlimited: true })
    .resize(W, H, { fit: 'cover', position: 'left top' })
    .modulate({ brightness: 0.85 })
    .blur(6)
    .toBuffer();

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#000" opacity="0.35"/>` +
    `<text x="${W / 2}" y="${H / 2 - 6}" fill="#F2F2F7" font-family="sans-serif" ` +
    `font-size="52" font-weight="700" text-anchor="middle" letter-spacing="6">${escapeXml(label)}</text>` +
    `<text x="${W / 2}" y="${H / 2 + 40}" fill="#00F0FF" font-family="sans-serif" ` +
    `font-size="20" text-anchor="middle" letter-spacing="4">PLACEHOLDER PREVIEW</text>` +
    `</svg>`
  );

  await sharp(bg).composite([{ input: overlay }]).jpeg({ quality: PREVIEW_QUALITY }).toFile(outPath);
}


/**
 * A real render of the finished skin on the car, in the same 1022x575 frame
 * Content Manager's own showroom-generated previews use. Returns the encoded
 * JPEG rather than writing it, so the caller decides where it lands.
 *
 * `sheets` is prebuilt — role -> { data, w, h } raw RGBA, already the PNGs
 * this build just composed and encoded to DDS — so this does no rendering of
 * its own artwork, only of the car wearing it. That is `shot.mjs`'s
 * `rasterise`, unchanged: the same rasteriser `render_car` uses, so a preview
 * and an MCP screenshot of the same skin never disagree about what the car
 * looks like.
 */
export async function makeShowroomPreview(model, groups, sheets, {
  view = 'front-left', width = PREVIEW_FRAME.width, height = PREVIEW_FRAME.height,
  samples = 2,
} = {}) {
  const { data, width: w, height: h } = rasterise(model, groups, sheets, { width, height, view, samples });
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .jpeg({ quality: PREVIEW_QUALITY }).toBuffer();
}

/**
 * The frame to fall back to when the car's own skins cannot say.
 *
 * 1022x575 is the most common preview size in a large AC install and the one
 * Kunos shipped with — but only just, and it is not what the modern GT3 field
 * uses. `previewFrame` below asks the car instead, and this is what answers
 * when there is nothing to ask.
 */
export const PREVIEW_FRAME = { width: 1022, height: 575 };

/**
 * JPEG quality for anything this module writes.
 *
 * 90 sounds generous and is not: across 3,789 skin previews in one install the
 * median is 100 and the tenth percentile is 98 — 90 sits at the very bottom of
 * the distribution, below all but a handful of files. A preview is one image of
 * a hundred-odd kilobytes shipped once per skin, so the bytes 98 costs over 90
 * are not worth the artefacts it saves.
 */
export const PREVIEW_QUALITY = 98;

/**
 * The frame the car's OWN skins use, read from one of them.
 *
 * A generated preview sits in Content Manager's list beside the ones the car
 * shipped with, and a different size or aspect ratio there is the first thing
 * that marks it as not belonging. The convention is per car and it has moved:
 * Kunos-era content is 1022x575, and the current GT3 mods are 1555x835, which
 * is not even the same aspect ratio.
 *
 * So the car is asked rather than assumed. Several skins are read and the most
 * common answer wins, because one skin in a pack having been resized by hand
 * should not redefine the car. Returns null when there is nothing to learn
 * from, which is not an error — plenty of cars ship no preview at all.
 */
export async function previewFrame(modelPath, { log = () => {} } = {}) {
  if (!modelPath) return null;
  const skins = join(dirname(modelPath), 'skins');
  try {
    const dirs = (await readdir(skins, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const seen = new Map();
    // A handful, not all of them: this is a vote, and a car with two hundred
    // skins does not need two hundred header reads to settle it.
    for (const d of dirs.slice(0, 8)) {
      for (const name of ['preview.jpg', 'preview.png', 'Preview.jpg']) {
        try {
          // `metadata` reads the header. The pixels are never decoded.
          const { width, height } = await sharp(join(skins, d, name)).metadata();
          if (!width || !height) break;
          const key = `${width}x${height}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          break;
        } catch { /* try the next spelling, then the next skin */ }
      }
    }
    if (!seen.size) return null;
    const [best] = [...seen].sort((a, b) => b[1] - a[1]);
    const [width, height] = best[0].split('x').map(Number);
    log(`  preview frame from the car's own skins: ${width}x${height}`);
    return { width, height };
  } catch {
    return null;
  }
}

const escapeXml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
