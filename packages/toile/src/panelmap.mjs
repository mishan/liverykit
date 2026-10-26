// ---------------------------------------------------------------------------
// A panel map: a texture that paints each panel the world sees in its own
// color, with its name and the way its `at` runs.
//
// `at` is panel-relative, in the sheet's frame, and the sheet says nothing
// about the car: the NSX's right flank is unwrapped upside down, and a door
// laid sideways in the texture runs its x up the car. Learning that took
// drafting a livery and rendering it. Drawn on the car by render_car's own
// rasterizer, this answers it in one picture: the dot is at [0, 0], the
// arrows are x and y, and the name reads the way text with rotate: 'auto'
// will.
// ---------------------------------------------------------------------------

import { esc } from './packs/core.mjs';
import { texture } from './profile.mjs';

// Far enough apart round the wheel that neighbors differ.
const hue = (i) => (i * 137.508) % 360;

/** The map for one texture role, as an SVG the size of the texture. */
export function panelMap(profile, role) {
  const { width: W, height: H } = texture(profile, role);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="#2a2d33"/>`];
  const seen = Object.entries(profile.panels?.[role] ?? {}).filter(([, q]) => q.visible > 0 && Array.isArray(q.rect));
  for (const [i, [name, q]] of seen.entries()) {
    const [x, y, w, h] = [q.rect[0] * W, q.rect[1] * H, q.rect[2] * W, q.rect[3] * H];
    const fill = `hsl(${hue(i).toFixed(1)}, 60%, 45%)`;
    // Its outline where the profile has one: a box takes in the islands packed
    // inside it, and tinting those the same would say they are this panel.
    out.push(Array.isArray(q.outline) && q.outline.length >= 3
      ? `<polygon points="${q.outline.map(([u, v]) => `${(u * W).toFixed(1)},${(v * H).toFixed(1)}`).join(' ')}" fill="${fill}"/>`
      : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`);

    // The name, turned as rotate: 'auto' turns text on this panel.
    const turn = ((Number(q.textRotation ?? 0) % 360) + 360) % 360;
    const quarter = turn === 90 || turn === 270;
    const [along, across] = quarter ? [h, w] : [w, h];
    const size = Math.min(across * 0.22, (along * 0.9) / Math.max(1, name.length * 0.6));
    const cx = x + w / 2, cy = y + h / 2;
    if (size >= 9) {
      out.push(`<text x="${cx.toFixed(1)}" y="${(cy + size * 0.35).toFixed(1)}" transform="rotate(${turn} ${cx.toFixed(1)} ${cy.toFixed(1)})" ` +
        `font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${size.toFixed(1)}" fill="#ffffff" ` +
        `text-anchor="middle">${esc(name)}</text>`);
    }

    // [0, 0] and the two axes of `at`, in the sheet's frame, which is the
    // frame `at` is in whatever the panel's turn.
    const a = Math.min(w, h) * 0.3, s = Math.max(6, a * 0.28), ox = x + w * 0.06, oy = y + h * 0.08;
    if (a >= 12) {
      out.push(`<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="${(s * 0.35).toFixed(1)}" fill="#ffffff"/>`,
        `<path d="M${ox},${oy} h${a} m${-s * 0.6},${-s * 0.4} l${s * 0.6},${s * 0.4} l${-s * 0.6},${s * 0.4}" stroke="#ffffff" stroke-width="${(s * 0.25).toFixed(1)}" fill="none"/>`,
        `<path d="M${ox},${oy} v${a} m${-s * 0.4},${-s * 0.6} l${s * 0.4},${s * 0.6} l${s * 0.4},${-s * 0.6}" stroke="#ffd34d" stroke-width="${(s * 0.25).toFixed(1)}" fill="none"/>`,
        `<text x="${(ox + a + s * 0.3).toFixed(1)}" y="${(oy + s * 0.35).toFixed(1)}" font-family="DejaVu Sans, sans-serif" font-size="${s.toFixed(1)}" fill="#ffffff">x</text>`,
        `<text x="${(ox - s * 0.3).toFixed(1)}" y="${(oy + a + s).toFixed(1)}" font-family="DejaVu Sans, sans-serif" font-size="${s.toFixed(1)}" fill="#ffd34d">y</text>`);
    }
  }
  out.push('</svg>');
  return out.join('');
}
