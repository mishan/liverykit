// ---------------------------------------------------------------------------
// The fitting editor.
//
// One idea worth holding on to: the overlay never draws its own opinion of where
// a region is. Every box on screen is the ABSOLUTE rectangle the server said the
// region resolved to, after the fit and the tag selection were applied. So if
// the overlay and the texture ever disagree, you can see that they do, instead
// of dragging a box that has quietly stopped corresponding to the artwork.
//
// Coordinates on screen are absolute texture fractions scaled to a 1000-unit
// viewBox. `at` is panel-relative everywhere in liverykit, so the conversion
// happens once, on the way into the fit — never a second meaning for the field.
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const VIEW = 1000;

const state = {
  data: null,        // /api/state
  surface: null,     // the surface being edited
  selected: null,    // region id
  fit: null,         // working copy, saved only on demand
  placed: [],        // where each region actually landed, from the server
  dirty: false,
};

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
};

// --- boot -------------------------------------------------------------------

const data = await api('/api/state');
state.data = data;
state.fit = structuredClone(data.fit);
// `livery.id`, not `livery.folder`. A fit is looked up at fits/<id>@<car>.json
// and repeats the pair inside itself; `folder` is the skin directory the game
// installs, which for this design is the same name underscored. Writing that in
// would produce a fit whose contents disagree with its own filename, and with
// every fit already shipped.
state.fit.livery ??= data.livery.id;
state.fit.car ??= data.car.id;
state.fit.regions ??= {};

$('#livery').textContent = data.livery.name;
$('#car').textContent = data.car.name;

// Everything interpolated below comes from a livery or a car profile — files
// this tool did not write. Escaping is not about a hostile car pack; it is that
// a filename containing a quote silently breaks the attribute it sits in, and
// the result looks like the editor is broken rather than the name unusual.
$('#surface').innerHTML = data.surfaces
  .map((s, i) => `<option value="${i}">${esc(s.from)} — ${esc(s.file)}</option>`).join('');
$('#surface').onchange = () => selectSurface(+$('#surface').value);

$('#save').onclick = async () => {
  await api('/api/fit', state.fit);
  setDirty(false);
  status('saved');
};

// --- rendering --------------------------------------------------------------

async function selectSurface(i) {
  state.surface = state.data.surfaces[i];
  state.selected = null;
  drawPanels();
  await refresh();
}

/** Re-render the texture and redraw everything over it. */
async function refresh() {
  const t0 = performance.now();
  const out = await api('/api/render', { fit: state.fit, role: state.surface.role });
  state.placed = out.placed;
  $('#texture').innerHTML = out.svg;
  drawOverlay();
  drawRegions();
  drawInspector();
  $('#fitjson').textContent = JSON.stringify(state.fit, null, 2);
  $('#notes').innerHTML = out.notes
    .map((n) => `<div class="note">! ${esc(n.text)}</div>`).join('');
  status(`rendered in ${Math.round(performance.now() - t0)} ms`);
}

function drawPanels() {
  const s = state.surface;
  $('#panelcount').textContent = `${s.panels.length}`;
  $('#panels').innerHTML = s.panels.map((p) => `
    <li data-panel="${esc(p.name)}">
      <span class="id">${esc(p.name)}</span>
      <span class="meta">${p.instances ? `×${esc(p.instances)} ` : ''}${esc(p.tags.join(' '))}</span>
    </li>`).join('');
  for (const li of $('#panels').children) {
    li.onclick = () => movePanel(li.dataset.panel);
  }
}

function drawRegions() {
  const s = state.surface;
  $('#regions').innerHTML = s.regions.map((r) => {
    const o = r.id ? state.fit.regions[r.id] : null;
    const cls = [r.id === state.selected ? 'sel' : '', !r.editable ? 'locked' : '', o?.drop ? 'off' : ''];
    const meta = !r.editable ? 'no id'
      : o?.drop ? 'dropped'
      : o ? 'adjusted'
      : (r.tags ? r.tags.join(' ') : r.panel ?? '');
    return `<li class="${cls.join(' ')}" data-id="${esc(r.id ?? '')}">
      <span class="id">${esc(r.id ?? r.treatment)}</span>
      <span class="meta">${esc(meta)}</span></li>`;
  }).join('');
  for (const li of $('#regions').children) {
    if (!li.dataset.id) continue;
    li.onclick = () => { state.selected = li.dataset.id; drawRegions(); drawOverlay(); drawInspector(); };
  }
}

function drawOverlay() {
  const svg = $('#overlay');
  const s = state.surface;
  const sel = state.placed.find((p) => p.id === state.selected);
  const host = sel?.panel;

  const parts = s.panels.map((p) => rect(p.rect, `panelrect${p.name === host ? ' host' : ''}`,
    `data-panel="${esc(p.name)}"`));

  // Every other placed region, faint, so you can see what you are about to
  // overlap before you overlap it.
  for (const p of state.placed) {
    if (p.id === state.selected) continue;
    parts.push(rect(p.abs, 'ghost'));
  }

  if (sel) {
    parts.push(rect(sel.abs, 'box', 'data-drag="move"'));
    const [x, y, w, h] = sel.abs.map((n) => n * VIEW);
    parts.push(`<rect class="handle" data-drag="resize" x="${x + w - 7}" y="${y + h - 7}" width="14" height="14"/>`);
  }
  svg.innerHTML = parts.join('');

  for (const el of svg.querySelectorAll('.panelrect')) {
    el.onclick = () => movePanel(el.dataset.panel);
  }
  for (const el of svg.querySelectorAll('[data-drag]')) {
    el.onpointerdown = (e) => startDrag(e, el.dataset.drag);
  }
}

// A function DECLARATION, deliberately. This module boots with a top-level
// await that runs before the rest of the file is evaluated, so a `const` arrow
// down here is still in its temporal dead zone when the first draw happens — and
// the whole module throws, leaving a page that renders its static HTML and does
// nothing. That is exactly what "it looks like a mockup" is.
function rect(r, cls, extra = '') {
  return `<rect class="${cls}" ${extra} x="${r[0] * VIEW}" y="${r[1] * VIEW}" ` +
    `width="${r[2] * VIEW}" height="${r[3] * VIEW}"/>`;
}

// --- editing ----------------------------------------------------------------

function override(id) {
  state.fit.regions[id] ??= {};
  return state.fit.regions[id];
}

/** Move the selected region onto a panel, keeping its shape where possible. */
async function movePanel(name) {
  if (!state.selected) return status('select a region first');
  const sel = state.placed.find((p) => p.id === state.selected);
  const panel = state.surface.panels.find((p) => p.name === name);
  if (!sel || !panel) return;

  const o = override(state.selected);
  o.panel = name;
  // `at` is panel-RELATIVE, so moving to a different panel keeps the region's
  // proportions rather than its size — which is what you want, since a door and
  // a rear quarter are nothing like the same size and a number that kept its
  // pixel dimensions would look wrong on one of them.
  //
  // Whatever the region already had is kept; only a region that never had an `at`
  // needs a starting rectangle, and a centred half-panel is a reasonable one.
  o.at ??= [0.25, 0.25, 0.5, 0.5];
  delete o.drop;
  setDirty(true);
  await refresh();
}

function startDrag(e, mode) {
  e.preventDefault();
  const svg = $('#overlay');
  const box = svg.getBoundingClientRect();
  const sel = state.placed.find((p) => p.id === state.selected);
  if (!sel) return;

  const start = { x: e.clientX, y: e.clientY, abs: [...sel.abs] };
  const toFrac = (dx, dy) => [dx / box.width, dy / box.height];

  const move = (ev) => {
    const [dx, dy] = toFrac(ev.clientX - start.x, ev.clientY - start.y);
    let [x, y, w, h] = start.abs;
    if (mode === 'move') { x += dx; y += dy; } else { w = Math.max(0.01, w + dx); h = Math.max(0.01, h + dy); }
    // Stay inside the texture. Nothing outside it is painted anyway.
    x = Math.min(Math.max(0, x), 1 - w);
    y = Math.min(Math.max(0, y), 1 - h);
    sel.abs = [x, y, w, h];
    drawOverlay();
  };
  const up = async () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    commit(sel);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/**
 * Write the dragged rectangle back as a panel-relative `at`.
 *
 * This is the conversion the design doc settled on: the editor works in absolute
 * coordinates because that is what a mouse gives you, and converts once, here.
 */
async function commit(sel) {
  const panel = state.surface.panels.find((p) => p.name === sel.panel);
  const o = override(sel.id);
  o.at = panel ? toPanelRelative(panel.rect, sel.abs) : sel.abs.map(r4);
  if (sel.panel && !state.surface.regions.find((r) => r.id === sel.id)?.panel) {
    // The region reached this panel through tags. Pin it, or the next profile
    // regeneration could move the artwork somewhere else entirely.
    o.panel = sel.panel;
  }
  setDirty(true);
  await refresh();
}

function r4(n) { return Math.round(n * 10000) / 10000; }

/** Mirrors toPanelRelative in src/fit.mjs; the browser cannot import that. */
function toPanelRelative(panelRect, abs) {
  const [px, py, pw, ph] = panelRect;
  if (!pw || !ph) return [0, 0, 1, 1];
  return [r4((abs[0] - px) / pw), r4((abs[1] - py) / ph), r4(abs[2] / pw), r4(abs[3] / ph)];
}

function drawInspector() {
  const el = $('#inspector');
  const sel = state.placed.find((p) => p.id === state.selected);
  if (!sel) { el.className = 'empty'; el.textContent = 'Nothing selected.'; return; }

  const o = state.fit.regions[sel.id] ?? {};
  el.className = '';
  el.innerHTML = `
    <div><code>${esc(sel.id)}</code></div>
    <label>panel</label><div>${sel.panel ? esc(sel.panel) : '<span class="muted">absolute</span>'}</div>
    <label>anisotropy</label><div>${sel.anisotropy.toFixed(2)}
      ${sel.anisotropy > 1.15 || sel.anisotropy < 0.87
        ? '<span class="note">stretched — text is pre-compensated, art is not</span>' : ''}</div>
    <label>at (panel-relative)</label>
    <div><code>${(o.at ?? []).map((n) => n.toFixed(3)).join(', ') || 'from the design'}</code></div>
    <div class="row" style="margin-top:10px">
      <button id="drop">${o.drop ? 'Restore' : 'Drop on this car'}</button>
      <button id="reset">Reset</button>
    </div>`;

  $('#drop').onclick = async () => {
    const ov = override(sel.id);
    if (ov.drop) delete ov.drop; else ov.drop = true;
    setDirty(true); await refresh();
  };
  $('#reset').onclick = async () => {
    delete state.fit.regions[sel.id];
    setDirty(true); await refresh();
  };
}

// --- chrome -----------------------------------------------------------------

function setDirty(v) {
  state.dirty = v;
  $('#save').disabled = !v;
  $('#status').className = v ? 'status dirty' : 'status';
}
function status(msg) { $('#status').textContent = state.dirty ? `${msg} — unsaved` : msg; }
/** Escape for both text nodes and quoted attributes. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- boot, last -------------------------------------------------------------
//
// After every declaration, so no helper can be reached before it exists.
await selectSurface(0);
