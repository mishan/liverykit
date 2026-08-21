// ---------------------------------------------------------------------------
// Core treatment pack — the primitives every livery needs, with no house style.
//
// Nothing in here implies an aesthetic. Fills, stripes, text, halftones and
// piping are the vocabulary you would want whether you were painting a
// synthwave car or a 1970s Martini stripe. Anything opinionated belongs in its
// own pack.
// ---------------------------------------------------------------------------

import { definePack } from '../registry.mjs';
import { halftoneDissolve, scanlines, piping, ring } from '../motifs.mjs';
import { r2 } from '../engine/rng.mjs';

export const rect = (r, color) =>
  `<rect x="${r2(r.x)}" y="${r2(r.y)}" width="${r2(r.w)}" height="${r2(r.h)}" fill="${color}"/>`;

/**
 * Escape for a TEXT NODE, which is a different job from escaping an attribute.
 *
 * `renderTexture` hands treatments every other value already safe to drop into
 * an attribute. `text` is the exception, and stays raw, because it is the only
 * option that is CONTENT rather than a parameter: it goes between the tags
 * rather than inside them, and `radialText` renders it one character at a time
 * around a circle. Pre-escaping it would spell `&quot;` out in five glyphs on
 * the side of the car.
 *
 * So the emitter escapes it, here and in `motifs.mjs`. `test/injection.test.mjs`
 * pushes markup through this field too, so a treatment that ever puts `text`
 * into an attribute instead is caught there rather than trusted not to.
 */
export const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));

const treatments = {
  fill: (r, c) => ({ base: rect(r, c.color(c.opts.color ?? 'pink')), emissive: '' }),

  /**
   * A stripe is just a fill you meant to be thin. Separate treatment because
   * `glow: true` is overwhelmingly what you want on one and not the other.
   */
  stripe: (r, c) => {
    const fillRect = rect(r, c.color(c.opts.color ?? 'cyan'));
    return c.opts.glow ? { base: fillRect, emissive: fillRect } : { base: fillRect, emissive: '' };
  },

  scanlines: (r, c) => ({
    base: scanlines({
      ...r,
      pitch: c.opts.pitch ?? Math.round(r.h / 90),
      color: c.color(c.opts.color ?? '#000'),
      opacity: c.opts.opacity ?? 0.1,
    }),
    emissive: '',
  }),

  halftone: (r, c) => {
    const cell = c.opts.cell ?? Math.round(r.h / 22);
    return {
      base: halftoneDissolve({
        ...r,
        cell,
        angle: c.opts.angle ?? 0,
        color: c.color(c.opts.color ?? 'black'),
        // `dot` is the largest dot radius as a fraction of the cell pitch. The
        // default 0.42 packs dots nearly touching (~64% coverage), which is
        // what a dissolve edge wants but reads as near-solid for an even field.
        // Drop to ~0.18 for texture rather than colour.
        maxR: cell * (c.opts.dot ?? 0.42),
        start: c.opts.start ?? 0.05,
        end: c.opts.end ?? 0.85,
      }),
      emissive: '',
    };
  },

  piping: (r, c) => {
    const g = piping(c.rng, {
      ...r,
      count: c.opts.count ?? 4,
      color: c.color(c.opts.color ?? 'cyan'),
      width: c.opts.width ?? Math.max(2, r.h * 0.012),
      angle: c.opts.angle ?? 0,
      spacing: c.opts.spacing ? c.opts.spacing * r.h : null,
    });
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  ring: (r, c) => {
    const g = ring({
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
      radius: (c.opts.radius ?? 0.4) * Math.min(r.w, r.h),
      width: (c.opts.width ?? 0.03) * Math.min(r.w, r.h),
      color: c.color(c.opts.color ?? 'cyan'),
      opacity: c.opts.opacity ?? 1,
      dash: c.opts.dash ?? null,
    });
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  /**
   * Text, with two corrections that are easy to get wrong by hand.
   *
   * 1. librsvg does no reflow and no auto-shrink, so the advance width is
   *    estimated (~0.62em per glyph for bold sans, plus tracking) and the size
   *    scaled down until it fits.
   *
   * 2. UV is anisotropic. A panel rarely maps texture pixels to the car at the
   *    same scale in both axes — a flank packs the whole length of the car into
   *    fewer pixels per metre than it gives the car's height, so anything
   *    square in the texture comes out wide on the bodywork. If the car profile
   *    declares an `anisotropy` for this panel, glyphs are pre-narrowed by its
   *    reciprocal so they land looking normal. `aspect` overrides it manually.
   */
  text: (r, c) => {
    const s = c.opts.text ?? '';
    const tracking = c.opts.tracking ?? 0.08;
    const ax = c.opts.aspect ?? (r.anisotropy ? 1 / r.anisotropy : 1);
    let size = r.h * (c.opts.scale ?? 0.7);

    if (c.opts.fit !== false && s.length) {
      const est = s.length * size * (0.62 + tracking) * ax;
      if (est > r.w) size *= r.w / est;
    }

    const anchor = c.opts.anchor ?? 'middle';
    const tx = anchor === 'start' ? r.x : anchor === 'end' ? r.x + r.w : r.x + r.w / 2;
    const inner = `<text x="0" y="0" fill="${c.color(c.opts.color ?? 'white')}" ` +
      `font-family="${c.font}" font-size="${r2(size)}" font-weight="${c.opts.weight ?? 700}" ` +
      `letter-spacing="${r2(size * tracking)}" text-anchor="${anchor}">${esc(s)}</text>`;
    const g = `<g transform="translate(${r2(tx)},${r2(r.y + r.h * 0.78)}) scale(${r2(ax)},1)">${inner}</g>`;

    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },
};

/**
 * What each treatment takes. See `definePack` — this is metadata for tools, the
 * build never reads it, and `hint` is the code's own default written out for a
 * person rather than repeated as a value that could drift from it.
 */
export default definePack('core', treatments, {
  fill: {
    label: 'Fill',
    summary: 'A flat rectangle of one colour.',
    options: {
      color: { type: 'color', hint: 'pink' },
    },
  },

  stripe: {
    label: 'Stripe',
    summary: 'A fill you meant to be thin. Separate so that glow can default the other way.',
    options: {
      color: { type: 'color', hint: 'cyan' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },

  scanlines: {
    label: 'Scanlines',
    summary: 'Horizontal rules across the region, CRT-fashion.',
    options: {
      color: { type: 'color', hint: '#000' },
      pitch: { type: 'number', min: 1, step: 1, hint: 'the region height over 90', label: 'Pitch (px)' },
      opacity: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.1' },
    },
  },

  halftone: {
    label: 'Halftone dissolve',
    summary: 'A field of dots that thins out across the region, for a soft edge.',
    options: {
      color: { type: 'color', hint: 'black' },
      cell: { type: 'number', min: 2, step: 1, hint: 'the region height over 22', label: 'Cell (px)' },
      angle: { type: 'number', min: 0, max: 360, step: 15, hint: '0' },
      // Worth spelling out: at the default the dots nearly touch, which is what
      // a dissolve edge wants and reads as near-solid for an even field.
      dot: { type: 'number', min: 0.05, max: 0.5, step: 0.01, hint: '0.42 — try 0.18 for texture rather than colour', label: 'Dot size' },
      start: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.05', label: 'Dissolve from' },
      end: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.85', label: 'Dissolve to' },
    },
  },

  piping: {
    label: 'Piping',
    summary: 'Parallel lines running across the region.',
    options: {
      color: { type: 'color', hint: 'cyan' },
      count: { type: 'number', min: 1, step: 1, hint: '4' },
      width: { type: 'number', min: 0.5, step: 0.5, hint: '1.2% of the region height, at least 2px', label: 'Line width (px)' },
      spacing: { type: 'number', min: 0, max: 1, step: 0.01, hint: 'evenly spread across the region' },
      angle: { type: 'number', min: 0, max: 360, step: 15, hint: '0' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },

  ring: {
    label: 'Ring',
    summary: 'A circle centred in the region. Radius and width are fractions of its shorter side.',
    options: {
      color: { type: 'color', hint: 'cyan' },
      radius: { type: 'number', min: 0, max: 0.5, step: 0.01, hint: '0.4' },
      width: { type: 'number', min: 0.001, max: 0.5, step: 0.005, hint: '0.03' },
      opacity: { type: 'number', min: 0, max: 1, step: 0.05, hint: '1' },
      dash: { type: 'string', hint: 'solid', label: 'Dash pattern' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },

  text: {
    label: 'Text',
    summary: 'A line of text, scaled to fit and pre-narrowed for the panel\'s anisotropy.',
    options: {
      text: { type: 'string', hint: 'empty', label: 'Text' },
      color: { type: 'color', hint: 'white' },
      scale: { type: 'number', min: 0.05, max: 2, step: 0.05, hint: '0.7 of the region height' },
      tracking: { type: 'number', min: -0.1, max: 1, step: 0.01, hint: '0.08', label: 'Letter spacing' },
      weight: { type: 'number', min: 100, max: 900, step: 100, hint: '700' },
      anchor: { type: 'enum', values: ['start', 'middle', 'end'], hint: 'middle' },
      fit: { type: 'boolean', hint: 'true — shrink to fit the region' },
      aspect: { type: 'number', min: 0.2, max: 3, step: 0.05, hint: "the panel's own anisotropy" },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },
});
