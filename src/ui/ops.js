/**
 * Individual proposal diff operation handlers for designs and fits.
 * Shared between Node (server.mjs / tests) and Browser (app.js).
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
 * This defaulted `background` to `ink`, which is a colour the agent did not
 * choose and the person did not either. Two things wrong with that. It differs
 * from what clicking Paint this too produces, so the same act had two outcomes
 * depending on who performed it; and a background is a design decision that
 * changes what the surface looks like, which is exactly the class of thing a
 * proposal should put in front of somebody rather than assume.
 *
 * With no background the sheet renders the renderer's default black, which is
 * the honest picture of a surface just taken over: the stock artwork is gone
 * and nothing has replaced it. A proposal that wants a colour there can say so
 * with `set-option`, where it will be read.
 */
export function opAdoptSurface(design, { role, background }) {
  if (!isSafeKey(role)) return;
  design.paint ??= {};
  if (!design.paint[role]) {
    design.paint[role] = { regions: [] };
    // Only when asked for by name. `undefined` is not a colour.
    if (typeof background === 'string' && background) design.paint[role].background = background;
  }
}

export function applyDesignOp(design, op) {
  if (!op || typeof op !== 'object') return;
  switch (op.op) {
    case 'set-palette': opSetPalette(design, op); break;
    case 'delete-palette': opDeletePalette(design, op); break;
    case 'set-identity': opSetIdentity(design, op); break;
    case 'add-region': opAddRegion(design, op); break;
    case 'remove-region': opRemoveRegion(design, op); break;
    case 'reorder-region': opReorderRegion(design, op); break;
    case 'set-option': opSetOption(design, op); break;
    case 'set-region': opSetRegion(design, op); break;
    case 'adopt-surface':
    case 'add-surface': opAdoptSurface(design, op); break;
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
  if (!op || typeof op !== 'object') return;
  fit.regions ??= {};
  switch (op.op) {
    case 'set-override': opSetOverride(fit, op); break;
    case 'drop-override':
    case 'drop':
    case 'drop-copy': opDropOverride(fit, op); break;
    case 'add-copy': opAddCopy(fit, op); break;
  }
}

export function applyProposalDiff({ design: currentDesign, fit: currentFit }, proposal) {
  const design = structuredClone(currentDesign ?? {});
  const fit = structuredClone(currentFit ?? { regions: {}, copies: {} });
  fit.regions ??= {};

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
