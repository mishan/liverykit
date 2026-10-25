/**
 * Individual proposal diff operation handlers for designs and fits.
 * Shared between Node (server.mjs / tests) and Browser (app.js).
 */

import { CONSTRAINTS } from '../constraints.mjs';

export { CONSTRAINTS };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);


/**
 * Write a constraint onto a region, or refuse to.
 *
 * THROWS on a name nothing enforces, rather than writing it. Every other op in
 * this file returns quietly on bad input, and for most of them that is fine —
 * a malformed palette entry is visible the moment you look at the palette. A
 * constraint is different: it is invisible until something violates it, so a
 * misspelled one reads as a rule in force and behaves as no rule at all. That
 * is the failure this whole area of the code exists to refuse, and refusing it
 * at the point of writing is better than reporting it later.
 *
 * `null` removes. Constraints are optional by nature and a region that has
 * stopped needing one should be able to say so.
 */
export function opSetConstraint(design, { id, key, value }) {
  if (!isSafeKey(id)) return;
  if (!Object.hasOwn(CONSTRAINTS, key)) {
    throw new Error(`No constraint called ${JSON.stringify(key)}. ` +
      `Known constraints: ${Object.keys(CONSTRAINTS).join(', ')}.`);
  }
  if (value !== null) {
    const want = key === 'keepClear' ? 'boolean' : key === 'groupWith' || key === 'stripe' ? 'string' : 'number';
    if (typeof value !== want) {
      throw new Error(`Constraint "${key}" takes a ${want}, not ${JSON.stringify(value)}.`);
    }
    // Exactly: the browser trims what is typed, and an operation from an agent
    // is not typed. `'team '` was stored as written and named no region.
    if (key === 'groupWith' && (!value.trim() || value !== value.trim() || value === id)) {
      throw new Error(`Constraint "groupWith" names another region's id, exactly; got ${JSON.stringify(value)}.`);
    }
    // The same for a stripe's name, which is how its pieces find each other:
    // 'centre ' is a second stripe of one piece, measured against nothing.
    if (key === 'stripe' && (!value.trim() || value !== value.trim())) {
      throw new Error(`Constraint "stripe" is the stripe's name, shared exactly by every piece of it; got ${JSON.stringify(value)}.`);
    }
    if ((key === 'minOnCar' || key === 'minVisible') && (value < 0 || value > 1)) {
      throw new Error(`Constraint "${key}" is a fraction between 0 and 1; got ${value}.`);
    }
    if ((key === 'minMm' || key === 'minMargin') && !(value > 0)) {
      throw new Error(`Constraint "${key}" is a size in millimetres, above zero; got ${value}.`);
    }
  }
  for (const grp of ['surfaces', 'paint']) {
    for (const spec of Object.values(design[grp] ?? {})) {
      for (const r of spec.regions ?? []) {
        if (r.id !== id) continue;
        if (value === null) {
          delete r.constraints?.[key];
          if (r.constraints && !Object.keys(r.constraints).length) delete r.constraints;
        } else {
          r.constraints ??= {};
          r.constraints[key] = value;
        }
      }
    }
  }
}

export function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

export function opSetPalette(design, { name, value }) {
  if (!isSafeKey(name)) return;
  design.palette ??= {};
  if (value === null) delete design.palette[name];
  else design.palette[name] = value;
}

export function opDeletePalette(design, { name }) {
  if (!isSafeKey(name)) return;
  if (design.palette) delete design.palette[name];
}

export function opSetIdentity(design, { key, value }) {
  if (!isSafeKey(key)) return;
  design.identity ??= {};
  if (value === null) delete design.identity[key];
  else design.identity[key] = value;
}

export function opAddRegion(design, { surface = 'surfaces.body', region, index }) {
  let group = 'surfaces';
  let name = surface;
  if (surface.includes('.')) {
    const parts = surface.split('.');
    group = parts[0];
    name = parts.slice(1).join('.');
  } else if (design.paint && design.paint[surface]) {
    group = 'paint';
  }
  if (group !== 'surfaces' && group !== 'paint') return;
  if (!isSafeKey(name)) return;

  // An id the design already has is refused, not added again. Ids are how a
  // fit addresses a region, and a livery using one twice cannot be loaded: a
  // proposal applied in a tab still holding the design from before its
  // editor restarted doubled every region it added, the editor stored that,
  // and the page would not load again until the server was restarted.
  if (typeof region?.id === 'string' && region.id) {
    for (const grp of ['surfaces', 'paint']) {
      for (const [where, spec] of Object.entries(design[grp] ?? {})) {
        if ((spec?.regions ?? []).some((r) => r?.id === region.id)) {
          throw new Error(`There is already a region called "${region.id}" (on "${where}"): use set-region to ` +
            'change it, or give the new one another id.');
        }
      }
    }
  }
  design[group] ??= {};
  design[group][name] ??= { regions: [] };
  design[group][name].regions ??= [];
  const regions = design[group][name].regions;
  const idx = typeof index === 'number' ? index : regions.length;
  regions.splice(idx, 0, structuredClone(region));
}

export function opRemoveRegion(design, { id }) {
  if (!isSafeKey(id)) return;
  for (const grp of ['surfaces', 'paint']) {
    if (!design[grp]) continue;
    for (const spec of Object.values(design[grp])) {
      if (Array.isArray(spec.regions)) {
        spec.regions = spec.regions.filter((r) => r.id !== id);
      }
    }
  }
}

export function opReorderRegion(design, { surface, id, toIndex }) {
  if (!isSafeKey(id)) return;
  for (const grp of ['surfaces', 'paint']) {
    if (!design[grp]) continue;
    for (const [surfName, spec] of Object.entries(design[grp])) {
      if (surface && surface !== surfName && surface !== `${grp}.${surfName}`) continue;
      if (!Array.isArray(spec.regions)) continue;
      const idx = spec.regions.findIndex((r) => r.id === id);
      if (idx >= 0) {
        const [reg] = spec.regions.splice(idx, 1);
        const targetIdx = Math.max(0, Math.min(toIndex ?? 0, spec.regions.length));
        spec.regions.splice(targetIdx, 0, reg);
      }
    }
  }
}

export function opSetOption(design, { id, key, value }) {
  if (!isSafeKey(id) || !isSafeKey(key)) return;
  for (const grp of ['surfaces', 'paint']) {
    if (!design[grp]) continue;
    for (const spec of Object.values(design[grp])) {
      for (const r of spec.regions ?? []) {
        if (r.id === id) {
          if (value === null) delete r[key];
          else r[key] = value;
        }
      }
    }
  }
}

export function opSetRegion(design, { id, region }) {
  if (!isSafeKey(id)) return;
  for (const grp of ['surfaces', 'paint']) {
    if (!design[grp]) continue;
    for (const spec of Object.values(design[grp])) {
      if (Array.isArray(spec.regions)) {
        const idx = spec.regions.findIndex((r) => r.id === id);
        if (idx >= 0) {
          spec.regions[idx] = structuredClone(region);
        }
      }
    }
  }
}

/**
 * Take an unpainted texture into the design, the way the editor's own button
 * does — EMPTY, and with no background.
 *
 * This defaulted `background` to `ink`, which is a color the agent did not
 * choose and the person did not either. Two things wrong with that. It differs
 * from what clicking Paint this too produces, so the same act had two outcomes
 * depending on who performed it; and a background is a design decision that
 * changes what the surface looks like, which is exactly the class of thing a
 * proposal should put in front of somebody rather than assume.
 *
 * With no background the sheet renders the renderer's default black, which is
 * the honest picture of a surface just taken over: the stock artwork is gone
 * and nothing has replaced it. A proposal that wants a color there can say so
 * with `set-option`, where it will be read.
 */
export function opAdoptSurface(design, { role, background }) {
  if (!isSafeKey(role)) return;
  design.paint ??= {};
  if (!design.paint[role]) {
    design.paint[role] = { regions: [] };
    // Only when asked for by name. `undefined` is not a color.
    if (typeof background === 'string' && background) design.paint[role].background = background;
  }
}

/**
 * Apply one design op, or say why not.
 *
 * The default case used to `break` and return, so an op name this build does
 * not know did nothing and said nothing. That reads as an accepted proposal
 * that changed the design, and it is how a `set-constraint` reaching an editor
 * loaded before constraints existed would look: the banner says accepted, the
 * design is untouched, and nobody is told which of the two happened.
 */
export function applyDesignOp(design, op) {
  if (!op || typeof op !== 'object') {
    throw new Error(`A design op must be an object; got ${JSON.stringify(op)}.`);
  }
  switch (op.op) {
    case 'set-palette': opSetPalette(design, op); break;
    case 'delete-palette': opDeletePalette(design, op); break;
    case 'set-identity': opSetIdentity(design, op); break;
    case 'add-region': opAddRegion(design, op); break;
    case 'remove-region': opRemoveRegion(design, op); break;
    case 'reorder-region': opReorderRegion(design, op); break;
    case 'set-option': opSetOption(design, op); break;
    case 'set-region': opSetRegion(design, op); break;
    case 'set-constraint': opSetConstraint(design, op); break;
    case 'adopt-surface':
    case 'add-surface': opAdoptSurface(design, op); break;
    default:
      throw new Error(`No design op called ${JSON.stringify(op.op)}. If this came from an ` +
        'agent, the editor may be older than the tool that sent it — reload the editor.');
  }
}

export function opSetOverride(fit, { id, panel, at, rotate }) {
  if (!isSafeKey(id)) return;
  let target = null;
  if (fit.copies && fit.copies[id]) {
    target = fit.copies[id];
  } else if (fit.mirrors && fit.mirrors[id]) {
    target = fit.mirrors[id];
  } else {
    fit.regions ??= {};
    fit.regions[id] ??= {};
    target = fit.regions[id];
  }

  if (panel !== undefined) target.panel = panel;
  if (at !== undefined) target.at = at;
  if (rotate !== undefined) target.rotate = rotate;
}

export function opDropOverride(fit, { id }) {
  if (!isSafeKey(id)) return;
  if (fit.regions) delete fit.regions[id];
  if (fit.copies) delete fit.copies[id];
  if (fit.mirrors) delete fit.mirrors[id];
}

export function opAddCopy(fit, { id, of, panel, at, rotate, isMirror = false }) {
  if (!isSafeKey(id) || (of !== undefined && !isSafeKey(of))) return;
  const block = isMirror ? 'mirrors' : 'copies';
  fit[block] ??= {};
  fit[block][id] = { of };
  if (panel !== undefined) fit[block][id].panel = panel;
  if (at !== undefined) fit[block][id].at = at;
  if (rotate !== undefined) fit[block][id].rotate = rotate;

  if (fit.regions) delete fit.regions[id];
}

export function applyFitOp(fit, op) {
  if (!op || typeof op !== 'object') {
    throw new Error(`A fit op must be an object; got ${JSON.stringify(op)}.`);
  }
  fit.regions ??= {};
  switch (op.op) {
    case 'set-override': opSetOverride(fit, op); break;
    case 'drop-override':
    case 'drop':
    case 'drop-copy': opDropOverride(fit, op); break;
    case 'add-copy': opAddCopy(fit, op); break;
    default:
      throw new Error(`No fit op called ${JSON.stringify(op.op)}. If this came from an agent, ` +
        'the editor may be older than the tool that sent it — reload the editor.');
  }
}

const shapeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list'
  : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

export function applyProposalDiff({ design: currentDesign, fit: currentFit }, proposal) {
  const design = structuredClone(currentDesign ?? {});
  const fit = structuredClone(currentFit ?? { regions: {}, copies: {} });
  fit.regions ??= {};

  // Refused, not skipped. Operations used to be applied only `if` they were a
  // list, so a design sent as one operation object, or as the JSON string of
  // a list, applied nothing — and a draft measured that way came back with
  // the working design's verdict, clean, as if it were the draft's.
  for (const key of ['design', 'fit']) {
    const ops = proposal?.[key];
    if (ops !== undefined && !Array.isArray(ops)) {
      throw new Error(`A proposal's "${key}" must be a list of operations; got ${shapeOf(ops)}: ` +
        `${String(JSON.stringify(ops)).slice(0, 200)}.`);
    }
  }

  if (JSON.stringify(proposal ?? {}).includes('"source":"human"') || JSON.stringify(proposal ?? {}).includes('"source": "human"')) {
    throw new Error('Proposals may not specify source: "human". Confirming bindings is a human action.');
  }

  if (Array.isArray(proposal?.design)) {
    for (const op of proposal.design) applyDesignOp(design, op);
  }

  if (Array.isArray(proposal?.fit)) {
    for (const op of proposal.fit) applyFitOp(fit, op);
  }

  return { design, fit };
}

/**
 * Where a region goes when the car is shift-clicked, or when an agent names a
 * point on a picture of it (`place_at`): centred on the point, on the smallest
 * panel under it, at the size it had on the car. Kept in
 * millimetres rather than texture fractions, because two panels are not drawn
 * to the same scale: the Abarth's door is 1.2 m across 0.27 of its sheet and
 * its quarter 2.5 m across 0.33, and a number moved between them as fractions
 * changes size. Its width and height trade places when the new panel is laid a
 * quarter turn from the old, so a name stays as long as it was along the car.
 *
 * `null` when no panel is under the point.
 */
export function placedAt(panels, sel, uv) {
  const over = panels
    .filter((p) => uv.u >= p.rect[0] && uv.u <= p.rect[0] + p.rect[2]
      && uv.v >= p.rect[1] && uv.v <= p.rect[1] + p.rect[3])
    .sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3])[0];
  if (!over) return null;
  const from = panels.find((p) => p.name === sel.panel);
  let [, , w, h] = sel.abs;
  const a = from?.metresPerUv, b = over.metresPerUv;
  if (a && b) {
    const turn = ((((from.textRotation ?? 0) - (over.textRotation ?? 0)) % 180) + 180) % 180;
    const [mmW, mmH] = [w * a[0], h * a[1]];
    [w, h] = turn === 90 ? [mmH / b[0], mmW / b[1]] : [mmW / b[0], mmH / b[1]];
  }
  return { panel: over.name, abs: [uv.u - w / 2, uv.v - h / 2, w, h] };
}
