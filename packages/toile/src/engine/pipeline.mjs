import sharp from 'sharp';
import { decodeDds as decodeDdsHere, encodeDds } from 'ac-dds';
import { copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export { mipCount } from 'ac-dds';

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
 * `null` when the decoder cannot make sense of it: one texture no renderer can
 * decode is a part drawn gray, not a build that stops. In a 254-car fleet that
 * is 21 sheets of 17,254, all BC4 and BC5, which hold normals and gloss rather
 * than color.
 */
export async function decodeDds(buffer, { maxSize = 512 } = {}) {
  const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const img = decodeDdsHere(view);
  if (!img) return null;
  const big = Math.max(img.width, img.height);
  if (big <= maxSize) return { data: Buffer.from(img.pixels), w: img.width, h: img.height };
  const scale = maxSize / big;
  const { data, info } = await sharp(Buffer.from(img.pixels),
    { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)))
    .raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/**
 * A texture out of a kn5, as a PNG at its full size, for a design that paints
 * over it (`background: 'stock'`), or null for a placeholder. A kn5 carries
 * DDS and PNG both.
 */
export async function stockPng(bytes, file) {
  if (isPngTexture(file)) return Buffer.from(bytes);
  const img = await decodeDds(bytes, { maxSize: Infinity });
  if (!img) throw new Error(`${file} is a DDS this decoder cannot read`);
  // A 1x1 is an encrypted kn5's placeholder, and not the car's artwork.
  if (img.w === 1 && img.h === 1) return null;
  return sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
}

/**
 * A stock texture as the two data URIs `renderTexture` paints over: its color,
 * opaque, and its alpha as a gray mask. Apart, because drawing the design over
 * a half-transparent sheet blends the two, and the car's own lettering showed
 * through a banner painted over it.
 */
export async function stockHrefs(png) {
  const uri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  return {
    color: uri(await sharp(png).removeAlpha().png().toBuffer()),
    alpha: uri(await sharp(png).ensureAlpha().extractChannel(3).png().toBuffer()),
  };
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
