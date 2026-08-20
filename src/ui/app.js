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

// Relative, so the same specifier resolves in the browser (served alongside
// app.js) and in Node, where the tests import this module directly.
import { createViewer, unpack, unpackModel } from './view3d.js';

const $ = (s) => document.querySelector(s);
const VIEW = 1000;

const state = {
  data: null,        // /api/state
  surface: null,     // the surface being edited
  selected: null,    // region id
  fit: null,         // working copy, saved only on demand
  placed: [],        // where each region actually landed, from the server
  dirty: false,
  svg: '',           // the last render, reused as the 3D texture
  viewer: null,      // created lazily; a UV-only session never touches WebGL
  view: 'uv',
  hover: null,       // a panel being looked at, which must never become a change
  wholeGeometry: null, // the whole car, fetched once; only its textures change
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
state.fit.livery ??= data.livery.folder;
state.fit.regions ??= {};

// Which code is actually running. Not decoration: several rounds of debugging
// this editor were spent unable to distinguish "the fix did not work" from "the
// browser or the server is running something older".
api('/api/build').then((b) => {
  $('#build').textContent = `build ${b.build} · server up ${b.started}`;
}).catch(() => {});

$('#livery').textContent = data.livery.name;
$('#car').textContent = data.car.name;

// Everything interpolated below comes from a livery or a car profile — files
// this tool did not write. Escaping is not about a hostile car pack; it is that
// a filename containing a quote silently breaks the attribute it sits in, and
// the result looks like the editor is broken rather than the name unusual.
$('#surface').innerHTML = data.surfaces
  .map((s, i) => `<option value="${i}">${esc(s.from)} — ${esc(s.file)}</option>`).join('');
$('#surface').onchange = () => selectSurface(+$('#surface').value);

// --- wiring -----------------------------------------------------------------
//
// Delegated, and attached exactly once. Every draw here replaces a container's
// innerHTML, which throws away the nodes inside it — so handlers bound to those
// nodes are thrown away with them, and the next redraw leaves a page that looks
// right and does nothing. Listening on the container instead survives any number
// of redraws, and there is one place to look when a click does not arrive.
$('#regions').onclick = (e) => {
  const li = e.target.closest?.('li[data-id]') ?? e.target;
  selectRegion(li?.dataset?.id);
};
$('#panels').onclick = (e) => {
  const li = e.target.closest?.('li[data-panel]') ?? e.target;
  if (li?.dataset?.panel) movePanel(li.dataset.panel);
};

// Hovering a panel shows where it is — on the sheet and on the car — WITHOUT
// selecting anything or touching the fit. Finding out where `centre_mid_lower_4`
// lives should not require moving a region onto it and then undoing that.
$('#panels').onpointerover = (e) => {
  const name = e.target.closest?.('li[data-panel]')?.dataset?.panel;
  if (name) hoverPanel(name);
};
$('#panels').onpointerout = (e) => {
  // Only when the pointer has left the list entirely. Moving between two rows
  // fires `out` for the first before `over` for the second, so clearing on every
  // `out` makes the highlight flicker off between neighbours.
  if (!e.relatedTarget || !$('#panels').contains?.(e.relatedTarget)) hoverPanel(null);
};
$('#overlay').onpointerdown = (e) => {
  const d = e.target?.dataset ?? {};
  if (d.drag) return startDrag(e, d.drag);
  // Click any other region's rectangle to select it — the canvas should be a
  // place you can work, not a picture you steer from the sidebar.
  if (d.id) return selectRegion(d.id);
  if (d.panel) {
    if (!state.selected) return status('pick a region first, then click a panel to move it there');
    return movePanel(d.panel);
  }
};

$('#tab-uv').onclick = () => showView('uv');
$('#tab-3d').onclick = () => showView('3d');
$('#tab-all').onclick = () => showView('all');

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
  // The viewport shows the geometry THIS texture is painted on, so changing
  // surface has to reload it. Without this the car kept its old mesh and simply
  // wore the new texture — which is why picking the driver's suit showed the
  // car wearing the suit.
  if (state.view === '3d') await loadCarGeometry();
}

/** Re-render the texture and redraw everything over it. */
async function refresh() {
  const t0 = performance.now();
  let out;
  try {
    out = await api('/api/render', { fit: state.fit, role: state.surface.role });
  } catch (e) {
    // A failed render must not leave the editor frozen with no explanation. It
    // used to reject into nothing: the page kept its last drawing and quietly
    // stopped responding to everything.
    status(`render failed: ${e.message}`);
    $('#notes').innerHTML = `<div class="note">! ${esc(e.message)}</div>`;
    return;
  }
  state.placed = out.placed;
  state.svg = out.svg;
  $('#texture').innerHTML = out.svg;
  if (state.view === '3d') paintCar();
  else if (state.view === 'all') loadWholeCar().catch((e) => status(`preview: ${e.message}`));
  drawOverlay();
  drawRegions();
  drawInspector();
  $('#fitjson').textContent = JSON.stringify(state.fit, null, 2);
  $('#notes').innerHTML = out.notes
    .map((n) => `<div class="note">! ${esc(n.text)}</div>`).join('');
  status(`rendered in ${Math.round(performance.now() - t0)} ms`);
}

// A panel list in profile order is a list in whatever order the unwrapper
// emitted islands, which is no order at all — you scroll it looking for the
// door. These put it in the order you would walk around the car: nose to tail,
// then left, centre, right, then upper before lower, then biggest first.
const SECTIONS = ['nose', 'front', 'mid', 'rear', 'tail'];
const SIDES = ['left', 'centre', 'right'];

/** Where a panel sits, from its tags, falling back to its generated name. */
function place(p) {
  const has = (t) => p.tags.includes(t) || p.name.split('_').includes(t);
  const pick = (list) => { const i = list.findIndex(has); return i < 0 ? list.length : i; };
  return {
    section: pick(SECTIONS),
    side: pick(SIDES),
    level: has('upper') ? 0 : 1,
    area: (p.rect?.[2] ?? 0) * (p.rect?.[3] ?? 0),
  };
}

function drawPanels() {
  const s = state.surface;
  $('#panelcount').textContent = `${s.panels.length}`;

  const sorted = s.panels.map((p) => ({ p, at: place(p) })).sort((a, b) =>
    a.at.section - b.at.section || a.at.side - b.at.side
    || a.at.level - b.at.level || b.at.area - a.at.area
    || a.p.name.localeCompare(b.p.name));

  const rows = [];
  let heading = null;
  for (const { p, at } of sorted) {
    // A heading per section, so the list reads as a car rather than as 66 names.
    const label = SECTIONS[at.section] ?? 'unplaced';
    if (label !== heading) { heading = label; rows.push(`<li class="head">${esc(label)}</li>`); }
    // The percentage is how much of the sheet this panel owns, which is the
    // number that decides whether artwork will fit on it.
    const share = at.area >= 0.001 ? `${(at.area * 100).toFixed(1)}%` : '<0.1%';
    rows.push(`
      <li data-panel="${esc(p.name)}" title="${esc(`${p.name} — ${p.tags.join(' ') || 'no tags'}`)}">
        <span class="id">${esc(p.name)}</span>
        <span class="meta">${p.instances ? `×${esc(p.instances)} ` : ''}${esc(share)}</span>
      </li>`);
  }
  $('#panels').innerHTML = rows.join('');
}

function drawRegions() {
  const s = state.surface;
  $('#regions').innerHTML = s.regions.map((r) => {
    const o = r.id ? state.fit.regions[r.id] : null;
    const cls = [r.id === state.selected ? 'sel' : '', !r.editable ? 'locked' : '', o?.drop ? 'off' : ''];
    const meta = o?.drop ? 'dropped'
      : o ? 'adjusted'
      : (r.tags ? r.tags.join(' ') : r.panel ?? '');
    // A derived key is positional, so the label shows the treatment — which is
    // what you recognise — rather than "surfaces.body#7", which is not.
    const label = r.derived ? `${r.treatment} ${r.index}` : r.id;
    return `<li class="${cls.join(' ')}${r.derived ? ' derived' : ''}" data-id="${esc(r.id ?? '')}"
      title="${esc(r.derived ? `addressed by position as ${r.id} — give it an id in the livery to make it stable` : r.id)}">
      <span class="id">${esc(label)}</span>
      <span class="meta">${esc(meta)}</span></li>`;
  }).join('');
}

/**
 * Preview a panel's location, on both views, changing nothing.
 *
 * Deliberately not a redraw. drawOverlay replaces the whole SVG, and doing that
 * on every pointermove would throw away the node the pointer is currently over,
 * which browsers handle by firing another `out` — a loop that reads as flicker.
 * Toggling one class on one existing node is both cheaper and correct.
 */
export function hoverPanel(name) {
  state.hover = name;
  for (const el of $('#overlay').querySelectorAll?.('.panelrect.hot') ?? []) {
    el.classList.remove('hot');
  }
  const rect = name ? state.surface.panels.find((p) => p.name === name)?.rect : null;
  if (name) {
    $('#overlay').querySelector?.(`[data-panel="${cssEscape(name)}"]`)?.classList?.add('hot');
  }
  // On the car, the hovered panel takes precedence over the selected region and
  // hands it back on the way out — so a hover is a look, never a change.
  const sel = state.placed.find((p) => p.id === state.selected);
  highlightOnCar(rect ?? sel?.abs ?? null);
}

/**
 * Quote a panel name for an attribute selector. Names come from a car profile,
 * so they are whatever an unwrapper produced. A function declaration, not a
 * const: this file has produced three temporal-dead-zone bugs already.
 */
function cssEscape(s) {
  return window.CSS?.escape ? window.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** Select a region by id, from the list or from the overlay. */
export function selectRegion(id) {
  if (!id) return;
  state.selected = id;
  drawRegions();
  drawOverlay();
  drawInspector();
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
    // Carries its id so it can be CLICKED. Without this the canvas had nothing
    // selectable on it at all: the only things that responded were panel
    // outlines, and those do nothing until something is already selected from
    // the list. So the canvas highlighted under the cursor and refused every
    // click, which is not a subtle failure to be on the receiving end of.
    parts.push(rect(p.abs, 'ghost', `data-id="${esc(p.id)}"`));
  }

  if (sel) {
    parts.push(rect(sel.abs, 'box', 'data-drag="move"'));
    const [x, y, w, h] = sel.abs.map((n) => n * VIEW);
    parts.push(`<rect class="handle" data-drag="resize" x="${x + w - 7}" y="${y + h - 7}" width="14" height="14"/>`);
  }
  svg.innerHTML = parts.join('');

  // Deliberately from THIS function and from this `sel`, rather than from
  // selectRegion. Every path that moves the selection box — clicking a row,
  // clicking the canvas, finishing a drag, re-rendering after a save — ends up
  // here, so the car cannot end up highlighting a rectangle the UV view has
  // already moved on from. Two views drawing the same thing from two sources
  // eventually disagree; these read one.
  highlightOnCar(sel?.abs ?? null);

  // A redraw replaces every node, so a panel being hovered loses its marking
  // even though the pointer never moved. Re-applying it is one line; leaving it
  // out means the highlight blinks off whenever anything else re-renders.
  if (state.hover) hoverPanel(state.hover);
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
  const panel = state.surface.panels.find((p) => p.name === name);
  if (!panel) return;
  // Deliberately does NOT require an existing placement: putting a region onto a
  // named panel is how you rescue one this car dropped or never matched.

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

    // Clamp to the PANEL, not merely to the texture. `at` is panel-relative and
    // has to stay within 0..1, so a region dragged past its panel's edge
    // produces coordinates the renderer rightly refuses — and the failed render
    // used to take the whole editor down with it.
    const host = state.surface.panels.find((p) => p.name === sel.panel);
    const [bx, by, bw, bh] = host ? host.rect : [0, 0, 1, 1];
    w = Math.min(w, bw);
    h = Math.min(h, bh);
    x = Math.min(Math.max(bx, x), bx + bw - w);
    y = Math.min(Math.max(by, y), by + bh - h);
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
  if (!state.selected) { el.className = 'empty'; el.textContent = 'Nothing selected.'; return; }

  // A selected region does not always have a PLACEMENT. It may be dropped on
  // this car, or its tags may match nothing here. Falling back to "nothing
  // selected" in that case was the single most confusing thing in this editor:
  // the first two regions of the example livery are dropped by the Abarth fit,
  // so the first two clicks anyone makes did nothing at all and the tool looked
  // broken. The inspector is exactly where you go to UNDO a drop, so it has to
  // work hardest when there is nothing on screen.
  const sel = state.placed.find((p) => p.id === state.selected);
  const def = state.surface.regions.find((r) => r.id === state.selected);
  const id = state.selected;
  const o = state.fit.regions[id] ?? {};

  if (!sel) {
    el.className = '';
    const why = o.drop
      ? 'Dropped on this car by the fit.'
      : `Nothing on this car matches ${def?.tags ? `[${esc(def.tags.join(', '))}]` : 'this region'}.`;
    el.innerHTML = `
      <div><code>${esc(id)}</code></div>
      ${derivedNote(id)}
      <p class="hint">${why} There is nothing to drag until it is placed.</p>
      <div class="row" style="margin-top:10px">
        <button id="drop">${o.drop ? 'Restore on this car' : 'Drop on this car'}</button>
        <button id="reset">Reset</button>
      </div>
      <p class="hint">Or click a panel on the right to place it there.</p>`;
    wireInspectorButtons(id);
    return;
  }
  el.className = '';
  el.innerHTML = `
    <div><code>${esc(sel.id)}</code></div>
    ${derivedNote(sel.id)}
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

  wireInspectorButtons(sel.id);
}

/**
 * Warn when a region is addressed by position rather than by name.
 *
 * A positional key shifts meaning if the livery gains a region above it, and the
 * fit then adjusts the wrong thing. The remedy is one line in the design, so it
 * is worth saying every time rather than burying in documentation.
 */
function derivedNote(id) {
  const r = state.surface.regions.find((x) => x.id === id);
  if (!r?.derived) return '';
  return `<p class="note">Addressed by position. Give this region an <code>id</code>
    in the livery, or inserting another region above it will move what this fit
    refers to.</p>`;
}

/** Shared by both inspector states, so Restore works when nothing is drawn. */
function wireInspectorButtons(id) {
  $('#drop').onclick = async () => {
    const ov = override(id);
    if (ov.drop) delete ov.drop; else ov.drop = true;
    setDirty(true);
    await refresh();
  };
  $('#reset').onclick = async () => {
    delete state.fit.regions[id];
    setDirty(true);
    await refresh();
  };
}

// --- the car ----------------------------------------------------------------
//
// The UV view answers "where on the sheet", which you can already see. It cannot
// answer the one that matters — is that spot flat, does anyone see it, does the
// number wrap over an arch — so the same texture goes onto the actual geometry.
//
// Everything here is lazy and optional. A profile without the car's kn5 beside
// it still edits perfectly well in UV; the 3D tab simply says why it cannot open.

/**
 * Wait for the browser to lay out what was just changed.
 *
 * A function declaration and defined above its caller, because this file has
 * produced three temporal-dead-zone bugs and one of them shipped.
 */
function nextFrame() {
  return new Promise((ok) => (window.requestAnimationFrame
    ? window.requestAnimationFrame(() => ok())
    : setTimeout(ok, 16)));
}

async function showView(which) {
  state.view = which;
  const is3d = which === '3d' || which === 'all';
  for (const [id, name] of [['#tab-uv', 'uv'], ['#tab-3d', '3d'], ['#tab-all', 'all']]) {
    $(id).className = `tab${which === name ? ' on' : ''}`;
  }
  $('#texture').hidden = is3d;
  $('#overlay').hidden = is3d;
  $('#carview').hidden = !is3d;
  if (!is3d) return;

  // Unhiding is not the same as being laid out. `hidden = false` takes effect on
  // the next frame, and until then the canvas is still 0x0 — and Firefox hands
  // back a null WebGL context for a zero-sized canvas, which this code reports
  // as "WebGL is unavailable in this browser". It is available; the canvas just
  // did not exist yet. Waiting one frame is the whole fix.
  await nextFrame();

  try {
    $('#viewnote').textContent = which === 'all' ? 'rendering every surface…' : 'loading…';
    if (which === 'all') await loadWholeCar();
    else await loadCarGeometry();
  } catch (e) {
    // No model is an ordinary situation, not a failure: plenty of people have a
    // profile for a car whose kn5 is not on this machine.
    $('#viewnote').textContent = `no 3D view — ${e.message}`;
    status(`3D unavailable for ${state.surface.file}`);
    $('#carview').hidden = true;
    $('#texture').hidden = false;
    $('#overlay').hidden = false;
    state.view = 'uv';
    $('#tab-uv').className = 'tab on';
    $('#tab-3d').className = 'tab';
    $('#tab-all').className = 'tab';
  }
}

/**
 * The whole car, with every painted surface on it at once.
 *
 * The per-surface view answers "did this land where I meant", and it is the
 * right view while dragging. It cannot answer "does this design work", because
 * a livery is not a texture — it is every texture at once, and a stripe that
 * meets the bodywork perfectly can still miss the sidepod next to it.
 *
 * The geometry is fetched once and kept; only the textures are re-rendered when
 * the fit changes. Anything the livery does not paint appears in flat grey,
 * because a car with holes where its glass should be reads as a broken export.
 */
async function loadWholeCar() {
  if (!state.viewer) {
    state.viewer = createViewer($('#carview'));
    state.viewer.attach();
  }
  if (!state.wholeGeometry) {
    const res = await fetch('/api/model?all=1');
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? 'no model for this car');
    }
    state.wholeGeometry = unpackModel(await res.arrayBuffer());
  }
  const g = state.wholeGeometry;
  const { surfaces } = await api('/api/preview', { fit: state.fit });
  await state.viewer.setWholeCar(g, surfaces);

  const painted = new Set(g.groups.filter((x) => x.role).map((x) => x.role));
  const bare = g.groups.filter((x) => !x.role).reduce((s, x) => s + x.count / 3, 0);
  $('#viewnote').textContent =
    `${(g.indices.length / 3).toLocaleString()} triangles · ${painted.size} painted surface` +
    `${painted.size === 1 ? '' : 's'}` +
    (bare ? ` · ${bare.toLocaleString()} triangles unpainted, shown grey` : '') +
    ' — drag to orbit, wheel to zoom';
}

/**
 * Fetch and upload the geometry for the surface being edited.
 *
 * The viewport deliberately shows only the parts THIS texture paints, so the
 * wheels are absent while you are editing the body. That is the honest framing —
 * you are looking at what you are painting — but it does surprise people, so the
 * note says how many pieces are on screen.
 */
async function loadCarGeometry() {
  if (!state.viewer) {
    state.viewer = createViewer($('#carview'));
    state.viewer.attach();
  }
  const res = await fetch(`/api/model?role=${encodeURIComponent(state.surface.role)}`);
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    // The driver, the helmet and the pit crew live in SEPARATE kn5 files that a
    // car skin overrides. There is genuinely no car geometry for them, and
    // showing the car wearing the suit would be worse than showing nothing.
    throw new Error(error ?? `no geometry for ${state.surface.file}`);
  }
  const geom = unpack(await res.arrayBuffer());
  state.viewer.setGeometry(geom);
  await paintCar();
  // Opening the 3D tab with something already selected should show it selected.
  // Without this the highlight only appeared once you touched the selection
  // again, which reads as the feature being broken rather than merely late.
  highlightOnCar(state.placed.find((p) => p.id === state.selected)?.abs ?? null);
  $('#viewnote').textContent =
    `${(geom.indices.length / 3).toLocaleString()} triangles painted by ${state.surface.file}` +
    ' — drag to orbit, wheel to zoom';
}

/**
 * Show the selected region on the car, if there is a car on screen to show it on.
 *
 * Cheap and silent when the 3D view has never been opened, which is the common
 * case: this runs on every selection and every drag frame, and a UV-only session
 * should not pay for a feature it is not looking at.
 */
function highlightOnCar(abs) {
  state.viewer?.setHighlight(abs);
}

async function paintCar() {
  if (!state.viewer || !state.svg) return;
  try {
    await state.viewer.setTexture(state.svg);
  } catch (e) {
    $('#viewnote').textContent = `texture: ${e.message}`;
  }
}

// --- chrome -----------------------------------------------------------------

function setDirty(v) {
  state.dirty = v;
  $('#save').disabled = !v;
  $('#status').className = v ? 'status dirty' : 'status';
}
function status(msg) {
  $('#status').textContent = state.dirty ? `${msg} — unsaved` : msg;
  // Also under the canvas, where the eyes already are. A hint in the far corner
  // of the header is a hint nobody reads while dragging.
  $('#canvashint').textContent = msg;
}
/** Escape for both text nodes and quoted attributes. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- boot, last -------------------------------------------------------------
//
// After every declaration, so no helper can be reached before it exists.
await selectSurface(0);
