import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const run = promisify(execFile);

let cachedBin = null;
export async function magickBin() {
  if (cachedBin) return cachedBin;
  for (const bin of ['magick', 'convert']) {
    try {
      await run(bin, ['-version']);
      cachedBin = bin;
      return bin;
    } catch { /* try next */ }
  }
  throw new Error('Neither `magick` nor `convert` found — install imagemagick.');
}

/**
 * Mip chain length, driven by the LONGER edge — a 2048x512 texture still needs
 * 12 levels, not the 10 that log2(512)+1 would give.
 *
 * Floored, because a non-power-of-two size otherwise yields a fraction like
 * 12.55, and ImageMagick writes a chain length of 1 when it can't parse the
 * define — no error, exit 0, and a car that shimmers badly at any distance.
 *
 * Floor rather than ceil: 3000px halves to 1px in 12 steps, not 13, and asking
 * for more levels than the image can produce gets rejected the same way. For
 * powers of two the two agree, which is why the bug survived the first fix.
 */
export const mipCount = (w, h = w) => Math.floor(Math.log2(Math.max(w, h))) + 1;

const isPow2 = (n) => Number.isInteger(Math.log2(n));

/** Rasterise an SVG string. librsvg ignores <filter>, so glow is done below. */
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
 * ImageMagick picks DXT1 when there is no alpha channel and DXT5 when there is,
 * regardless of what you ask for — so alpha presence is forced explicitly.
 * Note: dds:mipmaps=0 means NO mipmaps here (unlike texconv's -m 0), so the
 * full chain length is passed in.
 */
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

export async function toDDS(pngPath, ddsPath, { width, height, alpha = false }) {
  const bin = await magickBin();
  // Not a warning: ImageMagick refuses to build a mip chain for a
  // non-power-of-two DDS at all, whatever `dds:mipmaps` asks for. The file
  // encodes fine and ships with a single mip level, which in AC means a car
  // that shimmers badly at any distance. Since there is no way to produce a
  // correct file at this size, refuse rather than emit a broken one.
  if (!isPow2(width) || !isPow2(height)) {
    throw new Error(
      `Cannot encode ${ddsPath} at ${width}x${height}: DDS dimensions must be powers of two.\n` +
      `  ImageMagick will not generate mipmaps for a non-power-of-two DDS, and a\n` +
      `  mipless texture shimmers badly at distance in-game.\n` +
      `  Use a power-of-two size (512, 1024, 2048, 4096).`
    );
  }
  const args = [
    pngPath,
    '-alpha', alpha ? 'on' : 'off',
    '-define', `dds:compression=${alpha ? 'dxt5' : 'dxt1'}`,
    '-define', `dds:mipmaps=${mipCount(width, height)}`,
    ddsPath,
  ];
  await run(bin, args);
}

/** Showroom preview placeholder and the 128px car-list badge. */
export async function makeBadge(pngBuffer, outPath) {
  await sharp(pngBuffer, { unlimited: true })
    .resize(128, 128, { fit: 'cover', position: 'attention' })
    .png()
    .toFile(outPath);
}
