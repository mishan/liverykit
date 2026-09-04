import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
export async function makePreview(pngBuffer, outPath, { label = '' } = {}) {
  const W = 1022;
  const H = 575;
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

  await sharp(bg).composite([{ input: overlay }]).jpeg({ quality: 88 }).toFile(outPath);
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
  view = 'front-left', width = 1022, height = 575,
} = {}) {
  const { data, width: w, height: h } = rasterise(model, groups, sheets, { width, height, view });
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 90 }).toBuffer();
}

const escapeXml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
