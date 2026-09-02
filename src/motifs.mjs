import { lerp, clamp, r2 } from './engine/rng.mjs';

/**
 * PCB-style trace routing: horizontal runs joined by 45-degree diagonals,
 * with vias dropped at direction changes.
 * Returns { traces, vias } as raw SVG path/circle markup with no styling —
 * the caller wraps them in a <g> and sets stroke/fill.
 */
export function traceRouter(rng, { w, h, lanes = 8, padX = 0.03, viaR = null, turnChance = 0.65 } = {}) {
  const x0 = w * padX;
  const x1 = w * (1 - padX);
  const laneH = h / (lanes + 1);
  const via = viaR ?? Math.max(3, laneH * 0.13);

  const traces = [];
  const vias = [];

  for (let i = 1; i <= lanes; i++) {
    let x = x0;
    let y = laneH * i + (rng() - 0.5) * laneH * 0.4;
    const pts = [[x, y]];

    while (x < x1) {
      x = Math.min(x1, x + lerp(rng(), (x1 - x0) * 0.07, (x1 - x0) * 0.26));
      pts.push([x, y]);
      if (x >= x1) break;

      if (rng() < turnChance) {
        const dir = rng() < 0.5 ? -1 : 1;
        const ny = clamp(y + dir * laneH * lerp(rng(), 0.4, 1.3), laneH * 0.25, h - laneH * 0.25);
        const dx = Math.abs(ny - y); // 45 degrees
        if (x + dx < x1) {
          vias.push([x, y]);
          x += dx;
          y = ny;
          pts.push([x, y]);
        }
      }
    }

    traces.push(`<path d="M${pts.map(([px, py]) => `${r2(px)} ${r2(py)}`).join('L')}"/>`);
  }

  // A few short stub traces branching off, for visual density.
  const stubs = Math.round(lanes * 0.6);
  for (let i = 0; i < stubs; i++) {
    const sx = lerp(rng(), x0, x1);
    const sy = lerp(rng(), laneH * 0.5, h - laneH * 0.5);
    const len = lerp(rng(), laneH * 0.8, laneH * 2.4);
    traces.push(`<path d="M${r2(sx)} ${r2(sy)}L${r2(sx + len * 0.6)} ${r2(sy + len * 0.6)}L${r2(sx + len * 1.4)} ${r2(sy + len * 0.6)}"/>`);
    vias.push([sx + len * 1.4, sy + len * 0.6]);
  }

  return {
    traces: traces.join(''),
    vias: vias.map(([x, y]) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(via)}"/>`).join(''),
  };
}

/**
 * Halftone gradient: dot radius shrinks along `angle`. Pure geometry, no masks
 * or filters, so it renders identically in every rasteriser.
 */
export function halftoneDissolve({ w, h, cell = 26, angle = 0, color = '#000', maxR = null, start = 0.05, end = 0.85, x = 0, y = 0 } = {}) {
  // Callers derive `cell` from region height, so a thin region rounds it to
  // zero — and a zero pitch means the loops below never advance. That is an
  // infinite loop allocating until the process dies, with no error to explain
  // it. Clamp rather than trust the caller.
  cell = Math.max(1, cell);
  const rMax = maxR ?? cell * 0.42;
  const a = (angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const span = Math.abs(w * ux) + Math.abs(h * uy) || 1;
  // Measured from the corner the angle points AWAY from, so the projection
  // runs 0..span whichever way it faces. Taken from the origin, any angle past
  // 90 projected negative, the clamp below pinned it to 0, and every dot came
  // out full size: a dissolve asked to run bottom-to-top drew a solid field,
  // with no error and no way to tell it from one that had simply been given a
  // large `start`. The only working spelling was `start` and `end` reversed,
  // which is a trick nobody should have to know.
  const ox = ux < 0 ? w : 0;
  const oy = uy < 0 ? h : 0;
  const dots = [];

  for (let row = 0, cy = cell / 2; cy < h; row++, cy += cell * 0.866) {
    const off = row % 2 ? cell / 2 : 0;
    for (let cx = off + cell / 2; cx < w; cx += cell) {
      const p = clamp(((cx - ox) * ux + (cy - oy) * uy) / span, 0, 1);
      const t = clamp((p - start) / (end - start), 0, 1);
      const r = rMax * (1 - t);
      if (r > 0.35) dots.push(`<circle cx="${r2(x + cx)}" cy="${r2(y + cy)}" r="${r2(r)}"/>`);
    }
  }
  return `<g fill="${color}">${dots.join('')}</g>`;
}

/** Synthwave perspective grid converging on a vanishing point. */
export function horizonGrid({ w, h, horizonY = null, vpX = null, cols = 14, rows = 9, color = '#E0218A', width = 2, falloff = 2.3, x = 0, y = 0 } = {}) {
  const hy = horizonY ?? h * 0.42;
  const vx = vpX ?? w / 2;
  const parts = [];

  for (let i = 0; i <= cols; i++) {
    const bx = lerp(i / cols, -w * 0.9, w * 1.9);
    parts.push(`<path d="M${r2(x + vx)} ${r2(y + hy)}L${r2(x + bx)} ${r2(y + h)}"/>`);
  }
  for (let i = 1; i <= rows; i++) {
    const ry = hy + (h - hy) * Math.pow(i / rows, falloff);
    parts.push(`<path d="M${r2(x)} ${r2(y + ry)}H${r2(x + w)}"/>`);
  }
  return `<g fill="none" stroke="${color}" stroke-width="${width}">${parts.join('')}</g>`;
}

/** Horizontal displacement bands. */
export function glitchBands(rng, { w, h, count = 7, colors = ['#B026FF', '#00F0FF', '#FFFFFF'], y = 0, x = 0, band = 0.02 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const by = lerp(rng(), h * 0.05, h * 0.95);
    const bh = Math.max(2, h * band * lerp(rng(), 0.25, 1.4));
    const bx = lerp(rng(), 0, w * 0.35);
    const bw = lerp(rng(), w * 0.3, w - bx);
    const c = colors[Math.floor(rng() * colors.length)];
    const op = lerp(rng(), 0.55, 1);
    out.push(`<rect x="${r2(x + bx)}" y="${r2(y + by)}" width="${r2(bw)}" height="${r2(bh)}" fill="${c}" opacity="${r2(op)}"/>`);
  }
  return out.join('');
}

/** Four-point sparkles. `avoid` is a list of absolute-pixel rects to keep clear. */
export function sparkleField(rng, { w, h, n = 14, minR = 8, maxR = 34, color = '#FFFFFF', x = 0, y = 0, avoid = [] } = {}) {
  const out = [];
  const blocked = (px, py, r) =>
    avoid.some((a) => px + r > a.x && px - r < a.x + a.w && py + r > a.y && py - r < a.y + a.h);

  for (let i = 0; i < n; i++) {
    let cx, cy, r;
    let tries = 0;
    do {
      cx = x + lerp(rng(), 0, w);
      cy = y + lerp(rng(), 0, h);
      r = lerp(Math.pow(rng(), 1.8), minR, maxR);
    } while (blocked(cx, cy, r) && ++tries < 40);
    if (tries >= 40) continue; // region too crowded, drop this one

    const k = r * 0.16;
    out.push(
      `<path d="M${r2(cx)} ${r2(cy - r)}Q${r2(cx + k)} ${r2(cy - k)} ${r2(cx + r)} ${r2(cy)}` +
      `Q${r2(cx + k)} ${r2(cy + k)} ${r2(cx)} ${r2(cy + r)}` +
      `Q${r2(cx - k)} ${r2(cy + k)} ${r2(cx - r)} ${r2(cy)}` +
      `Q${r2(cx - k)} ${r2(cy - k)} ${r2(cx)} ${r2(cy - r)}Z"/>`
    );
  }
  return `<g fill="${color}">${out.join('')}</g>`;
}

/**
 * Text laid out around an arc — for tyre sidewalls, which AC usually unwraps
 * as an annulus, and for helmet bands.
 *
 * Per-character transforms rather than <textPath>: librsvg's textPath support
 * is inconsistent, and character placement here needs to be exact anyway.
 * `flip` puts the glyphs the right way up on the lower half of a circle.
 */
export function radialText({ text, cx, cy, radius, startAngle = -90, size = 40, tracking = 0.75, color = '#fff', font = 'sans-serif', weight = 700, flip = false, anchorSweep = true } = {}) {
  const chars = [...String(text)];
  if (!chars.length) return '';
  // Degrees-per-character divides by the radius, so a zero radius produces a
  // document full of NaN transforms that renders as nothing and reports nothing.
  if (!(radius > 0)) return '';
  const step = ((size * tracking) / radius) * (180 / Math.PI); // degrees per char
  const total = step * (chars.length - 1);
  const dir = flip ? -1 : 1;
  // The half-sweep offset has to follow the direction of travel, or reversed
  // text ends up centred a full sweep away from its anchor angle.
  const first = anchorSweep ? startAngle - (dir * total) / 2 : startAngle;

  const glyphs = chars.map((ch, i) => {
    if (ch === ' ') return '';
    const deg = first + i * step * dir;
    const rad = (deg * Math.PI) / 180;
    const px = cx + radius * Math.cos(rad);
    const py = cy + radius * Math.sin(rad);
    const rot = flip ? deg - 90 : deg + 90;
    return `<g transform="translate(${r2(px)},${r2(py)}) rotate(${r2(rot)})">` +
      `<text x="0" y="0" text-anchor="middle" dominant-baseline="central">${escapeXml(ch)}</text></g>`;
  });

  return `<g fill="${color}" font-family="${font}" font-size="${r2(size)}" font-weight="${weight}">${glyphs.join('')}</g>`;
}

/** Concentric annulus — sidewall bands, helmet trim rings. */
export function ring({ cx, cy, radius, width = 10, color = '#fff', opacity = 1, dash = null } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(radius)}" fill="none" stroke="${color}" stroke-width="${r2(width)}" opacity="${opacity}"${d}/>`;
}

/** Parallel offset stripes — racesuit seam piping, cuff and collar trim. */
export function piping(rng, { w, h, x = 0, y = 0, count = 4, color = '#00F0FF', width = 6, angle = 0, spacing = null } = {}) {
  const gap = spacing ?? h / (count + 1);
  const skew = Math.tan((angle * Math.PI) / 180) * h;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const ly = y + gap * i;
    out.push(`<path d="M${r2(x)} ${r2(ly)}L${r2(x + w)} ${r2(ly - skew)}"/>`);
  }
  return `<g fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round">${out.join('')}</g>`;
}

const escapeXml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** Scanline overlay — subtle, keeps big flat areas from looking like plastic. */
export function scanlines({ w, h, pitch = 8, color = '#000', opacity = 0.12, x = 0, y = 0 } = {}) {
  const lines = [];
  // Same trap as halftoneDissolve: a pitch of zero never advances the loop.
  pitch = Math.max(1, pitch);
  for (let ly = 0; ly < h; ly += pitch) {
    lines.push(`<rect x="${r2(x)}" y="${r2(y + ly)}" width="${r2(w)}" height="${r2(pitch / 2)}"/>`);
  }
  return `<g fill="${color}" opacity="${opacity}">${lines.join('')}</g>`;
}
