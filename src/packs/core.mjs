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

export const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));

export default definePack('core', {
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
});
