// ---------------------------------------------------------------------------
// Classic treatment pack — the shapes racing liveries have been made of since
// before anybody drew one on a computer: chevrons, checkers, twin stripes, the
// hockey stick that runs along a flank and turns up at the back, and a row of
// sponsor blocks. Opinionated in the way synthwave is, so a pack of its own.
//
// Every shape is drawn in the region's own frame, so with `rotate: 'auto'` its
// x runs along the car on any panel, and anything meant to be square on the
// car is made square with the panel's `anisotropy`, as `text` makes letters.
// ---------------------------------------------------------------------------

import { definePack } from '../registry.mjs';
import { rect, esc } from './core.mjs';
import { r2 } from '../engine/rng.mjs';

const poly = (pts, color) => `<polygon points="${pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ')}" fill="${color}"/>`;

const treatments = {
  /**
   * `count` chevrons across the region, pointing `point`. Their arms meet the
   * region's top and bottom edges, so `depth` — how far the tip stands ahead
   * of the arms, as a fraction of the height — sets how sharp they are, and
   * `width` is each one's thickness as a fraction of the spacing.
   */
  chevrons: (r, c) => {
    const n = Math.max(1, Math.round(c.opts.count ?? 3));
    const w = c.opts.width ?? 0.5;
    const d = (c.opts.depth ?? 0.5) * r.h;
    const pitch = (r.w - d) / (n - 1 + w);
    if (!(pitch > 0)) {
      c.note(`is too narrow for chevrons ${r2(c.opts.depth ?? 0.5)} of its height deep, so none were drawn`, 'too-narrow');
      return { base: '', emissive: '' };
    }
    const t = w * pitch, ym = r.y + r.h / 2, y1 = r.y + r.h;
    const left = c.opts.point === 'left';
    const x = (v) => (left ? 2 * r.x + r.w - v : v);
    const color = c.color(c.opts.color ?? 'white');
    let g = '';
    for (let k = 0; k < n; k++) {
      const bx = r.x + k * pitch;
      g += poly([[bx, r.y], [bx + t, r.y], [bx + t + d, ym], [bx + t, y1], [bx, y1], [bx + d, ym]]
        .map(([px, py]) => [x(px), py]), color);
    }
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  /**
   * A chequered field, `rows` squares high, square on the car rather than in
   * the texture. The squares not in `color` are left as they are, or painted
   * `color2`.
   */
  checkers: (r, c) => {
    const rows = Math.max(1, Math.round(c.opts.rows ?? 2));
    const ch = r.h / rows;
    const cw = ch / (r.anisotropy || 1);
    const cols = Math.ceil(r.w / cw - 1e-9);
    const one = c.color(c.opts.color ?? 'black');
    const two = c.opts.color2 !== undefined ? c.color(c.opts.color2) : null;
    let g = '';
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const fill = (i + j) % 2 === 0 ? one : two;
        if (!fill) continue;
        const x = r.x + i * cw;
        g += rect({ x, y: r.y + j * ch, w: Math.min(cw, r.x + r.w - x), h: ch }, fill);
      }
    }
    return { base: g, emissive: '' };
  },

  /**
   * `count` stripes running the length of the region, filling its height,
   * `gap` of a stripe's width apart. `edge` pinstripes each one along both
   * sides, `edgeWidth` of a stripe's width thick.
   */
  racingStripes: (r, c) => {
    const n = Math.max(1, Math.round(c.opts.count ?? 2));
    const gap = c.opts.gap ?? 0.25;
    const s = r.h / (n + (n - 1) * gap);
    const color = c.color(c.opts.color ?? 'white');
    const edge = c.opts.edge !== undefined ? c.color(c.opts.edge) : null;
    const e = s * (c.opts.edgeWidth ?? 0.08);
    let g = '';
    for (let k = 0; k < n; k++) {
      const y = r.y + k * s * (1 + gap);
      g += rect({ x: r.x, y, w: r.w, h: s }, color);
      if (edge) g += rect({ x: r.x, y, w: r.w, h: e }, edge) + rect({ x: r.x, y: y + s - e, w: r.w, h: e }, edge);
    }
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  /**
   * A band along the bottom of the region that turns up at one end, `rise`,
   * with a rounded outer corner: the hockey stick. `thickness` is the band's
   * height as a fraction of the region's, and the upright is as thick on the
   * car as the band is.
   */
  hockeyStick: (r, c) => {
    const th = (c.opts.thickness ?? 0.25) * r.h;
    const tw = Math.min(r.w, th / (r.anisotropy || 1));
    const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
    const start = c.opts.rise === 'start';
    const x = (v) => (start ? x0 + x1 - v : v);
    // Swept the other way once mirrored, or the corner bulges inward.
    const sweep = start ? 0 : 1;
    const d = `M${r2(x(x0))},${r2(y1 - th)} L${r2(x(x1 - tw))},${r2(y1 - th)} L${r2(x(x1 - tw))},${r2(y0)} ` +
      `L${r2(x(x1))},${r2(y0)} L${r2(x(x1))},${r2(y1 - th)} A${r2(tw)},${r2(th)} 0 0 ${sweep} ${r2(x(x1 - tw))},${r2(y1)} ` +
      `L${r2(x(x0))},${r2(y1)} Z`;
    const g = `<path d="${d}" fill="${c.color(c.opts.color ?? 'white')}"/>`;
    return c.opts.glow ? { base: '', emissive: g } : { base: g, emissive: '' };
  },

  /**
   * A row of sponsor names, one per `|` in `text`, each in an equal block
   * `gap` of the region's width apart, on a `background` where one is given.
   * Sized as `text` sizes a word: as large as the block's height allows, then
   * shrunk to its width.
   */
  sponsorRow: (r, c) => {
    const names = String(c.opts.text ?? '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!names.length) {
      c.note('has no names in its text, so nothing was drawn', 'no-text');
      return { base: '', emissive: '' };
    }
    const gap = (c.opts.gap ?? 0.04) * r.w;
    const bw = (r.w - gap * (names.length - 1)) / names.length;
    const ax = r.anisotropy ? 1 / r.anisotropy : 1;
    const tracking = c.opts.tracking ?? 0.06;
    const color = c.color(c.opts.color ?? 'black');
    const back = c.opts.background !== undefined ? c.color(c.opts.background) : null;
    let g = '';
    names.forEach((name, k) => {
      const x = r.x + k * (bw + gap);
      if (back) g += rect({ x, y: r.y, w: bw, h: r.h }, back);
      let size = r.h * 0.6;
      const inner = bw * 0.9;
      const est = name.length * size * (0.62 + tracking) * ax;
      if (est > inner) size *= inner / est;
      g += `<g transform="translate(${r2(x + bw / 2)},${r2(r.y + r.h / 2 + size * 0.36)}) scale(${r2(ax)},1)">` +
        `<text x="0" y="0" fill="${color}" font-family="${c.font}" font-size="${r2(size)}" ` +
        `font-weight="${c.opts.weight ?? 800}" letter-spacing="${r2(size * tracking)}" text-anchor="middle">${esc(name)}</text></g>`;
    });
    return { base: g, emissive: '' };
  },
};

/** See `definePack`: tool metadata, never read by the build, defaults as hints. */
export default definePack('classic', treatments, {
  chevrons: {
    label: 'Chevrons',
    summary: 'Arrowheads in a row across the region, pointing one way.',
    options: {
      color: { type: 'color', hint: 'white' },
      count: { type: 'number', min: 1, step: 1, hint: '3' },
      point: { type: 'enum', values: ['right', 'left'], hint: 'right' },
      depth: { type: 'number', min: 0, max: 2, step: 0.05, hint: '0.5 of the height — about 45 degrees', label: 'Depth' },
      width: { type: 'number', min: 0.05, max: 1, step: 0.05, hint: '0.5 of the spacing', label: 'Thickness' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },
  checkers: {
    label: 'Checkers',
    summary: 'A chequered field, square on the car.',
    options: {
      color: { type: 'color', hint: 'black' },
      color2: { type: 'color', hint: 'none — the other squares are left as they are', label: 'Second color' },
      rows: { type: 'number', min: 1, step: 1, hint: '2' },
    },
  },
  racingStripes: {
    label: 'Racing stripes',
    summary: 'Parallel stripes the length of the region, with optional pinstripe edges.',
    options: {
      color: { type: 'color', hint: 'white' },
      count: { type: 'number', min: 1, step: 1, hint: '2' },
      gap: { type: 'number', min: 0, max: 2, step: 0.05, hint: '0.25 of a stripe', label: 'Gap' },
      edge: { type: 'color', hint: 'none', label: 'Pinstripe' },
      edgeWidth: { type: 'number', min: 0.01, max: 0.5, step: 0.01, hint: '0.08 of a stripe', label: 'Pinstripe width' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },
  hockeyStick: {
    label: 'Hockey stick',
    summary: 'A band along the bottom that turns up at one end.',
    options: {
      color: { type: 'color', hint: 'white' },
      thickness: { type: 'number', min: 0.02, max: 1, step: 0.02, hint: '0.25 of the height' },
      rise: { type: 'enum', values: ['end', 'start'], hint: 'end', label: 'Turns up at' },
      glow: { type: 'boolean', hint: 'false', label: 'Glow' },
    },
  },
  sponsorRow: {
    label: 'Sponsor row',
    summary: 'Sponsor names in equal blocks, one per | in the text.',
    options: {
      text: { type: 'string', hint: 'ACME | NORTHWIND | KESTREL' },
      color: { type: 'color', hint: 'black' },
      background: { type: 'color', hint: 'none', label: 'Block' },
      gap: { type: 'number', min: 0, max: 0.5, step: 0.01, hint: '0.04 of the width' },
      tracking: { type: 'number', min: 0, max: 0.5, step: 0.01, hint: '0.06' },
      weight: { type: 'number', min: 100, max: 900, step: 100, hint: '800' },
    },
  },
});
