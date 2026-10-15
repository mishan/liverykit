import sharp from 'sharp';
import { decodeDds as decodeDdsHere } from '../ui/dds.js';
import { encodeDds } from './dds.mjs';
import { copyFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export { mipCount } from './dds.mjs';

const isPow2 = (n) => Number.isInteger(Math.log2(n));

/** Rasterize an SVG string. librsvg ignores <filter>, so glow is done below. */
export async function rasterize(svg) {
  return sharp(Buffer.from(svg), { unlimited: true }).png().toBuffer();
}

/**
 * base + blurred(emissive) screened on + crisp emissive over the top.
 * That reproduces a neon look without relying on SVG filter support.
 */
export async function composeLayers({ base, emissive, hasEmissive, glowSigma = 12, aoPath = null, width, height }) {
  let img = sharp(await rasterize(base), { unlimited: true });

  if (hasEmissive) {
    const emis = await rasterize(emissive);
    const glow = await sharp(emis, { unlimited: true }).blur(glowSigma).toBuffer();
    img = sharp(
      await img.composite([
        { input: glow, blend: 'screen' },
        { input: glow, blend: 'screen' },
        { input: emis, blend: 'over' },
      ]).png().toBuffer(),
      { unlimited: true }
    );
  }

  if (aoPath) {
    try {
      await access(aoPath, constants.R_OK);
      const ao = await sharp(aoPath, { unlimited: true })
        .resize(width, height, { fit: 'fill' })
        .removeAlpha()
        .toBuffer();
      img = sharp(await img.composite([{ input: ao, blend: 'multiply' }]).png().toBuffer(), { unlimited: true });
    } catch {
      console.warn(`  ! AO layer not found, skipping: ${aoPath}`);
    }
  }

  return img.png({ compressionLevel: 6 }).toBuffer();
}

/**
 * True when a texture should be written as PNG rather than encoded to DDS.
 *
 * AC binds .png textures directly — the wheel faces on the car this was built
 * against are a 28x28 PNG covering nearly twenty thousand vertices. Those can't
 * become DDS: the name wouldn't match, and 28 isn't a power of two. Forcing
 * every output through the DDS encoder made a visible chunk of the car
 * unpaintable for no reason.
 */
export const isPngTexture = (file) => /\.png$/i.test(file);

/** Copy the rendered PNG through unchanged, since it is already the format. */
export async function toPNG(srcPath, outPath) {
  if (resolve(srcPath) === resolve(outPath)) return;
  await copyFile(srcPath, outPath);
}

/**
 * The reverse of toDDS: the car's own compressed texture, as raw RGBA — for a
 * renderer that has no GPU to hand a DDS to directly, the way the browser
 * does. Decoded by the same module the browser uses, so the two renderers
 * cannot disagree about a texture, and downsized on the way out, since a 2048
 * sheet is far more than a few hundred pixels of car can show.
 *
 * BC7, which a few hundred stock sheets in a 254-car fleet are, the shared
 * decoder does not read. ImageMagick does, and is asked when it happens to be
 * installed; it is never required.
 *
 * `null` when nothing here can make sense of it: one texture no renderer can
 * decode is a part drawn gray, not a build that stops.
 */
export async function decodeDds(buffer, { maxSize = 512 } = {}) {
  const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const img = decodeDdsHere(view);
  if (!img) return viaImageMagick(buffer, maxSize);
  const big = Math.max(img.width, img.height);
  if (big <= maxSize) return { data: Buffer.from(img.pixels), w: img.width, h: img.height };
  const scale = maxSize / big;
  const { data, info } = await sharp(Buffer.from(img.pixels),
    { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)))
    .raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

async function viaImageMagick(buffer, maxSize) {
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-dds-'));
  try {
    await writeFile(join(dir, 'in.dds'), buffer);
    for (const bin of ['magick', 'convert']) {
      try {
        await run(bin, [join(dir, 'in.dds'), '-resize', `${maxSize}x${maxSize}>`, join(dir, 'out.png')]);
      } catch { continue; }
      const { data, info } = await sharp(join(dir, 'out.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function toDDS(pngPath, ddsPath, { width, height, alpha = false }) {
  // Direct3D 9, which AC is, gives a non-power-of-two texture no mip chain on
  // hardware that supports one only conditionally, and a mipless texture
  // shimmers badly at any distance. There is no correct file to write at this
  // size, so it is refused rather than written broken.
  if (!isPow2(width) || !isPow2(height)) {
    throw new Error(
      `Cannot encode ${ddsPath} at ${width}x${height}: DDS dimensions must be powers of two.\n` +
      `  A non-power-of-two DDS cannot be relied on to keep its mip chain in a DX9 game,\n` +
      `  and a mipless texture shimmers badly at distance in-game.\n` +
      `  Use a power-of-two size (512, 1024, 2048, 4096).`
    );
  }
  const { data, info } = await sharp(pngPath, { unlimited: true })
    .resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  await writeFile(ddsPath, encodeDds(data, info.width, info.height, { alpha }));
}

/** Showroom preview placeholder and the 128px car-list badge. */
export async function makeBadge(pngBuffer, outPath) {
  await sharp(pngBuffer, { unlimited: true })
    .resize(128, 128, { fit: 'cover', position: 'attention' })
    .png()
    .toFile(outPath);
}
