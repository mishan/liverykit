// ---------------------------------------------------------------------------
// UV calibration textures.
//
// The problem this solves: a livery's region coordinates are fractions of a
// texture, but nothing tells you which fraction lands on the nose, the sidepod
// or the engine cover. Guessing produces a team name that walks off a UV island
// mid-word — perfect in the texture, broken on the car.
//
// So: paint a texture that is nothing but a labelled coordinate system, install
// it, and photograph the car. Every visible surface then reports its own UV
// address. Reading "the sidepod runs from about G4 to N9" off a screenshot is
// a measurement, not a guess.
//
// Three redundant encodings, because a screenshot may be small, angled, or
// compressed and any one of them can fail:
//
//   1. Cell labels      A1, B1, ... — exact, needs a close/sharp view.
//   2. Per-cell colour  hue tracks the column, lightness tracks the row, so a
//                       blurry magenta-ish cell still narrows things down.
//   3. Quadrant marks   huge faint labels readable from across the showroom.
//
// Mirroring falls out for free: if the labels read backwards on one side of the
// car, that side shares its UV island with the other and anything asymmetric
// (text, the number) will appear reversed there. Worth knowing before it
// surprises you on track.
// ---------------------------------------------------------------------------

import { r2 } from './rng.mjs';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Rows are chosen so cells stay roughly square in texel space.
 *
 * `cols` defaults to 20 (5% per column), which is right for big panels but can
 * be coarser than a small part — a canard or a winglet may sit entirely inside
 * one cell, which tells you the cell but not where in it. `--cells 40` halves
 * the step for a second, closer pass. Past about 40 the labels stop being
 * readable in a screenshot and the hue ramp is doing all the work.
 */
export function gridShape(width, height, cells = 20) {
  // `cells` divides the LONGER edge; the shorter edge gets proportionally
  // fewer. Deriving rows from cols and clamping instead would give a portrait
  // texture square cell *counts* and 4:1 cell *shapes*, which is the opposite
  // of what's wanted — the whole value of a square cell is that however far
  // from square it looks on the car is the anisotropy you have to correct for.
  const scale = cells / Math.max(width, height);
  return {
    cols: Math.max(4, Math.round(width * scale)),
    rows: Math.max(4, Math.round(height * scale)),
  };
}

/** A, B, ... Z, AA, AB, ... so --cells can go past 26 without collisions. */
const colName = (c) =>
  c < 26 ? ALPHABET[c] : ALPHABET[Math.floor(c / 26) - 1] + ALPHABET[c % 26];

const hsl = (h, s, l) => `hsl(${r2(h)},${r2(s)}%,${r2(l)}%)`;
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/**
 * Text with a dark halo. librsvg's `paint-order` support is unreliable, so the
 * glyphs are drawn twice — stroked underneath, filled on top — rather than
 * relying on a single stroked-and-filled element.
 */
function haloText(str, x, y, size, { fill = '#FFFFFF', halo = '#000000', anchor = 'middle', weight = 700, font = 'sans-serif', opacity = 1 } = {}) {
  const common = `x="${r2(x)}" y="${r2(y)}" text-anchor="${anchor}" dominant-baseline="central" ` +
    `font-family="${font}" font-size="${r2(size)}" font-weight="${weight}"`;
  const body = esc(str);
  return `<text ${common} fill="none" stroke="${halo}" stroke-width="${r2(Math.max(2, size * 0.16))}" ` +
    `stroke-linejoin="round" opacity="${opacity}">${body}</text>` +
    `<text ${common} fill="${fill}" opacity="${opacity}">${body}</text>`;
}

/**
 * Build the calibration SVG for one texture.
 * `label` names the texture so a screenshot of the helmet can't be mistaken for
 * a screenshot of the chassis.
 */
export function uvGridSvg({ width, height, label = '', font = 'sans-serif', cols: nCols = 20 }) {
  const { cols, rows } = gridShape(width, height, nCols);
  const cw = width / cols;
  const ch = height / rows;

  const cells = [];
  const labels = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Hue walks the column; lightness carries the row via a checkerboard plus
      // a coarser 5-row banding, so neighbours differ on two axes at once.
      const hue = (c / cols) * 330;
      const light = ((c + r) % 2 ? 36 : 23) + (Math.floor(r / 5) % 2 ? 11 : 0);
      cells.push(
        `<rect x="${r2(c * cw)}" y="${r2(r * ch)}" width="${r2(cw + 0.5)}" height="${r2(ch + 0.5)}" fill="${hsl(hue, 68, light)}"/>`
      );

      const name = `${colName(c)}${r + 1}`;
      const size = Math.min(cw, ch) * 0.34;
      labels.push(haloText(name, c * cw + cw / 2, r * ch + ch / 2, size, { font }));
    }
  }

  // Majors land on quarters whatever --cells is set to, so "25%" always means
  // the same line rather than drifting with the cell count.
  const qc = Math.max(1, Math.round(cols / 4));
  const qr = Math.max(1, Math.round(rows / 4));

  // --- grid lines: minor every cell, major every 25% -----------------------
  const minor = [];
  const major = [];
  for (let c = 0; c <= cols; c++) {
    const x = r2(c * cw);
    (c % qc === 0 ? major : minor).push(`<path d="M${x} 0V${r2(height)}"/>`);
  }
  for (let r = 0; r <= rows; r++) {
    const y = r2(r * ch);
    (r % qr === 0 || r === rows ? major : minor).push(`<path d="M0 ${y}H${r2(width)}"/>`);
  }

  // --- quadrant watermarks, legible from across the showroom ---------------
  const marks = [];
  for (let r = 0; r < rows; r += qr) {
    for (let c = 0; c < cols; c += qc) {
      const bw = Math.min(qc, cols - c) * cw;
      const bh = Math.min(qr, rows - r) * ch;
      marks.push(
        haloText(`${colName(c)}${r + 1}`, c * cw + bw / 2, r * ch + bh / 2,
          Math.min(bw, bh) * 0.55, { font, opacity: 0.3, halo: '#000000' })
      );
    }
  }

  // --- edge rulers in percent ----------------------------------------------
  // 0% is skipped on both axes — the origin marker already occupies that corner.
  const ruler = [];
  for (let c = qc; c <= cols; c += qc) {
    ruler.push(haloText(`${r2((c / cols) * 100)}%`, Math.min(width - cw * 0.6, c * cw), ch * 0.22, ch * 0.2, { font, fill: '#00F0FF' }));
  }
  for (let r = qr; r < rows; r += qr) {
    ruler.push(haloText(`${r2((r / rows) * 100)}%`, cw * 0.5, r * ch + ch * 0.16, ch * 0.2, { font, fill: '#00F0FF' }));
  }

  // --- origin marker: which corner is UV 0,0, and which way is up ----------
  const oz = Math.min(cw, ch);
  const origin =
    `<g stroke="#00F0FF" stroke-width="${r2(oz * 0.09)}" fill="none">` +
    `<path d="M${r2(oz * 0.15)} ${r2(oz * 0.15)}H${r2(oz * 1.5)}"/>` +
    `<path d="M${r2(oz * 0.15)} ${r2(oz * 0.15)}V${r2(oz * 1.5)}"/>` +
    `<path d="M${r2(oz * 1.2)} ${r2(oz * 0.05)}L${r2(oz * 1.55)} ${r2(oz * 0.15)}L${r2(oz * 1.2)} ${r2(oz * 0.25)}Z" fill="#00F0FF"/>` +
    `<path d="M${r2(oz * 0.05)} ${r2(oz * 1.2)}L${r2(oz * 0.15)} ${r2(oz * 1.55)}L${r2(oz * 0.25)} ${r2(oz * 1.2)}Z" fill="#00F0FF"/>` +
    `</g>` +
    haloText('UV 0,0', oz * 0.9, oz * 0.75, oz * 0.22, { font, fill: '#00F0FF' });

  const title = label
    ? haloText(`${label}  ${width}x${height}  ${cols}col x ${rows}row`,
        width / 2, height - ch * 0.25, ch * 0.24, { font, fill: '#FFFFFF' })
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    cells.join('') +
    marks.join('') +
    `<g fill="none" stroke="#FFFFFF" stroke-width="${r2(Math.max(1, cw * 0.012))}" opacity="0.45">${minor.join('')}</g>` +
    `<g fill="none" stroke="#FFFFFF" stroke-width="${r2(Math.max(2, cw * 0.05))}" opacity="0.95">${major.join('')}</g>` +
    labels.join('') +
    ruler.join('') +
    origin +
    title +
    `</svg>`;
}

// ---------------------------------------------------------------------------
// Name probes.
//
// AC resolves a skin override against the texture names inside the car's kn5,
// NOT against whatever the stock skins happen to ship. A stock skin only
// contains the files someone chose to override, so a texture's absence from
// every skin folder proves nothing about whether the model has it.
//
// The useful consequence: a filename matching nothing overrides nothing,
// silently and harmlessly. Guessing therefore costs a few hundred KB and no
// risk at all. Ship every plausible spelling at once, give each its own loud
// colour and print its own filename on it, and one look at the car tells you
// which one the model actually uses.
//
// This found RSS4_Tire.dds on the Formula RSS 4 in a single build, after the
// part had been written off as unpaintable.
//
// One caution: no two candidates may differ only in case. Those are one file on
// NTFS, so the second to extract silently overwrites the first — and Windows
// lookup is case-insensitive anyway, so one spelling per name is enough.
// ---------------------------------------------------------------------------

/** Visually distinct and unlikely to occur naturally on a car. */
const PROBE_COLORS = [
  '#39FF14', '#FF8A00', '#FFE800', '#00E5FF', '#FF00E5',
  '#7CFF00', '#FF0055', '#00FFB2', '#B026FF', '#FFFFFF',
];

/**
 * Build probe descriptors for a list of candidate filenames.
 * Throws on case collisions rather than shipping a ZIP that silently loses one.
 */
export function makeProbes(files) {
  const seen = new Map();
  for (const f of files) {
    const k = f.toLowerCase();
    if (seen.has(k)) {
      throw new Error(
        `Probe candidates "${seen.get(k)}" and "${f}" differ only in case. ` +
        `Those are one file on NTFS — pick one spelling.`
      );
    }
    seen.set(k, f);
  }
  return files.map((file, i) => ({ file, color: PROBE_COLORS[i % PROBE_COLORS.length] }));
}

/**
 * Flat colour, filename in large type, plus concentric rings.
 *
 * The rings are not decoration: if the part turns out to be unwrapped radially
 * — as tyre sidewalls usually are — they come back as clean concentric bands,
 * which tells you the layout at the same time as the name.
 */
export function probeSvg({ width, height, file, color, label = 'NAME PROBE', font = 'sans-serif' }) {
  const cx = width / 2;
  const cy = height / 2;
  const s = Math.min(width, height);
  const name = file.replace(/\.dds$/i, '');

  const rings = [0.46, 0.34, 0.22]
    .map((f, i) => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(s * f)}" fill="none" stroke="#000" stroke-width="${r2(s * 0.012)}" opacity="${0.75 - i * 0.15}"/>`)
    .join('');

  const stamp = (y, size) => haloText(name, cx, y, size, { font, fill: '#000000', halo: '#FFFFFF' });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${color}"/>` +
    rings +
    stamp(cy - s * 0.06, s * 0.072) +
    haloText(label, cx, cy + s * 0.05, s * 0.05, { font, fill: '#000000', halo: '#FFFFFF' }) +
    // Repeated near the edges so a partial or edge-on view still shows the name.
    stamp(s * 0.07, s * 0.05) +
    stamp(height - s * 0.07, s * 0.05) +
    `</svg>`;
}
