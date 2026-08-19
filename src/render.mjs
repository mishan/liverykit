// ---------------------------------------------------------------------------
// Region list + car profile -> two SVG layers.
//
// Everything a livery declares for one texture is walked in order, each region
// resolved from panel-relative to absolute coordinates against the car profile,
// then handed to its treatment. Treatments return { base, emissive }; the two
// accumulate into separate documents because glow has to happen at raster time.
// (librsvg ignores SVG <filter> entirely — feGaussianBlur renders as nothing —
// so the emissive layer is rendered on its own, blurred, and screened back on.)
// ---------------------------------------------------------------------------

import { resolveRect, texture } from './profile.mjs';
import { r2 } from './engine/rng.mjs';

/**
 * Resolve a colour reference. Palette keys win over raw values, so a livery can
 * say `color: 'accent'` and stay renamable, while `color: '#FF00E5'` still works
 * for one-offs.
 */
export function makeColorResolver(palette) {
  return (nameOrValue) => {
    if (typeof nameOrValue !== 'string') return String(nameOrValue);
    return palette[nameOrValue] ?? nameOrValue;
  };
}

export function renderTexture({ profile, role, regions, background, treatments, palette, rng, font, tokens }) {
  const tex = texture(profile, role);
  const { width, height } = tex;

  const color = makeColorResolver(palette);
  const base = [`<rect width="${width}" height="${height}" fill="${color(background ?? 'black')}"/>`];
  const emissive = [];

  for (const region of regions ?? []) {
    const entry = treatments.get(region.treatment);
    if (!entry) {
      throw new Error(
        `Unknown treatment "${region.treatment}" on ${tex.file}.\n` +
        `  Available: ${[...treatments.keys()].sort().join(', ')}\n` +
        `  If it comes from a pack, add that pack to the livery's "packs" list.`
      );
    }

    const frac = resolveRect(profile, role, region);
    const r = {
      x: frac.x * width,
      y: frac.y * height,
      w: frac.w * width,
      h: frac.h * height,
      // Carried through so `text` can pre-compensate for stretched UV without
      // the livery author having to know about it.
      anisotropy: frac.anisotropy,
    };

    const opts = { ...region };
    if (typeof opts.text === 'string') {
      opts.text = opts.text.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
    }

    // `rotate` turns a treatment through a quarter turn (or any angle) about the
    // region's centre. Needed because motifs have a built-in grain — traces run
    // in horizontal lanes, piping in horizontal lines — and a panel's grain is
    // whatever the unwrapper chose. Seatbelt straps, for instance, run DOWN the
    // texture, so horizontal lanes cross them like rungs instead of following
    // them.
    //
    // The rect the author writes is the FINAL one. For a quarter turn the
    // treatment is handed that rect with its width and height swapped about the
    // same centre, so rotating the result lands exactly where they asked.
    const rot = (((region.rotate ?? 0) % 360) + 360) % 360;
    const quarter = rot === 90 || rot === 270;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const drawn = quarter
      ? { ...r, x: cx - r.h / 2, y: cy - r.w / 2, w: r.h, h: r.w }
      : r;

    const out = entry.fn(drawn, { palette, color, rng, font, opts, width, height, tokens });
    const spin = (svg) => (rot === 0 || !svg ? svg
      : `<g transform="rotate(${r2(rot)},${r2(cx)},${r2(cy)})">${svg}</g>`);
    if (out.base) base.push(spin(out.base));
    if (out.emissive) emissive.push(spin(out.emissive));
  }

  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` + body + '</svg>';

  return {
    base: doc(base.join('')),
    // The emissive layer sits on transparency so it can be blurred into a glow.
    emissive: doc(emissive.join('')),
    hasEmissive: emissive.length > 0,
    width,
    height,
    file: tex.file,
    alpha: tex.alpha ?? false,
  };
}
