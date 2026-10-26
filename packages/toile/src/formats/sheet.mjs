/**
 * Bring each UV island stored wholly on another copy of the sheet back onto
 * the copy in [0, 1], as a whole-number shift per vertex.
 *
 * ac-kn5 does exactly this for a kn5 as it reads one (`placeOnSheet`, where
 * the reasons for every rule below are written down: wrap addressing,
 * exporters that shift whole unwraps, the edge slack, why a straddler stays).
 * This is the same rule over any format's vertices, for a format ac-kn5 does
 * not read, and the two must agree: a model is placed on the sheet the same
 * way whichever file it came in.
 *
 * `uvAt(i)` gives a vertex's [u, v] as stored. Returns `uvShift` — 2 numbers
 * per vertex, or null when nothing moves — and `straddlers`, the vertex count
 * of each sheet-sized island that crosses an edge and so cannot move whole.
 */
import { SHEET_SPAN } from './kn5.mjs';

const SHEET_EDGE = (SHEET_SPAN - 1) / 2;

export function placeOnSheet(n, tris, uvAt) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    let a = x;
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (const [a, b, c] of tris) {
    for (const [p, q] of [[a, b], [b, c]]) {
      const rp = find(p), rq = find(q);
      if (rp !== rq) parent[rq] = rp;
    }
  }
  const bounds = new Map();
  const size = new Map();
  for (let i = 0; i < n; i++) {
    const [u, v] = uvAt(i);
    const r = find(i);
    size.set(r, (size.get(r) ?? 0) + 1);
    const b = bounds.get(r);
    if (!b) { bounds.set(r, [u, v, u, v]); continue; }
    if (u < b[0]) b[0] = u; if (v < b[1]) b[1] = v;
    if (u > b[2]) b[2] = u; if (v > b[3]) b[3] = v;
  }
  const tileOf = (lo, hi) => {
    let best = null, least = Infinity;
    for (let k = Math.ceil(hi - 1 - SHEET_EDGE); k <= Math.floor(lo + SHEET_EDGE); k++) {
      const off = Math.max(0, k - lo) + Math.max(0, hi - k - 1);
      if (off < least || (off === least && k === 0)) { best = k; least = off; }
    }
    return best;
  };
  const sheetSized = (lo, hi) => hi - lo > 1e-5 && hi - lo <= SHEET_SPAN;
  const moves = new Map();
  const straddlers = [];
  for (const [r, [u0, v0, u1, v1]] of bounds) {
    const ku = tileOf(u0, u1), kv = tileOf(v0, v1);
    if (ku === null || kv === null) {
      if (sheetSized(u0, u1) && sheetSized(v0, v1)) straddlers.push(size.get(r));
      continue;
    }
    if (ku !== 0 || kv !== 0) moves.set(r, [-ku, -kv]);
  }
  if (!moves.size) return { uvShift: null, straddlers };
  const uvShift = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const m = moves.get(find(i));
    if (m) { uvShift[2 * i] = m[0]; uvShift[2 * i + 1] = m[1]; }
  }
  return { uvShift, straddlers };
}
