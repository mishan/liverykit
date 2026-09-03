// ---------------------------------------------------------------------------
// Synthwave treatment pack — opinionated, optional.
//
// Circuit-board traces, perspective horizon grids, glitch bands and four-point
// sparkles. This is a specific look, which is exactly why it is a pack rather
// than part of the core: a livery that doesn't want it never loads it, and
// nobody has to route around an aesthetic they didn't choose.
//
// Treat this file as the worked example for writing your own pack. Every
// treatment here is an ordinary function of (rect, ctx) returning SVG strings.
// ---------------------------------------------------------------------------

import { definePack } from '../registry.mjs';
import { traceRouter, horizonGrid, glitchBands, sparkleField, radialText } from '../motifs.mjs';
import { r2 } from '../engine/rng.mjs';

const treatments = {
  /** PCB-style routing: horizontal runs, 45-degree turns, vias at the corners. */
  traces: (r, c) => {
    const { traces, vias } = traceRouter(c.rng, {
      w: r.w, h: r.h,
      lanes: c.opts.lanes ?? 9,
      turnChance: c.opts.turnChance ?? 0.65,
    });
    const sw = c.opts.width ?? Math.max(2, r.h * 0.011);
    const color = c.color(c.opts.color ?? 'cyan');
    const g = `<g transform="translate(${r2(r.x)},${r2(r.y)})">` +
      `<g fill="none" stroke="${color}" stroke-width="${r2(sw)}" stroke-linecap="round" stroke-linejoin="round">${traces}</g>` +
      `<g fill="${color}">${vias}</g></g>`;
    return { base: '', emissive: g };
  },

  /** Perspective grid converging on a vanishing point. */
  grid: (r, c) => {
    const g = horizonGrid({
      ...r,
      horizonY: r.h * (c.opts.horizon ?? 0.4),
      vpX: r.w * (c.opts.vp ?? 0.5),
      cols: c.opts.cols ?? 14,
      rows: c.opts.rows ?? 9,
      color: c.color(c.opts.color ?? 'pink'),
      width: c.opts.width ?? Math.max(1.5, r.h * 0.004),
    });
    return c.opts.emissive ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  glitch: (r, c) => ({
    base: glitchBands(c.rng, {
      ...r,
      count: c.opts.count ?? 7,
      colors: (c.opts.colors ?? ['violet', 'cyan', 'white']).map((x) => c.color(x)),
    }),
    emissive: '',
  }),

  /**
   * Four-point sparkles, placed by rejection sampling.
   *
   * `avoid` rects are fractions of the WHOLE TEXTURE, not of the region — they
   * commonly need to exclude something drawn by a different region entirely.
   *
   * They matter because the emissive layer always composites *above* the base,
   * so without them sparkles land on top of the driver name. Rejection sampling
   * rather than hand-nudged coordinates is what keeps `--seed` safe to re-roll.
   *
   * The renderer also hands over `lettering`: every text rectangle on the
   * sheet, in the same units. Those are avoided as well, always — `avoid` is
   * for things the renderer cannot know about, not a way to opt back in to
   * sparkling over a name.
   */
  sparkles: (r, c) => ({
    base: '',
    emissive: sparkleField(c.rng, {
      ...r,
      n: c.opts.n ?? 12,
      minR: c.opts.minR ?? r.h * 0.015,
      maxR: c.opts.maxR ?? r.h * 0.07,
      color: c.color(c.opts.color ?? 'white'),
      avoid: [...(c.opts.avoid ?? []), ...(c.lettering ?? [])].map((a) => ({
        x: a.x * c.width, y: a.y * c.height, w: a.w * c.width, h: a.h * c.height,
      })),
    }),
  }),

  /**
   * Text around an arc — for tyre sidewalls, which are commonly unwrapped as an
   * annulus, and for helmet bands. Uses per-character transforms rather than
   * <textPath>, whose librsvg support is inconsistent.
   */
  radialText: (r, c) => {
    const m = Math.min(r.w, r.h);
    const g = radialText({
      text: c.opts.text ?? '',
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
      radius: (c.opts.radius ?? 0.4) * m,
      startAngle: c.opts.startAngle ?? -90,
      size: (c.opts.scale ?? 0.06) * m,
      tracking: c.opts.tracking ?? 0.75,
      color: c.color(c.opts.color ?? 'white'),
      font: c.font,
      weight: c.opts.weight ?? 700,
      flip: c.opts.flip ?? false,
    });
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },
};

/** See `definePack`: tool metadata, never read by the build, defaults as hints. */
export default definePack('synthwave', treatments, {
  traces: {
    label: 'Circuit traces',
    summary: 'PCB-style routing with 45-degree turns and vias. Always emissive.',
    options: {
      color: { type: 'color', hint: 'cyan' },
      lanes: { type: 'number', min: 1, step: 1, hint: '9' },
      turnChance: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.65', label: 'Turn chance' },
      width: { type: 'number', min: 0.5, step: 0.5, hint: '1.1% of the region height, at least 2px', label: 'Stroke (px)' },
    },
  },

  grid: {
    label: 'Horizon grid',
    summary: 'A perspective grid converging on a vanishing point.',
    options: {
      color: { type: 'color', hint: 'pink' },
      horizon: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.4 down the region' },
      vp: { type: 'number', min: 0, max: 1, step: 0.05, hint: '0.5 across', label: 'Vanishing point' },
      cols: { type: 'number', min: 1, step: 1, hint: '14' },
      rows: { type: 'number', min: 1, step: 1, hint: '9' },
      width: { type: 'number', min: 0.5, step: 0.5, hint: '0.4% of the region height, at least 1.5px', label: 'Stroke (px)' },
      emissive: { type: 'boolean', hint: 'false — draw it in the base layer' },
    },
  },

  glitch: {
    label: 'Glitch bands',
    summary: 'Horizontal displaced bands in a few colours.',
    options: {
      count: { type: 'number', min: 1, step: 1, hint: '7' },
      colors: { type: 'colors', hint: 'violet, cyan, white' },
    },
  },

  sparkles: {
    label: 'Sparkles',
    summary: 'Four-point sparkles placed by rejection sampling. Always emissive.',
    options: {
      color: { type: 'color', hint: 'white' },
      n: { type: 'number', min: 1, step: 1, hint: '12', label: 'Count' },
      minR: { type: 'number', min: 0, step: 0.5, hint: '1.5% of the region height', label: 'Smallest (px)' },
      maxR: { type: 'number', min: 0, step: 0.5, hint: '7% of the region height', label: 'Largest (px)' },
      // The emissive layer always composites above the base, so without this
      // sparkles land on top of lettering drawn by an entirely different region.
      // Hence fractions of the WHOLE TEXTURE rather than of this region.
      avoid: { type: 'rects', hint: 'nothing', label: 'Keep clear of', of: 'texture' },
    },
  },

  radialText: {
    label: 'Radial text',
    summary: 'Text around an arc, for tyre sidewalls and helmet bands.',
    options: {
      text: { type: 'string', hint: 'empty', label: 'Text' },
      color: { type: 'color', hint: 'white' },
      radius: { type: 'number', min: 0, max: 0.5, step: 0.01, hint: '0.4 of the shorter side' },
      startAngle: { type: 'number', min: -360, max: 360, step: 15, hint: '-90, which is the top' },
      scale: { type: 'number', min: 0.01, max: 0.5, step: 0.01, hint: '0.06 of the shorter side' },
      tracking: { type: 'number', min: 0, max: 3, step: 0.05, hint: '0.75', label: 'Letter spacing' },
      weight: { type: 'number', min: 100, max: 900, step: 100, hint: '700' },
      flip: { type: 'boolean', hint: 'false — set for text on the lower half of an arc' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },
});
