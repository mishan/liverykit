import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeZip } from './zip.mjs';

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
 * A stand-in preview so the skin isn't a blank tile in the car list.
 * Replace it with a real showroom screenshot when the livery is on the car —
 * Content Manager can regenerate it in place from the showroom.
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

const escapeXml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
