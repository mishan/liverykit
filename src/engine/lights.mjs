// ---------------------------------------------------------------------------
// Lights a livery adds to the car: an underglow, or any light it states.
//
// Paint cannot make a light. In the game an extra light is a Custom Shaders
// Patch `[LIGHT_EXTRA_...]` section in an `ext_config.ini`, which CSP also
// reads from a skin's own folder, so the build writes one there. The renderers
// draw the same lights from the same numbers, so what the editor shows glowing
// is what the config asks the game for.
//
// Positions are the kn5's own car space, which is CSP's: metres, +Y up, and
// left and forward as the car's WHEEL_ nodes say.
// ---------------------------------------------------------------------------

import { colord, extend } from 'colord';
import namesPlugin from 'colord/plugins/names';
import { vertex } from '../model.mjs';

extend([namesPlugin]);

const DEFAULTS = { range: 1.2, spot: 160, sharpness: 0.3, intensity: 6, fade: 40 };

/**
 * The lights a design asks for on this model, each `{ from, to, direction,
 * color: [r, g, b] in 0..1, intensity, range, spot, sharpness, fade, bind }`,
 * and a note for each one it could not place.
 *
 * `underglow: 'pink'` (or `{ color, intensity, range }`) is placed from the
 * model rather than written in metres: a line under each sill, between the
 * wheels the car's physics hangs on its WHEEL_ nodes, and one down the middle.
 */
export function designLights(model, livery) {
  const lights = [];
  const notes = [];
  const color = (name, where) => {
    const hex = livery.palette?.[name] ?? name;
    const c = typeof hex === 'string' ? colord(hex) : null;
    if (c?.isValid()) {
      const { r, g, b } = c.toRgb();
      return [r / 255, g / 255, b / 255];
    }
    notes.push({ term: where, status: 'light', text: `${where}: ${JSON.stringify(name)} is not a color or a palette name; no light` });
    return null;
  };

  const glow = livery.underglow;
  if (glow) {
    const o = typeof glow === 'string' ? { color: glow } : glow;
    const rgb = color(o.color ?? 'pink', 'underglow');
    const wheels = wheelCentres(model);
    if (!wheels) {
      notes.push({ term: 'underglow', status: 'light', text: 'underglow: the model has no WHEEL_LF/RF/LR/RR nodes to place it between; no light' });
    } else if (rgb) {
      const { lf, rf, lr, rr } = wheels;
      // A sill sits about a tire's width in from the wheel centre, and the
      // light just under it, out of sight of anyone standing beside the car.
      const y = groundOf(model) + 0.14;
      const fwd = Math.sign(lf.z - lr.z) || 1;
      const inset = 0.36 * fwd;
      const side = (front, rear) => {
        const x = (front.x + rear.x) / 2;
        return { from: [x * 0.95, y, front.z - inset], to: [x * 0.95, y, rear.z + inset] };
      };
      const base = { ...DEFAULTS, direction: [0, -1, 0], color: rgb, bind: 'headlights', ...pick(o) };
      lights.push({ ...base, ...side(lf, lr) }, { ...base, ...side(rf, rr) });
      lights.push({ ...base, intensity: base.intensity * 0.66, from: [0, y + 0.02, lf.z + 0.2 * fwd], to: [0, y + 0.02, lr.z - 0.15 * fwd] });
    }
  }

  for (const [i, l] of (livery.lights ?? []).entries()) {
    const where = `lights[${i}]`;
    const from = l.from ?? l.at;
    const to = l.to ?? from;
    const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    if (!v3(from) || !v3(to) || (l.direction !== undefined && !v3(l.direction))) {
      notes.push({ term: where, status: 'light', text: `${where}: needs \`at\`, or \`from\` and \`to\`, as [x, y, z] in metres; no light` });
      continue;
    }
    const rgb = color(l.color ?? 'white', where);
    if (rgb) lights.push({ from, to, direction: l.direction ?? [0, -1, 0], color: rgb, bind: l.bind ?? 'headlights', ...pick(l) });
  }
  return { lights: lights.map((l) => ({ ...DEFAULTS, ...l })), notes };
}

function pick(o) {
  const out = {};
  for (const k of ['intensity', 'range', 'spot', 'sharpness']) if (Number.isFinite(o[k])) out[k] = o[k];
  return out;
}

/** Where the tires touch: the lowest point of the model, sampled. */
export function groundOf(model) {
  let lo = Infinity;
  for (const mesh of model.meshes ?? []) {
    const step = Math.max(1, Math.floor(mesh.vertexCount / 400));
    for (let i = 0; i < mesh.vertexCount; i += step) lo = Math.min(lo, vertex(model, mesh, i).y);
  }
  return Number.isFinite(lo) ? lo : 0;
}

function wheelCentres(model) {
  const at = (key) => {
    const d = (model.dummies ?? []).find((n) => n.name.toUpperCase() === `WHEEL_${key}`);
    return d && { x: d.world[12], y: d.world[13], z: d.world[14] };
  };
  const lf = at('LF'), rf = at('RF'), lr = at('LR'), rr = at('RR');
  return lf && rf && lr && rr ? { lf, rf, lr, rr } : null;
}

const BIND = { headlights: 'BIND_TO_HEADLIGHTS = 1', brakes: 'BIND_TO_BRAKELIGHTS = 1' };

/** The lights as the sections of an `ext_config.ini`, or '' for none. */
export function extConfigIni(lights) {
  const n = (v) => +v.toFixed(3);
  const v = (a) => a.map(n).join(', ');
  return lights.map((l) => {
    const line = l.from.some((c, k) => c !== l.to[k]);
    return [
      '[LIGHT_EXTRA_...]',
      ...(line ? [`LINE_FROM = ${v(l.from)}`, `LINE_TO = ${v(l.to)}`] : [`POSITION = ${v(l.from)}`]),
      `DIRECTION = ${v(l.direction)}`,
      // RGBM: the color, then a multiplier that is the light's strength.
      `COLOR = ${v(l.color)}, ${n(l.intensity)}`,
      `SPOT = ${n(l.spot)}`,
      `SPOT_SHARPNESS = ${n(l.sharpness)}`,
      `RANGE = ${n(l.range)}`,
      `FADE_AT = ${n(l.fade)}`,
      ...(BIND[l.bind] ? [BIND[l.bind]] : []),
    ].join('\n');
  }).join('\n\n') + (lights.length ? '\n' : '');
}

/**
 * The light the lights put on a point of the ground, as linear [r, g, b].
 * The falloff is the usual (1 - d/range)^2 from the nearest point of each
 * light, and the spot cone fades over its outer `sharpness`. The viewer's
 * floor shader is this, line for line.
 */
export function groundGlow(lights, x, y, z) {
  const out = [0, 0, 0];
  for (const l of lights) {
    const [ax, ay, az] = l.from, [bx, by, bz] = l.to;
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const len2 = ex * ex + ey * ey + ez * ez;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / len2)) : 0;
    const dx = x - (ax + t * ex), dy = y - (ay + t * ey), dz = z - (az + t * ez);
    const d = Math.hypot(dx, dy, dz);
    if (d >= l.range) continue;
    const fall = (1 - d / l.range) ** 2;
    const [ux, uy, uz] = l.direction;
    const cos = d ? (dx * ux + dy * uy + dz * uz) / (d * Math.hypot(ux, uy, uz)) : 1;
    const edge = Math.cos((l.spot / 2) * Math.PI / 180);
    const inner = Math.cos((l.spot / 2) * (1 - l.sharpness) * Math.PI / 180);
    const cone = Math.max(0, Math.min(1, (cos - edge) / Math.max(1e-6, inner - edge)));
    const k = (l.intensity / DEFAULTS.intensity) * fall * cone;
    for (let c = 0; c < 3; c++) out[c] += l.color[c] * k;
  }
  return out;
}
