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
// The same split the server makes, from the same file, so the two cannot drift.
import { treatmentOptions } from './fields.js';
import { paletteUses, tokenUses, danglingNames, eachRegion, interpolates, isAColour } from './uses.js';
import { applyDesignOp, applyFitOp, opSetConstraint } from './ops.js';

const $ = (s) => document.querySelector(s);
const VIEW = 1000;

const state = {
  data: null,        // /api/state
  surface: null,     // the surface being edited
  selected: null,    // region id
  fit: null,         // working copy, saved only on demand
  placed: [],        // where each region actually landed, from the server
  dirty: false,        // the fit has unsaved changes
  designDirty: false,  // and the design, tracked apart — see updateSaveButtons
  svg: '',           // the last render, reused as the 3D texture
  viewer: null,      // created lazily; a UV-only session never touches WebGL
  view: 'uv',
  hover: null,       // a panel being looked at, which must never become a change
  wholeGeometry: null, // the whole car, fetched once; only its textures change
  // Pairs the person has deliberately separated. Session-only on purpose: it is
  // a statement about how you are working right now, not about the design, and
  // the fit file has no business recording an editor mode. Once the two sides
  // differ, the fit already says so in the only way that matters.
  unlinked: new Set(),
  // Pairs the person declared. The id convention finds `driver-left` and
  // `driver-right` on its own, but a design free to name its regions anything
  // is free to name them `numberA` and `numberB`, and nothing should stop two
  // regions being treated as one idea just because nobody anticipated the
  // words. Session-only, like `unlinked`, and for the same reason.
  paired: new Map(),
  // Pairs severed outright, as opposed to merely unlinked. `unlinked` means
  // "these are two halves of one idea but I am editing them apart"; this means
  // "these are not a pair at all". The id convention cannot be argued with any
  // other way — there is no entry to delete.
  severed: new Set(),
  // --- undo -----------------------------------------------------------------
  //
  // SNAPSHOTS, not inverse operations. Everything this editor changes lives in
  // one plain JSON object plus three small session sets, and a fit is a few
  // kilobytes — so a clone per action is cheap, and "restore the previous
  // state" is obviously correct in a way that "apply the inverse of a move that
  // also rehosted a panel and dragged a mirrored twin across with it" is not.
  // Inverse operations would need an inverse for every action, and every one of
  // them is a chance to write an undo that ALMOST undoes.
  //
  // Bounded, because a long session should not grow without limit. Fifty is far
  // more than anyone reaches for and a few hundred kilobytes at worst.
  past: [],
  future: [],
};
const UNDO_LIMIT = 50;

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

// The working DESIGN, beside the working fit and for the same reason: it lives
// here until somebody saves it, and nothing in step one of authoring saves it.
// `lossy` is non-empty only for a livery carrying code, which cannot be edited
// as data — the editor says so rather than showing edits that would not build.
state.design = structuredClone(data.design);
state.lossy = data.lossy ?? [];
state.treatments = new Map((data.treatments ?? []).map((t) => [t.name, t]));

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
drawSurfaces();
$('#surface').onchange = () => selectSurface($('#surface').value);

// What you can add. Straight from the packs this design loads, so a pack brought
// in with --pack appears here without anything else knowing about it.
$('#newtreatment').innerHTML = '<option value="">add a region…</option>' + (data.treatments ?? [])
  .map((t) => `<option value="${esc(t.name)}">${esc(t.label)} — ${esc(t.pack)}</option>`).join('');
$('#newtreatment').onchange = () => { $('#addregion').disabled = !$('#newtreatment').value; };
$('#addregion').onclick = () => {
  const t = $('#newtreatment').value;
  // Returned, not fired and forgotten: the caller has to be able to wait for it,
  // and a handler that hides its promise is a race nobody can see.
  return t ? addRegion(t) : undefined;
};

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

$('#undo').onclick = () => undo();
$('#redo').onclick = () => redo();
// Ctrl/Cmd+Z, and Shift for the other direction. Ignored while typing in the
// inspector's number fields, where the browser's own undo is what is wanted.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (/^(input|textarea|select)$/i.test(e.target?.tagName ?? '')) return;
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

wireAdders();

// --- what this design would find on a car it has never been shown -----------
//
// A design's portability is invisible while you work on it, because you are
// looking at one car and everything resolves. `tags: ['left', 'mid']` and
// `panel: 'left_mid'` draw the same rectangle here; on the next car one finds
// the flank and the other finds nothing, and you learn which by building it and
// looking at a bare panel.
//
// A profile is the whole of what liverykit knows about a car, so a second
// opinion costs nothing — no model, no game install, nothing to download.
// Asking is a dropdown.
$('#othercar').onchange = () => checkAgainst($('#othercar').value);

async function loadOtherCars() {
  const r = await fetch('/api/cars').then((x) => x.json()).catch(() => null);
  if (!r?.cars?.length) return;
  $('#othercar').innerHTML = '<option value="">pick a car…</option>'
    + r.cars.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

async function checkAgainst(car) {
  const el = $('#portability');
  if (!car) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="hint">asking…</p>';

  // The WORKING design, not the file on disk. The question is about the edit in
  // front of you; answering about the saved copy would call a region portable
  // minutes after you pinned it.
  // A 404 is JSON too, and it carries an `error` rather than the report —
  // reading `.json()` and carrying on reached `r.regions.filter` on undefined
  // and threw, so the panel went blank on the one occasion it had something to
  // say. Every way this can fail becomes `fatal` here, in one place.
  const r = await fetch('/api/portability', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ car, design: state.design }),
  }).then(async (x) => {
    const body = await x.json().catch(() => ({}));
    if (!x.ok) return { fatal: body.error ?? `the editor answered ${x.status}` };
    if (!Array.isArray(body.regions)) return { fatal: body.fatal ?? 'the answer had no regions in it' };
    return body;
  }).catch((e) => ({ fatal: e.message }));

  if (r.fatal) { el.innerHTML = `<div class="note">! ${esc(r.fatal)}</div>`; return; }

  const missing = r.regions.filter((x) => x.status === 'missing');
  const absolute = r.regions.filter((x) => x.status === 'absolute');
  const matched = r.regions.filter((x) => x.status === 'matched');
  const absent = (r.surfaces ?? []).filter((s) => s.status === 'absent');
  const invalid = (r.surfaces ?? []).filter((s) => s.status === 'invalid');

  el.innerHTML = [
    `<div class="hint">${matched.length} of ${r.regions.length} regions land on
      ${esc(r.name)}.</div>`,
    // Named one by one, because the useful next action is to go and change a
    // particular region — a count tells you there is a problem and not where.
    ...missing.map((x) => `<div class="note">! <code>${esc(x.id)}</code> ${esc(x.why)}</div>`),
    ...invalid.map((s) => `<div class="note">! ${esc(s.from)}: ${esc(s.why)}</div>`),
    ...absent.map((s) => `<div class="note">${esc(s.from)} — this car has no such surface</div>`),
    // Neither a failure nor a pass. An absolute rectangle resolves on every car,
    // which is exactly why it is the placement most likely to be quietly wrong
    // on the next one; calling it fine would be the reassuring silence this
    // project exists to refuse.
    absolute.length
      ? `<div class="hint">${absolute.length} placed by coordinate, so they land somewhere on
         every car and nothing here can say whether it is the right somewhere.</div>`
      : '',
  ].join('');
}

// --- what is wrong with this design ON THIS car ------------------------------
//
// The panel above asks whether the placements FIND anything somewhere else.
// This asks whether the somewhere they found here is any good, which is a
// different question and the one you cannot answer by looking.
//
// You can see the car in the next tab and judge for yourself whether it looks
// right. What you cannot see, from any angle, is that a name is painted into
// the gap between two uv islands and exists on no triangle at all — it renders
// perfectly in the UV view and is simply not on the car. That is measurable and
// nothing was measuring it.
//
// Run on demand rather than on every edit. The geometry checks cast rays for
// every region and take about a second on a real car, and a panel that stalls
// the editor after each drag is a panel people turn off.
$('#recheck').onclick = () => checkFitment();

async function checkFitment() {
  const el = $('#fitment');
  el.innerHTML = '<p class="hint">measuring…</p>';

  const r = await fetch('/api/fitment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ design: state.design, fit: state.fit }),
  }).then(async (x) => {
    const body = await x.json().catch(() => ({}));
    if (!x.ok) return { fatal: body.error ?? `the editor answered ${x.status}` };
    if (!Array.isArray(body.findings)) return { fatal: 'the answer had no findings in it' };
    return body;
  }).catch((e) => ({ fatal: e.message }));

  if (r.fatal) { el.innerHTML = `<div class="note">! ${esc(r.fatal)}</div>`; return; }

  const rank = { fatal: 0, high: 1, low: 2 };
  const found = [...r.findings].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));

  // What was NOT checked comes first, and is stated even when the news is good.
  // "No findings" from a run that skipped the geometry is the same sentence as
  // "no findings" from a run that did all of it, and the two mean opposite
  // things — this is the whole reason the module reports `notChecked` at all.
  const skipped = r.notChecked?.length
    ? `<div class="note">! not checked: ${esc(r.notChecked.join(', '))}${
        r.modelError ? ` — ${esc(r.modelError)}` : ' — the car model is still loading; ask again'}</div>`
    : '';
  const unplaced = r.notPlaced?.length
    ? `<div class="note">! not placed at all: ${esc(r.notPlaced.join(', '))}</div>`
    : '';

  el.innerHTML = [
    skipped,
    unplaced,
    found.length
      ? ''
      : `<div class="hint">Nothing to report from ${esc((r.checked ?? []).join(', '))}.</div>`,
    // Named one at a time, worst first, because the useful next action is to go
    // and move a particular region and a count cannot tell you which.
    ...found.map((f) => {
      const cls = f.severity === 'low' ? 'hint' : 'note';
      const mark = f.severity === 'low' ? '' : '! ';
      const ids = (f.ids ?? []).map((i) => `<code>${esc(i)}</code>`).join(' ');
      return `<div class="${cls}">${mark}${ids} ${esc(f.why)}</div>`;
    }),
  ].join('');
}

$('#adoptsurface').onclick = () => adoptSurface($('#adoptsurface').dataset.role);

// Shading is on by default and switchable, because both answers are true.
//
// Shaded tells you whether the design works on the CAR — how a stripe crosses a
// curve, which panels the eye lands on, whether the whole thing reads at ten
// metres. Unshaded tells you what colour the paint actually IS, which shading
// necessarily distorts, and that was the original reason this viewer drew the
// raw texture. The UV tab is always the honest one; this switch is for the two
// tabs that draw geometry.
$('#lit').onchange = () => state.viewer?.setLit($('#lit').checked);

$('#tab-uv').onclick = () => showView('uv');
$('#tab-3d').onclick = () => showView('3d');
$('#tab-all').onclick = () => showView('all');
$('#tab-cockpit').onclick = () => showView('cockpit');

$('#save').onclick = async () => {
  await api('/api/fit', state.fit);
  setDirty(false);
  status('saved the fit');
};

// Separate from Save fit, and separate on purpose. One says where this car wants
// the artwork; the other says what the artwork IS, for every car. A single
// button would have to guess which you meant.
$('#savedesign').onclick = async () => {
  try {
    const out = await api('/api/design', state.design);
    state.designDirty = false;
    updateSaveButtons();
    status(`saved the design to ${out.saved.split('/').pop()}`);
  } catch (e) {
    status(`design not saved: ${e.message}`);
  }
};

// --- undo -------------------------------------------------------------------

/** Everything an action can change, as a value that can be put back. */
function snapshot() {
  return {
    fit: structuredClone(state.fit),
    // The working design too, now that an option change is an action. Undo has
    // always meant "put everything back", and a stack that restored half the
    // editor would be worse than none.
    design: structuredClone(state.design),
    paired: [...state.paired],
    unlinked: [...state.unlinked],
    severed: [...state.severed],
    selected: state.selected,
  };
}

function restore(snap) {
  state.fit = structuredClone(snap.fit);
  state.design = structuredClone(snap.design);
  state.paired = new Map(snap.paired);
  state.unlinked = new Set(snap.unlinked);
  state.severed = new Set(snap.severed);
  state.selected = snap.selected;
}

/**
 * Remember where things stood, and what the person is about to do.
 *
 * Called BEFORE an action, not after, so the stack holds states to return to
 * rather than states just arrived at. The label is for the status line: "undid
 * move number-left" is a different thing to read than "undid".
 *
 * A drag calls this once, on pointerdown. Calling it per pointermove would fill
 * the stack with fifty intermediate positions of one gesture and make undo mean
 * "go back four pixels".
 */
function remember(label) {
  state.past.push({ ...snapshot(), label });
  if (state.past.length > UNDO_LIMIT) state.past.shift();
  // A new action abandons the redo branch. Keeping it would let a redo jump to
  // a state that no longer follows from anything.
  state.future.length = 0;
  updateUndoButtons();
}

async function undo() {
  const snap = state.past.pop();
  if (!snap) return status('nothing to undo');
  state.future.push({ ...snapshot(), label: snap.label });
  restore(snap);
  await afterTimeTravel(`undid ${snap.label}`);
}

async function redo() {
  const snap = state.future.pop();
  if (!snap) return status('nothing to redo');
  state.past.push({ ...snapshot(), label: snap.label });
  restore(snap);
  await afterTimeTravel(`redid ${snap.label}`);
}

/**
 * Put the editor back in step with a fit that changed underneath it.
 *
 * Goes through reloadState because undo can restore a fit with a different SET
 * of regions — undoing a duplicate removes one, undoing a delete brings one
 * back — and the region list is the server's answer, not something the browser
 * can reconstruct.
 */
async function afterTimeTravel(msg) {
  setDirty(true);
  await reloadState();
  await refresh();
  updateUndoButtons();
  status(msg);
}

function updateUndoButtons() {
  const u = $('#undo'); const r = $('#redo');
  if (u) { u.disabled = !state.past.length; u.title = state.past.length ? `undo ${state.past.at(-1).label}` : ''; }
  if (r) { r.disabled = !state.future.length; r.title = state.future.length ? `redo ${state.future.at(-1).label}` : ''; }
}

// --- rendering --------------------------------------------------------------

/**
 * The surfaces this design paints, as options keyed by WHAT THEY ARE.
 *
 * Keyed by `from` — `surfaces.body`, `paint.ext_banner_colour` — and not by
 * position. The options used to carry their index, built once at boot, and the
 * list is not fixed: adopting a surface adds one, and `resolveTargets` walks
 * `paint` before `surfaces`, so the new entry arrives at the FRONT and shifts
 * every index below it.
 *
 * The select kept the old numbers. Picking `surfaces.body` then selected
 * whatever had taken position zero — the surface just adopted — and picking
 * `surfaces.tyres` got the body. Nothing was lost and the design was intact;
 * the editor was simply pointing at the wrong ones, which is worse, because
 * everything you did next was real and landed somewhere else.
 *
 * `from` is unique per surface: `resolveTargets` refuses two entries claiming
 * one texture, and each entry names the block it came from. So a value cannot
 * go stale by anything short of the surface ceasing to exist.
 */
function drawSurfaces() {
  const el = $('#surface');
  if (!el) return;
  el.innerHTML = state.data.surfaces
    .map((s) => `<option value="${esc(s.from)}">${esc(s.from)} — ${esc(s.file)}</option>`).join('');
  if (state.surface) el.value = state.surface.from;
}

async function selectSurface(from) {
  const found = state.data.surfaces.find((s) => s.from === from);
  if (!found) return status(`this design no longer paints ${from}`);
  state.surface = found;
  state.selected = null;
  drawPanels();
  await refresh();
  // The viewport shows the geometry THIS texture is painted on, so changing
  // surface has to reload it. Without this the car kept its old mesh and simply
  // wore the new texture — which is why picking the driver's suit showed the
  // car wearing the suit.
  if (state.view === '3d') await loadCarGeometry();
}

/**
 * Re-read what the surface contains, under the fit being worked on.
 *
 * Needed when the set of regions changes: creating a copy, deleting one, or
 * undoing either. Everything else moves regions around, and `/api/render`
 * already reports where they landed.
 *
 * POSTED with the working fit rather than GET. The saved snapshot is a different
 * fit — nothing here is written to disk until Save — so asking for it returned a
 * region list without the copy just made, and with the one just deleted still in
 * it. The copy would render on the car and be missing from the list: visible,
 * unselectable, undeletable.
 */
async function reloadState() {
  const was = state.surface?.from;
  state.data = await api('/api/state', { fit: state.fit, design: state.design });
  // By `from`, not by the index taken above: a design edit can add or remove a
  // surface, and `resolveTargets` walks `paint` before `surfaces`, so an index
  // from the old list points somewhere else in the new one.
  state.surface = state.data.surfaces.find((s) => s.from === was) ?? state.data.surfaces[0];
  drawSurfaces();
  drawPanels();
}

/** Re-render the texture and redraw everything over it. */
async function refresh() {
  const t0 = performance.now();
  let out;
  try {
    out = await api('/api/render', { fit: state.fit, design: state.design, role: state.surface.role });
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
  else if (state.view === 'cockpit') loadCockpit().catch((e) => status(`preview: ${e.message}`));
  drawOverlay();
  drawRegions();
  drawInspector();
  $('#fitjson').textContent = JSON.stringify(state.fit, null, 2);
  // Beside it, not instead of it. Seeing which file a change landed in is the
  // whole reason the two are edited separately.
  $('#designjson').textContent = JSON.stringify(state.design, null, 2);
  drawPalette();
  drawIdentity();
  drawDangling();
  drawAdders();
  $('#notes').innerHTML = out.notes
    .map((n) => `<div class="note">! ${esc(n.text)}</div>`).join('');
  // Derived from the stacks rather than trusted from the markup, so there is
  // one source of truth for whether there is anything to go back to.
  updateUndoButtons();
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

// --- palette and identity ---------------------------------------------------
//
// Both are design-level, both are small, and both are keyed by NAME — which is
// why they are worth editing here rather than in a text file. Changing `accent`
// re-renders every region that mentions it in about two milliseconds, so you
// find out what a colour does to a car by changing it and looking, rather than
// by imagining.
//
// The names are also the risk. A region refers to a palette entry by name and
// `ctx.color` passes an unknown one straight through to the renderer; a `{token}`
// with no value interpolates to nothing. Neither reports anything. So every row
// carries a count of what depends on it, and renaming rewrites the references
// rather than leaving them pointing at something that is gone.

function drawPalette() {
  const el = $('#palette');
  if (!el) return;
  if (state.lossy.length) { el.innerHTML = '<p class="hint">This livery contains code.</p>'; return; }

  const uses = paletteUses(state.design, state.treatments);
  el.innerHTML = Object.entries(state.design?.palette ?? {}).map(([name, value]) => {
    const by = uses.get(name) ?? [];
    // NO style attribute here. `esc` escapes HTML, and a style attribute is not
    // HTML — it is a list of declarations separated by semicolons, and a palette
    // value of `red;position:fixed;inset:0;z-index:9` would have survived `esc`
    // intact and become a page-sized invisible sheet over the editor that
    // swallows every click. That is not hypothetical here: the duplicate `id`
    // this project already fixed did exactly that, by accident, and the test
    // written for it is upstairs. A `background:url(https://…)` would also have
    // reached the network from a tool that binds to 127.0.0.1 on purpose.
    //
    // A livery is a file people SHARE, so its values are not this editor's to
    // trust. The swatch is filled in below through the CSSOM instead.
    return `<div class="named${by.length ? '' : ' unused'}">
      <span class="swatch" data-swatch="${esc(name)}"></span>
      <input data-palette="${esc(name)}" data-part="name" value="${esc(name)}">
      <input data-palette="${esc(name)}" data-part="value" value="${esc(value)}">
      <span class="uses" title="${esc(by.length ? by.join(', ') : 'nothing refers to this')}"
        >${by.length || '—'}</span>
    </div>`;
  }).join('');
  paintSwatches(el);
  wirePalette();
}

/**
 * Fill the swatches in through the CSSOM, which parses one value or none.
 *
 * `style.backgroundColor = v` accepts a colour and DROPS anything else on the
 * floor — a second declaration, a `url()`, a stray brace — because the setter
 * parses `v` as a single `<color>` rather than pasting it into the document.
 * Assigning it is the whole guarantee; the swatch simply stays empty for a value
 * that is not a colour, which is also the honest thing to show.
 */
function paintSwatches(el) {
  for (const sw of el.querySelectorAll?.('[data-swatch]') ?? []) {
    sw.style.backgroundColor = '';
    sw.style.backgroundColor = state.design?.palette?.[sw.dataset.swatch] ?? '';
  }
}

function drawIdentity() {
  const el = $('#identity');
  if (!el) return;
  // Said here as well as in the palette, because the row of disabled inputs
  // below this panel needs a reason standing next to it.
  if (state.lossy.length) { el.innerHTML = '<p class="hint">This livery contains code.</p>'; return; }

  const uses = tokenUses(state.design);
  el.innerHTML = Object.entries(state.design?.identity ?? {}).map(([token, value]) => {
    const by = uses.get(token) ?? [];
    return `<div class="named${by.length ? '' : ' unused'}">
      <span></span>
      <input data-token="${esc(token)}" data-part="name" value="${esc(token)}">
      <input data-token="${esc(token)}" data-part="value" value="${esc(value)}">
      <span class="uses" title="${esc(by.length ? by.join(', ') : 'no text mentions this')}"
        >${by.length || '—'}</span>
    </div>`;
  }).join('');
  wireIdentity();
}

/**
 * Names the design uses and does not define.
 *
 * The reason this panel is worth having. Both failures are invisible in the
 * render: an unknown colour reaches librsvg as a literal, and a token with no
 * value leaves a hole in the middle of a line of text.
 */
function drawDangling() {
  const el = $('#dangling');
  if (!el) return;
  if (state.lossy.length) { el.innerHTML = ''; return; }

  const { colours, tokens } = danglingNames(state.design, state.treatments);
  el.innerHTML = [
    ...tokens.map((t) => `<div class="note">Nothing gives <code>${esc(t.token)}</code> a value, so
      ${esc(t.by.join(', '))} ${t.by.length > 1 ? 'render' : 'renders'} with a hole where it should be.</div>`),
    ...colours.map((c) => `<div class="note"><code>${esc(c.name)}</code> is not in the palette, so it goes
      to the renderer as a literal colour — used by ${esc(c.by.join(', '))}.</div>`),
  ].join('');
}

function wirePalette() {
  const el = $('#palette');
  for (const input of el.querySelectorAll?.('[data-palette]') ?? []) {
    input.onchange = () => {
      const was = input.dataset.palette;
      const value = input.value ?? '';
      if (input.dataset.part === 'value') {
        // An empty colour is not "no opinion", it is a region painted with the
        // empty string. Nothing to fall back to, so nothing happens.
        if (!value.trim()) return status(`${was} needs a colour — left as it was`);
        remember(`recolour ${was}`);
        state.design.palette[was] = value.trim();
      } else {
        const now = value.trim();
        if (!now || now === was) return drawPalette();
        if (state.design.palette[now] !== undefined) return status(`there is already a colour called ${now}`);
        remember(`rename ${was}`);
        renamePalette(was, now);
      }
      return afterDesignEdit();
    };
  }
}

/**
 * The two Add rows, which sit OUTSIDE the panels they add to.
 *
 * That is deliberate — a row rebuilt on every redraw loses what you were part
 * way through typing — and it is also the reason they need their own handling of
 * a code-backed livery. `drawPalette` and `drawIdentity` empty themselves when
 * `state.lossy` is non-empty, because a design the editor cannot save is a design
 * it must not appear to be editing. The Add rows are not inside either panel, so
 * they survived that and stayed live: the editor said in one breath that this
 * livery could not be edited and in the next offered a button that edited it.
 *
 * `drawAdders` closes that, and the handlers refuse as well. The disabled
 * attribute is what a person sees; the check is what actually holds, since a
 * redraw is the only thing keeping the two in step.
 */
function drawAdders() {
  const off = state.lossy.length > 0;
  // Written out rather than looped over a list of names, so that every selector
  // here is a literal. "The page and the script agree about what exists" reads
  // the literal selectors out of this file and checks them against the page; one
  // assembled from a variable would be invisible to it, and a typo in it would
  // leave a control that silently never gets disabled.
  for (const el of [$('#newcolourname'), $('#newcolourvalue'), $('#addcolour'),
    $('#newtokenname'), $('#newtokenvalue'), $('#addtoken')]) {
    if (el) el.disabled = off;
  }
}

/** Wired once: the Add row is static, so it keeps whatever you have typed. */
function wireAdders() {
  {
    const add = $('#addcolour');
    add.onclick = () => {
      if (state.lossy.length) return status(CANNOT_EDIT);
      const name = ($('#newcolourname').value ?? '').trim();
      const value = ($('#newcolourvalue').value ?? '').trim();
      if (!name || !value) return status('a colour needs both a name and a value');
      if (state.design.palette?.[name] !== undefined) return status(`${name} is already taken`);
      remember(`add ${name}`);
      (state.design.palette ??= {})[name] = value;
      $('#newcolourname').value = '';
      $('#newcolourvalue').value = '';
      return afterDesignEdit();
    };
  }
  {
    const add = $('#addtoken');
    add.onclick = () => {
      if (state.lossy.length) return status(CANNOT_EDIT);
      const token = ($('#newtokenname').value ?? '').trim();
      if (!token) return status('a token needs a name');
      if (!interpolates(token)) return status(badTokenName(token));
      if (state.design.identity?.[token] !== undefined) return status(`${token} is already taken`);
      remember(`add ${token}`);
      (state.design.identity ??= {})[token] = $('#newtokenvalue').value ?? '';
      $('#newtokenname').value = '';
      $('#newtokenvalue').value = '';
      return afterDesignEdit();
    };
  }
}

const CANNOT_EDIT = 'this livery contains code, so the editor cannot change it';

/** Said the same way wherever a token is named, because it is the same rule. */
function badTokenName(token) {
  return `${token} could never be used: text interpolates {name} for letters, `
    + 'digits and underscores only, so this one would print its own braces.';
}

/**
 * Rename a colour, and every reference to it.
 *
 * The references are known — that is what `paletteUses` is for — so leaving them
 * pointing at a name that no longer exists would be choosing to break something
 * this code can see. A renamed entry with nothing updated renders as a literal
 * colour called `accent`, and says nothing about it.
 *
 * Key order is kept rather than moving the entry to the end. A palette is read
 * by people, and reshuffling it on a rename is a diff nobody asked for.
 */
function renamePalette(was, now) {
  const count = (paletteUses(state.design, state.treatments).get(was) ?? []).length;
  state.design.palette = Object.fromEntries(
    Object.entries(state.design.palette).map(([k, v]) => [k === was ? now : k, v]));

  for (const block of ['paint', 'surfaces']) {
    for (const spec of Object.values(state.design[block] ?? {})) {
      if (spec.background === was) spec.background = now;
    }
  }
  for (const { region } of eachRegion(state.design)) {
    for (const [key, v] of Object.entries(region)) {
      if (!holdsAColour(region, key)) continue;
      if (v === was) region[key] = now;
      else if (Array.isArray(v)) region[key] = v.map((x) => (x === was ? now : x));
    }
  }
  status(`renamed ${was} to ${now}, and the ${count} reference(s) to it`);
}

/** Would this option hold a colour? Ask the treatment; fall back to convention. */
function holdsAColour(region, key) {
  const described = state.treatments.get(region.treatment)?.options;
  if (described) return described[key]?.type === 'color' || described[key]?.type === 'colors';
  return key === 'color' || key === 'colors';
}

function wireIdentity() {
  const el = $('#identity');
  for (const input of el.querySelectorAll?.('[data-token]') ?? []) {
    input.onchange = () => {
      const was = input.dataset.token;
      if (input.dataset.part === 'value') {
        // An empty value is allowed and is not the same as absent: `country: ''`
        // is how the shipped designs say "this car has no country on it". The
        // dangling panel reports it either way, because both render as nothing.
        remember(`set ${was}`);
        state.design.identity[was] = input.value ?? '';
      } else {
        const now = (input.value ?? '').trim();
        if (!now || now === was) return drawIdentity();
        // Renaming to an uninterpolatable name is worse than creating one,
        // because the rewrite below would carry every working `{was}` over to a
        // `{now}` that prints itself. The panel goes back to what it was.
        if (!interpolates(now)) { status(badTokenName(now)); return drawIdentity(); }
        if (state.design.identity[now] !== undefined) return status(`${now} is already taken`);
        remember(`rename ${was}`);
        state.design.identity = Object.fromEntries(
          Object.entries(state.design.identity).map(([k, v]) => [k === was ? now : k, v]));
        // A token is referred to inside text, as `{was}`, so its references get
        // rewritten exactly as a colour's do.
        for (const { region } of eachRegion(state.design)) {
          if (typeof region.text === 'string') region.text = region.text.split(`{${was}}`).join(`{${now}}`);
        }
      }
      return afterDesignEdit();
    };
  }
}

async function afterDesignEdit() {
  setDesignDirty();
  await refresh();
}

// --- adding, removing and ordering the design's regions ---------------------

/** The block and key the current surface lives under, e.g. ['surfaces', 'body']. */
function surfaceHome() {
  const from = state.surface?.from ?? '';
  const dot = from.indexOf('.');
  return dot < 0 ? ['surfaces', from] : [from.slice(0, dot), from.slice(dot + 1)];
}

/** Is this region one the DESIGN declares here, as opposed to one a fit made? */
function ownRegion(id) {
  return (designRegions() ?? []).some((r) => r.id === id);
}

/** The design's own array of regions for the surface being edited. */
function designRegions() {
  const [block, where] = surfaceHome();
  const spec = state.design?.[block]?.[where];
  if (!spec) return null;
  spec.regions ??= [];
  return spec.regions;
}

/** A name nothing else is using, anywhere in the design. */
function freeRegionId(base) {
  const taken = new Set(state.data.surfaces.flatMap((s) => s.regions.map((r) => r.id)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Put a new region on the surface being edited.
 *
 * Placed on the selected region's panel where there is one, because that is
 * almost always where you are looking; otherwise on whatever the surface's first
 * panel is. Tags versus a panel NAME is the portability question and it is not
 * answered here — step four of the plan puts that choice in front of you.
 */
async function addRegion(treatment) {
  const regions = designRegions();
  if (!regions) return status('this surface is not part of the design');

  const sel = state.placed.find((p) => p.id === state.selected);
  const panel = sel?.panel ?? state.surface.panels[0]?.name;
  const id = freeRegionId(treatment);

  // PANEL OR TAGS, decided here and changeable afterwards in the inspector.
  // Naming the panel pins the region to this car's word for that island; naming
  // its tags says "the left flank, whatever this car calls it", which is the
  // entire reason `surfaces:` exists. Choosing silently would make one of those
  // the editor's opinion rather than the author's.
  //
  // The default follows what the design has already said about itself. A design
  // with a `car` field is FOR that car, and the exact name is the better answer.
  // One without has declared that it means to travel, and pinning it to
  // `left_mid` would be the editor undoing that declaration a region at a time.
  const tags = portableTags(panel);
  const placement = (state.design?.car || !tags.length) ? { panel } : { tags };

  remember(`add ${id}`);
  regions.push({
    id,
    treatment,
    ...(panel ? placement : {}),
    at: [0.25, 0.25, 0.5, 0.5],
  });
  setDesignDirty();
  await reloadState();
  await refresh();
  selectRegion(id);
  status(!panel
    // Nothing mapped on this surface, so the region went in with neither
    // `panel` nor `tags` and is a bare rectangle. "added fill on undefined" was
    // the editor reading its own variable out loud.
    ? `added ${id} as a plain rectangle — this surface has no panels mapped, so there was nothing to place it on`
    : placement.tags
      ? `added ${id} on tags [${placement.tags.join(', ')}] — portable, and Placement can pin it`
      : `added ${id} on ${panel} — pinned to this car, and Placement can free it`);
}

/**
 * The tags that would select this panel and not half the car.
 *
 * A panel carries everything measurement could say about it, and the full set is
 * usually too specific to travel — `['left', 'mid', 'upper', 'visible',
 * 'readable']` is a description of one island rather than a way of finding its
 * counterpart elsewhere. Equally, one tag is usually too broad: `['left']` on
 * the Abarth is most of the car's left side.
 *
 * So the default is the SIDE and the SECTION, which is the pair that identifies
 * a place on a car in the way a person means it — "left flank", "centre nose".
 * Anything else the panel carries is offered in the inspector and left unticked,
 * because the editor should not be inventing constraints nobody asked for.
 */
const SIDE = new Set(['left', 'right', 'centre', 'shared']);
const SECTION = new Set(['nose', 'front', 'mid', 'rear', 'tail', 'upper', 'lower']);

function portableTags(panelName) {
  const has = state.surface?.panels?.find((p) => p.name === panelName)?.tags ?? [];
  const side = has.filter((t) => SIDE.has(t));
  const section = has.filter((t) => SECTION.has(t));
  // A panel with no side and no section has nothing portable to say about
  // itself, and inventing a selection from whatever else it carries would be
  // worse than admitting that. The caller falls back to the panel name.
  return side.length || section.length ? [...side, ...section] : [];
}

/** Take a region out of the design, with everything the fit said about it. */
async function deleteDesignRegion(id) {
  const regions = designRegions();
  const i = regions?.findIndex((r) => r.id === id) ?? -1;
  if (i < 0) return status(`${id} is not one of this design's own regions`);

  remember(`delete ${id}`);
  regions.splice(i, 1);
  // The fit's opinion of a region that no longer exists is not worth keeping,
  // and would be reported as stale on every build until somebody removed it.
  delete state.fit.regions[id];
  for (const block of [state.fit.copies, state.fit.mirrors]) {
    for (const [k, v] of Object.entries(block ?? {})) if (v.of === id) delete block[k];
  }
  state.selected = null;
  setDesignDirty();
  setDirty(true);
  await reloadState();
  await refresh();
  status(`removed ${id} from the design`);
}

/**
 * Move a region in the array, which is the only way to change what covers what.
 *
 * Order IS paint order — later regions draw over earlier ones, and the emissive
 * layer composites above all of them — so "put the stripe under the numbers" is
 * an ordinary request that had no expression in the editor at all.
 */
async function moveRegion(id, by) {
  const regions = designRegions();
  const i = regions?.findIndex((r) => r.id === id) ?? -1;
  if (i < 0) return;
  const j = i + by;
  if (j < 0 || j >= regions.length) return status(`${id} is already ${by < 0 ? 'first' : 'last'}`);

  remember(`reorder ${id}`);
  const [moved] = regions.splice(i, 1);
  regions.splice(j, 0, moved);
  setDesignDirty();
  await reloadState();
  await refresh();
  selectRegion(id);
  status(`${id} now paints ${by < 0 ? 'earlier' : 'later'}`);
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
  // Hovering a panel shows that panel as its own boundary, so the same three
  // zones mean the same thing whether you are looking or working.
  if (rect) highlightOnCar(rect, name);
  else highlightOnCar(sel?.abs ?? null, sel?.panel, linkedTo(state.selected)[0]);
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
  highlightOnCar(sel?.abs ?? null, sel?.panel, linkedTo(state.selected)[0]);

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

/** The fit's copy entry for a region the FIT created, or null for a design's own. */
function copyEntry(id) {
  return state.fit.copies?.[id] ?? state.fit.mirrors?.[id] ?? null;
}

/**
 * The fit entry that holds this region's placement.
 *
 * Usually `regions[id]`: an override ON something the design declared. For a
 * region the fit CREATED it is the copy entry itself, because that entry is not
 * an override of anything — it is the whole of what that region is.
 *
 * Getting this wrong was invisible and then fatal. Every edit went to
 * `regions[id]`, which applyFit does not consult for a copy, so dragging a copy
 * appeared to do nothing and it snapped back on the next render. The entry
 * stayed behind, and validateFit refuses an id that is both a copy and an
 * override — so Save failed on a file the editor had written itself.
 */
function override(id) {
  const copy = copyEntry(id);
  if (copy) return copy;
  state.fit.regions[id] ??= {};
  return state.fit.regions[id];
}

/** Move the selected region onto a panel, keeping its shape where possible. */
async function movePanel(name) {
  if (!state.selected) return status('select a region first');
  const panel = state.surface.panels.find((p) => p.name === name);
  if (!panel) return;
  remember(`move ${state.selected} to ${name}`);
  // Deliberately does NOT require an existing placement: putting a region onto a
  // named panel is how you rescue one this car dropped or never matched.

  const o = override(state.selected);
  pinPanel(o, state.selected, name);
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

/**
 * Pointerdown on the car. Returns true to take the gesture from the camera.
 *
 * Dragging on the sheet means guessing how a rectangle will land on curved
 * bodywork, then switching tabs to find out. Dragging on the car removes the
 * guess: the region follows the texel under the cursor, so it goes where you
 * point, wherever the surface happens to bend.
 *
 * Only in the per-surface view. In the whole-car view a UV rectangle means
 * something different on each of twenty textures, so there is no single answer
 * to what the cursor is over, and pretending there is would move the wrong
 * region on the wrong sheet.
 */
/**
 * Clicking a part of the car the design does not paint.
 *
 * The whole-car view knows which texture every part uses — that is what the
 * per-texture groups are for — and the state knows which role each texture is.
 * Between them the editor can answer the question that otherwise costs an
 * afternoon: a car ships four plausible number-plate textures at 1024 square,
 * and telling them apart by name is guesswork, while pointing at the one on the
 * door is not.
 *
 * It OFFERS rather than acts. Adding a surface changes the design, and a click
 * that quietly did so — on a view whose main gesture is orbiting — would be the
 * editor making a decision on your behalf in the place you are least expecting
 * one.
 */
function offerToAdopt(group) {
  const row = $('#adopt');
  if (!row) return false;
  // `Object.hasOwn`, because `roles` arrives as JSON and is therefore an
  // ordinary object with an ordinary prototype. A texture called `constructor`
  // or `toString` is a legal filename, and a plain lookup would answer with a
  // function off the prototype — then read `.paintable` from it, get undefined,
  // and refuse to offer a surface for a reason that does not exist.
  const roles = state.data?.roles ?? {};
  const key = group?.file ? String(group.file).toLowerCase() : null;
  const known = key && Object.hasOwn(roles, key) ? roles[key] : null;

  // A part already painted is not an offer, it is where you are already working.
  if (!group || group.role !== null || !known) { row.hidden = true; return false; }

  if (!known.paintable) {
    // The profile already knows this one is a mistake: a normal map encodes
    // surface direction, a shader map encodes gloss. Painting either gives a car
    // that loads and lights wrongly, so this says so instead of offering.
    $('#adoptwhat').textContent = `${known.file} — ${known.why}`;
    $('#adoptsurface').hidden = true;
    row.hidden = false;
    return true;
  }

  $('#adoptwhat').textContent =
    `${known.file} (${known.width}×${known.height}) is not in this design.`;
  $('#adoptsurface').hidden = false;
  $('#adoptsurface').dataset.role = known.role;
  row.hidden = false;
  return true;
}

/**
 * Take an unpainted texture into the design.
 *
 * Written as `paint.<role>`, which names a texture role directly, rather than as
 * `surfaces.<term>`, which goes through the car's bindings. These are exactly the
 * surfaces with no binding and usually no panels — a banner or a number plate is
 * too small a share of the car to survive the panel threshold — so `paint` is
 * not a shortcut here, it is the only thing that addresses them at all.
 *
 * It arrives EMPTY, with no background. The whole sheet then renders as the
 * renderer's default black, which is the honest picture of what you have just
 * taken over: the stock artwork is gone and nothing has replaced it yet.
 */
async function adoptSurface(role) {
  if (!role) return;
  if (state.lossy.length) return status(CANNOT_EDIT);
  // Already painted, by ANY route. `resolveTargets` refuses a role claimed
  // twice — one write would silently overwrite the other — so adopting a role
  // the design reaches through `surfaces.<term>` would produce a design that
  // throws on the next render rather than one that paints two things.
  // Checked against the resolved surfaces, not just the `paint` block, because
  // the block is only one of the two ways in.
  if (state.data?.surfaces?.some((sf) => sf.role === role) || state.design?.paint?.[role]) {
    return status(`${role} is already painted by this design`);
  }

  // PROPOSED FIRST, applied only if it survives. The guard above sees the
  // editor's surface list, which holds the PRIMARY target of each term — so a
  // role claimed by some other route is invisible to it, and the design would
  // then fail to resolve on the very next request.
  //
  // The change is made on a COPY, the server is asked whether that copy
  // resolves, and `state.design` is replaced only once the answer is yes. A
  // design that cannot be rendered is therefore never the one you are holding,
  // and the failure is a sentence rather than an editor full of nothing.
  const next = structuredClone(state.design);
  (next.paint ??= {})[role] = { regions: [] };

  let data;
  try {
    data = await api('/api/state', { fit: state.fit, design: next });
  } catch (e) {
    return status(`could not paint ${role}: ${e.message}`);
  }

  remember(`paint ${role}`);
  state.design = next;
  state.data = data;
  $('#adopt').hidden = true;
  setDesignDirty();

  // The list has a new entry, so the picker has to be rebuilt before anything
  // selects from it — that ordering IS the bug this shipped with.
  drawSurfaces();
  const added = state.data.surfaces.find((sf) => sf.role === role);
  if (added) await selectSurface(added.from);
  else await refresh();
  status(`${role} is yours now — it renders black until you put something on it`);
}

export function claimCarPointer(uv, e) {
  // Only the whole-car view is excluded, and only for the reason above. The
  // condition used to be `view !== '3d'`, which is the same thing in practice —
  // the callback cannot fire when no car is on screen — but says something
  // broader than it means, and could not be tested without a GL context.
  // The whole-car view has no selection to drag, and one thing worth clicking:
  // a part the design does not paint. Answering `false` afterwards lets the
  // gesture go on to orbit, so pointing at something never costs you the drag.
  if (state.view === 'all' || state.view === 'cockpit') { offerToAdopt(uv?.group); return false; }
  if (!uv) return false;

  const sel = state.placed.find((p) => p.id === state.selected);
  const inside = (r) => uv.u >= r[0] && uv.u <= r[0] + r[2] && uv.v >= r[1] && uv.v <= r[1] + r[3];
  const area = (p) => p.abs[2] * p.abs[3];

  // The SMALLEST region containing the point, because regions stack: a fill
  // covering the whole panel sits under the number painted on it, and if the
  // larger won you could never click the number.
  const hit = state.placed.filter((p) => inside(p.abs)).sort((a, b) => area(a) - area(b))[0];
  if (!hit) return false;                        // bare bodywork: let it orbit

  // Clicking inside the selection drags it — except when something smaller sits
  // there too. Without that exception a region on top of the selected one became
  // unreachable the moment the one underneath it was selected, which is a
  // strange thing for a click to do and easy not to notice.
  if (!sel || !inside(sel.abs) || area(hit) < area(sel)) {
    if (hit.id !== state.selected) { selectRegion(hit.id); return true; }
  }

  const now = state.placed.find((p) => p.id === state.selected);
  if (!now) return false;

  // The far corner resizes, the rest moves — the same division the UV overlay
  // makes with its handle, without a handle to hit on a surface that curves.
  const [x, y, w, h] = now.abs;
  const corner = uv.u > x + w * 0.75 && uv.v > y + h * 0.75;
  startCarDrag(e, corner ? 'resize' : 'move', uv);
  return true;
}

/**
 * Drag a region across the car itself.
 *
 * Movement is measured in TEXTURE space, not screen space: each pointer event
 * asks what texel is under the cursor now, and the region moves by the
 * difference from the texel it started on. That is what makes it feel attached
 * to the surface — the same screen distance is a small step across a flat door
 * and a large one across a curved arch, exactly as the texture is stretched.
 *
 * A pointer that leaves the car keeps the last texel it had rather than
 * reporting nothing. Sliding off the bodywork mid-drag is ordinary; having the
 * region jump back to where the drag began because of it is not.
 */
function startCarDrag(e, mode, startUv) {
  e.preventDefault();
  const sel = state.placed.find((p) => p.id === state.selected);
  if (!sel) return;
  // Once per GESTURE. Remembering per pointermove would fill the stack with
  // intermediate positions and make undo mean "go back four pixels".
  remember(`${mode} ${sel.id}`);
  const start = { uv: startUv, abs: [...sel.abs] };
  let last = startUv;
  // Said at the moment of grabbing rather than on the first move, so a press
  // that catches the resize corner tells you so before you have committed to
  // dragging it somewhere.
  status(`${mode === 'move' ? 'moving' : 'resizing'} ${sel.id} on ${sel.panel ?? 'the texture'}`);

  const move = (ev) => {
    const uv = state.viewer?.pickUV(ev.clientX, ev.clientY) ?? last;
    last = uv;
    const dx = uv.u - start.uv.u;
    const dy = uv.v - start.uv.v;
    let [x, y, w, h] = start.abs;
    if (mode === 'move') { x += dx; y += dy; } else { w = Math.max(0.005, w + dx); h = Math.max(0.005, h + dy); }

    // Dragging onto a different panel takes the region with it. A car's
    // bodywork is split into islands that mean nothing to a person — a door and
    // the wing behind it are one surface to look at and two panels to address —
    // so a drag that stopped dead at an invisible boundary would be the tool
    // imposing its own bookkeeping. Only while MOVING: a resize that changed
    // which panel a region belonged to would be two edits in one gesture.
    if (mode === 'move') rehost(sel, uv);

    sel.abs = clampToPanel(sel, [x, y, w, h]);
    drawOverlay();
    // The artwork follows the pointer, not the release. Watching a rectangle
    // move and then finding out on mouseup whether the number actually fits is
    // the guessing this view exists to remove.
    writeFit(sel);
    setDirty(true);
    livePreview();
    status(`${mode === 'move' ? 'moving' : 'resizing'} ${sel.id} on ${sel.panel ?? 'the texture'}`);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    commit(sel);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/**
 * Move a region to whichever panel the cursor is now over.
 *
 * The smallest panel containing the point, for the same reason the smallest
 * region wins a click: panels overlap where instanced geometry shares a
 * rectangle, and the larger would swallow the more specific one.
 *
 * A point over no panel at all leaves the host alone rather than clearing it.
 * Textures have bare areas between islands, and passing over one on the way
 * somewhere else should not detach the region from its panel — `at` is
 * panel-relative, and a region with no host has nothing to be relative to.
 *
 * Returns whether it moved, so the caller can say so.
 */
function rehost(sel, uv) {
  const over = state.surface.panels
    .filter((p) => uv.u >= p.rect[0] && uv.u <= p.rect[0] + p.rect[2]
      && uv.v >= p.rect[1] && uv.v <= p.rect[1] + p.rect[3])
    .sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3])[0];
  if (!over || over.name === sel.panel) return false;
  sel.panel = over.name;
  return true;
}

/**
 * Keep a rectangle inside its panel.
 *
 * Not merely inside the texture: `at` is panel-relative and has to stay within
 * 0..1, so a region dragged past its panel's edge produces coordinates the
 * renderer rightly refuses — and a failed render used to take the whole editor
 * down with it.
 */
function clampToPanel(sel, [x, y, w, h]) {
  const host = state.surface.panels.find((p) => p.name === sel.panel);
  const [bx, by, bw, bh] = host ? host.rect : [0, 0, 1, 1];
  const cw = Math.min(w, bw);
  const ch = Math.min(h, bh);
  return [
    Math.min(Math.max(bx, x), bx + bw - cw),
    Math.min(Math.max(by, y), by + bh - ch),
    cw, ch,
  ];
}

function startDrag(e, mode) {
  e.preventDefault();
  const svg = $('#overlay');
  const box = svg.getBoundingClientRect();
  const sel = state.placed.find((p) => p.id === state.selected);
  if (!sel) return;
  remember(`${mode} ${sel.id}`);

  const start = { x: e.clientX, y: e.clientY, abs: [...sel.abs] };
  const toFrac = (dx, dy) => [dx / box.width, dy / box.height];

  const move = (ev) => {
    const [dx, dy] = toFrac(ev.clientX - start.x, ev.clientY - start.y);
    let [x, y, w, h] = start.abs;
    if (mode === 'move') { x += dx; y += dy; } else { w = Math.max(0.01, w + dx); h = Math.max(0.01, h + dy); }
    // The same crossing the car view allows. The sheet is where the panel
    // boundaries are actually visible, so refusing it here would be stranger.
    if (mode === 'move') rehost(sel, { u: x + w / 2, v: y + h / 2 });
    sel.abs = clampToPanel(sel, [x, y, w, h]);
    drawOverlay();
    writeFit(sel);
    setDirty(true);
    livePreview();
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
/**
 * Re-render the artwork mid-gesture, without redrawing the rest of the editor.
 *
 * Server-side rendering is 0.2 ms on the RSS4 and 1.3 ms on the Abarth, so the
 * cost is entirely in the browser: rasterising the SVG and uploading it. Two
 * things keep that inside a frame.
 *
 * COALESCED. One request in flight at a time; a position that arrives while one
 * is running replaces any other waiting one, and only the newest is drawn. A
 * queue would render every intermediate position of the pointer and fall
 * steadily further behind the hand holding it.
 *
 * SMALLER WHILE MOVING. 512 during the gesture rather than 1024. The difference
 * is invisible on a car turning under the cursor and it roughly quarters the
 * upload; the full size goes back on when the pointer is released.
 */
let previewing = false;
let previewPending = false;

async function livePreview() {
  if (previewing) { previewPending = true; return; }
  previewing = true;
  try {
    const out = await api('/api/render', { fit: state.fit, design: state.design, role: state.surface.role });
    state.svg = out.svg;
    // `placed` too: a drag that crosses onto another panel changes where the
    // MIRRORED half landed, and its highlight is drawn from this.
    state.placed = out.placed;
    // The surface's own size, not a guess. This is the view you judge a
    // placement in, and 512 for a 2048 sheet is where the fuzziness came from.
    if (state.view === '3d') {
      const t = state.data.surfaces.find((x) => x.role === state.surface.role);
      await state.viewer?.setTexture(out.svg, t?.width ?? 1024, t?.height ?? t?.width ?? 1024);
    }
    else $('#texture').innerHTML = out.svg;
    // Cheap, and the numbers changing under the cursor is how you learn what a
    // panel-relative coordinate actually means.
    $('#fitjson').textContent = JSON.stringify(state.fit, null, 2);
  // Beside it, not instead of it. Seeing which file a change landed in is the
  // whole reason the two are edited separately.
  $('#designjson').textContent = JSON.stringify(state.design, null, 2);
  drawPalette();
  drawIdentity();
  drawDangling();
  drawAdders();
  } catch {
    // A dropped frame mid-drag is not worth interrupting the gesture over. The
    // release does a full render and will report anything genuinely wrong.
  } finally {
    previewing = false;
    if (previewPending) { previewPending = false; livePreview(); }
  }
}

/** Write a placement into the working fit. No redraw — see commit. */
function writeFit(sel) {
  const panel = state.surface.panels.find((p) => p.name === sel.panel);
  const o = override(sel.id);
  o.at = panel ? toPanelRelative(panel.rect, sel.abs) : sel.abs.map(r4);

  pinPanel(o, sel.id, sel.panel);

  // The other side, if the design named one and the link is still on.
  //
  // The placement is MIRRORED, not copied. Copying assumes both islands were
  // unwrapped the same way round, which the RSS4 disproves: its two flanks run
  // in opposite directions, so a copied `at` moved the number forward on one
  // side and backward on the other. The flip is measured from the panels' own
  // recorded axes rather than assumed either way.
  for (const other of linkedTo(sel.id)) {
    const twin = override(other);
    const here = state.surface.panels.find((p) => p.name === sel.panel);
    // The twin FOLLOWS: it goes to the mirror of wherever this half landed,
    // not wherever it happened to be. Dragging one side onto the rear wing and
    // leaving the other on a flank splits an idea the design said was one.
    //
    // A panel with no mirror straddles the centreline — a nose, an engine
    // cover — so it is its own twin, and both halves live on it mirrored
    // within it. That is what a car with two numbers on its nose looks like.
    const there = state.surface.panels.find((p) => p.name === (here?.mirrorOf ?? sel.panel));
    const flips = !here || !there ? { u: false, v: false }
      : there.name === here.name ? selfMirrorFlips(here)
      : mirrorFlips(here, there);
    twin.at = mirrorAt(o.at, flips);
    if (o.rotate !== undefined) twin.rotate = mirrorRotation(o.rotate, flips);
    // Its own panel, not this one's. The whole point of the pair is that they
    // live on opposite sides; copying the panel across would stack both halves
    // on one flank, which renders perfectly and looks like the mirror broke.
    pinPanel(twin, other, there?.name);
  }
}

/**
 * Write it, and redraw everything. What the END of a gesture does.
 *
 * The moves in between call writeFit and livePreview directly, which updates
 * the artwork without rebuilding the region list, the inspector and the fit
 * JSON on every pointer event.
 */
async function commit(sel) {
  writeFit(sel);
  setDirty(true);
  await refresh();
}

/**
 * Record which panel a region now lives on — but only when the design disagrees.
 *
 * Pinning is needed in two cases: a region that reached this panel through TAGS,
 * which the next profile regeneration could otherwise re-match somewhere else
 * entirely; and a region moved onto a different panel, where the whole point of
 * the gesture is that it now lives there. Without it a drag across a boundary
 * records the new coordinates measured against the OLD panel — artwork in the
 * wrong place, from a fit that reads perfectly well.
 *
 * Moved BACK, the override goes away again rather than lingering as a pin onto
 * the panel the design already names. A fit is overrides only, and an entry that
 * restates the design is not merely noise: it opts this car out of any later
 * change to where the design puts that region, silently and for no reason
 * anybody chose.
 */
function pinPanel(o, id, name) {
  // A copy has no design behind it to fall back to: its entry IS its placement,
  // so the panel is not an override that can be dropped. Clearing it would send
  // the copy back to wherever its SOURCE happens to be, which is the one place
  // a copy is least likely to want to be.
  if (copyEntry(id)) {
    if (name) o.panel = name;
    return;
  }
  const declared = state.surface.regions.find((r) => r.id === id)?.panel;
  if (name && name !== declared) o.panel = name;
  else delete o.panel;
}

function r4(n) { return Math.round(n * 10000) / 10000; }

// --- copies of src/fit.mjs -------------------------------------------------
//
// The browser cannot import that module: it reads files, so it opens with
// `node:fs/promises` and the import would fail before any of this ran. These
// four are pure arithmetic and are duplicated deliberately rather than the
// module being split for the sake of it.
//
// Duplication is a liability, so it is held down by a test: `both copies of the
// mirror arithmetic agree` runs the same cases through this file and through
// fit.mjs and requires identical answers. A divergence would otherwise be
// invisible — the editor would place artwork one way and a rebuild from the CLI
// another, and the fit file would look fine in both.

function toPanelRelative(panelRect, abs) {
  const [px, py, pw, ph] = panelRect;
  if (!pw || !ph) return [0, 0, 1, 1];
  return [r4((abs[0] - px) / pw), r4((abs[1] - py) / ph), r4(abs[2] / pw), r4(abs[3] / ph)];
}

export function mirrorFlips(a, b) {
  const axis = (p, k) => (Array.isArray(p?.[k]) && p[k].length === 3 ? p[k] : null);
  const dot3 = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const flip = (k) => {
    const x = axis(a, k), y = axis(b, k);
    return x && y ? dot3([-x[0], x[1], x[2]], y) < 0 : false;
  };
  return { u: flip('uAxis'), v: flip('vAxis') };
}

export function selfMirrorFlips(panel) {
  const across = (k) => (Array.isArray(panel?.[k]) && panel[k].length === 3 ? Math.abs(panel[k][0]) : -1);
  const u = across('uAxis'), v = across('vAxis');
  if (u < 0 && v < 0) return { u: false, v: false };
  return { u: u >= v, v: v > u };
}

export function mirrorAt(at, flips) {
  const [x, y, w, h] = at;
  return [r4(flips.u ? 1 - x - w : x), r4(flips.v ? 1 - y - h : y), r4(w), r4(h)];
}

export function mirrorRotation(rotate, flips) {
  if (typeof rotate !== 'number' || !Number.isFinite(rotate)) return rotate;
  const t = (((rotate % 360) + 360) % 360);
  if (flips.u && flips.v) return (t + 180) % 360;
  if (flips.u) return (360 - t) % 360;
  if (flips.v) return (540 - t) % 360;
  return t;
}

// --- the design's own options ----------------------------------------------
//
// Everything above this line edits a FIT: where a region sits on one car. These
// edit the DESIGN: what the region is, on every car. Nothing here writes to
// disk — the working design goes with each render and is offered as JSON to
// paste, which is as far as step one of authoring goes on purpose.

/** The region the working design holds under this key, or null. */
function designRegion(id) {
  for (const block of [state.design?.paint, state.design?.surfaces]) {
    for (const [where, spec] of Object.entries(block ?? {})) {
      const prefix = block === state.design?.paint ? 'paint' : 'surfaces';
      const regions = spec.regions ?? [];
      for (const [i, r] of regions.entries()) {
        if ((r.id ?? `${prefix}.${where}#${i}`) === id) return r;
      }
    }
  }
  return null;
}

/**
 * One control per described option.
 *
 * A described option gets its own kind of input; an option the region carries
 * that nobody described still appears, as text, because the one thing you must
 * not hide is the thing already there and unexplained. `hint` is the code's own
 * default in prose and is shown as a placeholder — never written into the
 * design, so a design says only what somebody chose.
 */
function optionControls(id) {
  if (state.lossy.length) {
    return `<p class="note">This livery contains code (${esc(state.lossy.slice(0, 3).join(', '))}),
      so its options cannot be edited here — what you saw would not be what it builds.</p>`;
  }
  const region = designRegion(id);
  if (!region) return '';
  const t = state.treatments.get(region.treatment);
  const described = t?.options ?? null;
  // Two very different situations, and one message for both would be a lie.
  // A pack that described nothing still paints; a treatment name no pack
  // provides does not paint at all — renderTexture throws on it — so the design
  // is broken now rather than merely undocumented.
  const missingTreatment = region.treatment !== undefined && !t;
  const extra = Object.keys(treatmentOptions(region))
    .filter((k) => !described || !(k in described));

  const rows = Object.entries(described ?? {}).map(([key, o]) => {
    const v = region[key];
    const has = v !== undefined;
    const label = esc(o.label ?? key);
    const hint = o.hint ? ` placeholder="${esc(o.hint)}"` : '';
    let input;
    if (o.type === 'boolean') {
      input = `<button class="rot${v ? ' on' : ''}" data-opt="${esc(key)}" data-kind="boolean"
        >${v ? 'on' : has ? 'off' : esc(o.hint ?? 'off')}</button>`;
    } else if (o.type === 'enum') {
      input = `<select data-opt="${esc(key)}" data-kind="enum"><option value=""></option>${
        o.values.map((x) => `<option value="${esc(x)}"${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else if (o.type === 'color') {
      // `palette-names`, not `palette`: the panel on the right already owns that
      // id, this datalist sits inside #inspector which comes first in the
      // document, and querySelector takes the first — so the panel would have
      // quietly started writing its rows into a datalist.
      const names = Object.keys(state.design?.palette ?? {});
      // ONE button, and only for a value. There were two, and the second was
      // backwards: it offered to "name" a bare word like `ghost`, which would
      // write `palette.spooky = 'ghost'` and point the region at `spooky`. The
      // region still reaches librsvg as `fill="ghost"`, still paints nothing
      // anybody chose — and the dangling panel stops saying so, because `spooky`
      // is a palette entry now. A warning traded for nothing, which is worse
      // than the warning.
      //
      // The test is the dangling panel's own, imported rather than restated, so
      // the button appears exactly where that panel has nothing to say — one
      // judgement shown twice, rather than two regexes free to drift until they
      // give opposite advice about the same value in the same window.
      const nameable = has && typeof v === 'string' && !names.includes(v) && isAColour(v);
      input = `<input list="palette-names" data-opt="${esc(key)}" data-kind="string"
        value="${has ? esc(v) : ''}"${hint}>` +
        `<datalist id="palette-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>` +
        (nameable ? `<button class="rot" data-name-colour="${esc(key)}">name it</button>` : '');
    } else if (o.type === 'number') {
      const bounds = [o.min !== undefined ? `min="${o.min}"` : '', o.max !== undefined ? `max="${o.max}"` : '',
        o.step !== undefined ? `step="${o.step}"` : ''].join(' ');
      input = `<input type="number" ${bounds} data-opt="${esc(key)}" data-kind="number"
        value="${has ? esc(v) : ''}"${hint}>`;
    } else {
      // string, colors, rects: text, and JSON for the two that are not strings.
      const kind = o.type === 'string' ? 'string' : 'json';
      const shown = !has ? '' : kind === 'json' ? JSON.stringify(v) : v;
      input = `<input data-opt="${esc(key)}" data-kind="${kind}" value="${esc(shown)}"${hint}>`;
    }
    return `<label class="opt">${label}</label><div class="opt">${input}</div>`;
  }).join('');

  const unknown = extra.map((k) => `<label class="opt">${esc(k)}</label>
    <div class="opt"><input data-opt="${esc(k)}" data-kind="json"
      value="${esc(JSON.stringify(region[k]))}"></div>`).join('');

  return `<h3>${esc(t?.label ?? region.treatment ?? 'region')}</h3>
    ${t?.summary ? `<p class="hint">${esc(t.summary)}</p>` : ''}
    ${missingTreatment
      ? `<p class="note">No pack loaded by this design provides a treatment called
          <code>${esc(region.treatment)}</code>, so this region cannot be painted at all.
          Add its pack to <code>packs</code>, or change the treatment.</p>`
      : described === null && region.treatment
        ? `<p class="hint">Nothing describes this treatment, so its options are shown as raw values.</p>`
        : ''}
    ${rows}${unknown}
    <div class="row" style="margin-top:8px"><button id="copyregion">Copy region as JSON</button></div>
    <p class="hint">These change the DESIGN, on every car. Nothing is saved yet — copy the
      JSON into your livery.</p>`;
}


/**
 * Parse what an input gives back, by the kind the control declared.
 *
 * Three outcomes, not two, and the distinction matters. An EMPTY field means
 * "no opinion" and removes the key, which is how you get back to the treatment's
 * own default. Something unparseable means the person is mid-thought — half a
 * JSON array, a minus sign on its own — and must change nothing at all.
 *
 * Collapsing those two was quietly destructive: typing over an existing value
 * erased it the moment the intermediate text stopped parsing, and the only way
 * to notice was that the artwork changed while you were still typing.
 */
function readControl(el) {
  const kind = el.dataset.kind;
  const raw = el.value ?? '';
  if (raw.trim() === '') return { ok: true, value: undefined };
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: 'not a number' };
  }
  if (kind === 'json') {
    try { return { ok: true, value: JSON.parse(raw) }; }
    catch (e) { return { ok: false, why: e.message }; }
  }
  return { ok: true, value: raw };
}

/**
 * What this region needs, wherever it ends up.
 *
 * On the DESIGN, beside the treatment options, and not in the fit — which is
 * the whole point of them. "This is a team name, keep artwork off it and never
 * shrink it below 40 mm" is true of the design on every car; a fit that
 * restated it per car would be three cars from wrong.
 *
 * Only offered for a region the design actually owns. A copy created by a fit
 * has no design entry to write to, and a control that silently wrote nowhere
 * would be worse than no control.
 */
function constraintControls(id) {
  const region = designRegion(id);
  if (!region) return '';
  const c = region.constraints ?? {};
  const has = (k) => c[k] !== undefined;

  return `<label>needs</label>
    <p class="hint">Checked by the fit report, on this car and every other one.</p>
    <div class="row">
      <label><input type="checkbox" data-con="keepClear"${c.keepClear ? ' checked' : ''}>
        keep clear</label>
    </div>
    <div class="row">
      <label>at least <input data-con="minMm" size="4"
        value="${has('minMm') ? esc(c.minMm) : ''}" placeholder="mm"> mm on the car</label>
    </div>
    <div class="row">
      <label>at least <input data-con="minOnCar" size="4"
        value="${has('minOnCar') ? esc(Math.round(c.minOnCar * 100)) : ''}"
        placeholder="%"> % on bodywork</label>
    </div>`;
}

function wireConstraintControls(id) {
  const inspector = $('#inspector');
  for (const el of inspector.querySelectorAll?.('[data-con]') ?? []) {
    const key = el.dataset.con;
    const write = (value) => {
      remember(`${key} on ${id}`);
      // The op VALIDATES and throws, rather than writing a constraint nothing
      // enforces. A misspelled or out-of-range one is invisible until something
      // violates it, so it has to be refused where it is typed.
      try {
        opSetConstraint(state.design, { id, key, value });
      } catch (e) {
        return status(e.message);
      }
      setDesignDirty();
      return refresh();
    };
    if (key === 'keepClear') {
      el.onchange = () => write(el.checked ? true : null);
      continue;
    }
    el.onchange = () => {
      const raw = String(el.value ?? '').trim();
      if (!raw) return write(null);                    // cleared means no constraint
      const n = Number(raw);
      if (!Number.isFinite(n)) return status(`${key}: ${JSON.stringify(raw)} is not a number`);
      // Shown as a percentage because that is how the finding reads back;
      // stored as the fraction the checker actually compares against.
      return write(key === 'minOnCar' ? n / 100 : n);
    };
  }
}

function wireOptionControls(id) {
  const inspector = $('#inspector');
  const region = designRegion(id);
  if (!region) return;

  const change = async (key, value) => {
    remember(`${key} on ${id}`);
    if (value === undefined) delete region[key]; else region[key] = value;
    setDesignDirty();
    await refresh();
  };

  for (const el of inspector.querySelectorAll?.('[data-opt]') ?? []) {
    const key = el.dataset.opt;
    if (el.dataset.kind === 'boolean') {
      el.onclick = () => change(key, region[key] ? undefined : true);
    } else {
      el.onchange = () => {
        const read = readControl(el);
        // A no-op, and said out loud. Silently keeping the old value would look
        // exactly like the edit having been accepted.
        if (!read.ok) return status(`${key}: ${read.why} — left as it was`);
        return change(key, read.value);
      };
    }
  }

  for (const [sel, by] of [['#earlier', -1], ['#later', 1]]) {
    const el = inspector.querySelector?.(sel);
    if (el) el.onclick = () => moveRegion(id, by);
  }
  const remove = inspector.querySelector?.('#removeregion');
  if (remove) remove.onclick = () => deleteDesignRegion(id);

  // Turn a one-off colour into a palette entry, and point the region at it.
  // This is the loop closing: pick a colour on a region, name it, and everything
  // else in the design can use it — which is how a palette gets built in
  // practice rather than written out in advance.
  for (const el of inspector.querySelectorAll?.('[data-name-colour]') ?? []) {
    el.onclick = () => {
      const key = el.dataset.nameColour;
      const value = region[key];
      const name = (typeof prompt === 'function' ? prompt(`Call ${value} what?`) : '')?.trim();
      if (!name) return status('a palette entry needs a name');
      if (state.design.palette?.[name] !== undefined) return status(`${name} is already taken`);
      remember(`name ${value}`);
      (state.design.palette ??= {})[name] = value;
      region[key] = name;
      setDesignDirty();
      return refresh();
    };
  }

  const copy = inspector.querySelector?.('#copyregion');
  if (copy) {
    copy.onclick = () => {
      const text = JSON.stringify(region, null, 2);
      navigator.clipboard?.writeText?.(text);
      status(`copied ${id} as JSON`);
    };
  }
}

/**
 * Quarter turns, and `auto`.
 *
 * Quarter turns only, deliberately. An unwrapper lays panels out at right
 * angles to each other — a door packed sideways to save sheet space is the
 * common case — so every rotation anyone actually needs is one of four, and a
 * continuous control would mostly be a way to end up at 87 degrees by accident.
 *
 * `auto` is not a fifth angle, it is the absence of an opinion: the renderer
 * uses the panel's own measured `textRotation`, which is usually right and is
 * the only choice that keeps working when the design moves to another car.
 * It is offered first for that reason.
 */
function rotationChoices(id, def, o) {
  const current = o.rotate ?? def?.rotate ?? 'auto';
  return ['auto', 0, 90, 180, 270].map((v) => {
    const on = String(current) === String(v);
    return `<button class="rot${on ? ' on' : ''}" data-rotate="${v}"
      ${on ? 'aria-pressed="true"' : ''}>${v === 'auto' ? 'auto' : `${v}°`}</button>`;
  }).join('');
}

/**
 * The link to a region's opposite number, and the switch that breaks it.
 *
 * Linked is the default because a design that named `driver-left` and
 * `driver-right` has said they are one idea, and moving one and then hunting
 * for the other to match it by hand is exactly the fiddliness this tool exists
 * to remove. Breaking it has to be one click, though: a livery where the two
 * sides deliberately differ is not a mistake, it is most of what makes a livery
 * worth looking at.
 */
/**
 * Everything about this region's other half, in one stable block.
 *
 * The controls do not appear and disappear with the state; they are always
 * there and DISABLED when they would do nothing. A row of buttons that changes
 * shape depending on what is selected makes you re-read it every time, and a
 * control you have never seen enabled is a feature you do not know exists.
 */
function mirrorControl(id) {
  const other = partnerOf(id);
  const linked = other && !state.unlinked.has(id) && !state.unlinked.has(other);
  // Only regions that are free to be paired. A pairing is two-way and each half
  // holds one partner, so offering a region that already has one would overwrite
  // its side of that pair and leave the abandoned third region still pointing
  // back — after which the two halves disagree about who their partner is, and
  // an edit propagates one way and not the other.
  const candidates = state.surface.regions
    .filter((r) => r.id !== id && r.id !== other && !partnerOf(r.id))
    .map((r) => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('');

  // "Mirror now" is a one-shot copy across, so it has nothing to do when the
  // two sides ALREADY agree. Disabling it on "has a counterpart" would disable
  // it exactly whenever it was possible, which cannot be what anyone means.
  const stale = other ? !alreadyMirrored(id, other) : false;
  const off = (yes) => (yes ? ' disabled' : '');

  return `
    <label>mirror</label>
    <div class="row">
      <button id="mirror"${off(!other)} data-linked="${!!linked}">${
        other ? (linked ? 'linked' : 'independent') : 'not paired'}</button>
      <span class="muted">${other ? esc(other) : 'no counterpart'}</span>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="mirrornow"${off(!stale)}>Mirror now</button>
      <button id="unpair"${off(!other)}>Unpair</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="mirrorcreate"${off(!!other)}>Create mirrored copy</button>
      <button id="duplicate">Duplicate</button>
    </div>
    <div class="row" style="margin-top:6px">
      <select id="pairwith"${off(!!other)}>
        <option value="">pair with…</option>${candidates}</select>
    </div>
    <p class="hint">${other
      ? (linked ? 'Moving, resizing or rotating this also moves its opposite number.'
        : 'Edits affect this side only.')
      : 'A copy takes its artwork from this region and appears on the opposite panel.'}</p>`;
}

/**
 * Whether the two halves are already in mirrored positions.
 *
 * Compared through the same arithmetic that would place them, so "already
 * mirrored" means exactly "mirroring again would change nothing" rather than
 * some second opinion about it.
 */
function alreadyMirrored(id, other) {
  const a = state.placed.find((p) => p.id === id);
  const b = state.placed.find((p) => p.id === other);
  if (!a || !b) return false;
  const here = state.surface.panels.find((p) => p.name === a.panel);
  const there = state.surface.panels.find((p) => p.name === b.panel);
  if (!here || !there) return false;
  const flips = there.name === here.name ? selfMirrorFlips(here) : mirrorFlips(here, there);
  const want = mirrorAt(toPanelRelative(here.rect, a.abs), flips);
  const have = toPanelRelative(there.rect, b.abs);
  if (!want.every((n, i) => Math.abs(n - have[i]) < 0.001)) return false;

  // Rotation as well as rectangle. Mirroring propagates both, so comparing only
  // the rectangle called a pair "already mirrored" — and disabled Mirror now —
  // while one half sat at an angle the other did not. Which is precisely the
  // state that button exists to repair.
  const mine = resolvedRotation(id);
  const theirs = resolvedRotation(other);
  if (mine === undefined && theirs === undefined) return true;
  return mirrorRotation(mine ?? 0, flips) === (theirs ?? 0);
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
  // The entry that actually holds this region's placement: for a copy that is
  // the copy itself, not an override on a design region that does not exist.
  const o = copyEntry(id) ?? state.fit.regions[id] ?? {};

  if (!sel) {
    el.className = '';
    // A copy can fail to place too — a panel that went away, or a source the fit
    // dropped. It still has to be removable, and Drop and Reset are both
    // nonsense for it: there is no design to drop it from or reset it to, and
    // `drop` on a copy is a file validateFit refuses to load.
    const why = copyEntry(id)
      ? `A copy of <code>${esc(def?.fromFit ?? '?')}</code> that could not be placed on this car.`
      : o.drop
        ? 'Dropped on this car by the fit.'
        : `Nothing on this car matches ${def?.tags ? `[${esc(def.tags.join(', '))}]` : 'this region'}.`;
    el.innerHTML = `
      <div><code>${esc(id)}</code></div>
      ${derivedNote(id)}
      <p class="hint">${why} There is nothing to drag until it is placed.</p>
      <div class="row" style="margin-top:10px">
        ${def?.fromFit
          ? '<button id="delete">Delete</button>'
          : `<button id="drop">${o.drop ? 'Restore on this car' : 'Drop on this car'}</button>
             <button id="reset">Reset</button>`}
      </div>
      <p class="hint">Or click a panel on the right to place it there.</p>
      ${optionControls(id)}
    ${constraintControls(id)}`;
    wireInspectorButtons(id);
    // The options too. A region with no placement is exactly where you might
    // need them: its treatment may be why it is not on the car, and the
    // inspector already exists to work hardest when there is nothing on screen.
    wireOptionControls(id);
    return;
  }
  el.className = '';
  el.innerHTML = `
    <div><code>${esc(sel.id)}</code></div>
    ${derivedNote(sel.id)}
    <label>panel</label><div>${sel.panel ? esc(sel.panel) : '<span class="muted">absolute</span>'}</div>
    ${placementControl(id, sel)}
    <label>anisotropy</label><div>${sel.anisotropy.toFixed(2)}
      ${sel.anisotropy > 1.15 || sel.anisotropy < 0.87
        ? '<span class="note">stretched — text is pre-compensated, art is not</span>' : ''}</div>
    ${onTheCar(sel)}
    <label>at (panel-relative)</label>
    <div><code>${(o.at ?? []).map((n) => n.toFixed(3)).join(', ') || 'from the design'}</code></div>
    <label>rotation</label>
    <div class="row">${rotationChoices(id, def, o)}</div>
    ${mirrorControl(id)}
    ${optionControls(id)}
    ${constraintControls(id)}
    <div class="row" style="margin-top:10px">
      ${def?.fromFit
        ? '<button id="delete">Delete</button>'
        : `<button id="drop">${o.drop ? 'Restore' : 'Drop on this car'}</button>
           <button id="reset">Reset</button>`}
    </div>
    ${ownRegion(id) ? `<div class="row" style="margin-top:6px">
      <button id="earlier">Paint earlier</button>
      <button id="later">Paint later</button>
      <button id="removeregion">Remove from design</button>
    </div>` : ''}
    ${def?.fromFit ? `<p class="hint">A copy of <code>${esc(def.fromFit)}</code>,
      added by this fit. Deleting removes it; there is no design behind it to
      restore it to.</p>` : ''}`;

  wireInspectorButtons(sel.id);
  wireOptionControls(sel.id);
  wireConstraintControls(sel.id);
}

/**
 * Warn when a region is addressed by position rather than by name.
 *
 * A positional key shifts meaning if the livery gains a region above it, and the
 * fit then adjusts the wrong thing. The remedy is one line in the design, so it
 * is worth saying every time rather than burying in documentation.
 */
/**
 * How big this region actually is on the car.
 *
 * The one question the UV sheet cannot answer and the 3D view can only answer by
 * eye. Every other number in this panel is a fraction of an image — `at` is
 * panel-relative, the overlay is texture-relative, and none of them tell you
 * whether the sponsor you just placed comes out the size of a postcard or the
 * size of a door. The profile measures it; this is where it gets said.
 *
 * Silent when the profile predates the measurement rather than showing a zero or
 * a dash, because an empty row invites the reader to wonder what it means. The
 * hint says which profiles are in that state and what to do about it, once, on
 * the region where the question came up.
 */
function onTheCar(sel) {
  const row = (body) => `<label>on the car</label><div class="muted">${body}</div>`;

  // TWO reasons there can be no answer, wanting different things done about
  // them. Both arrive as `metres: null`, and one message covering both would
  // send somebody off to rebuild a profile that is already fine — and leave
  // them no wiser when the number still does not appear.
  //
  // No panel means no measurement CAN exist. `metresPerUv` belongs to a panel,
  // an absolute rectangle is not on one, and panels on a single car differ in
  // scale by more than a factor of ten, so there is nothing honest to fall back
  // to. A fact about the placement, not about the profile.
  if (!sel.panel) {
    return row('placed by coordinate, so no panel measures it — put it on a panel to find out');
  }
  if (!sel.metres) {
    return row(`this profile has no measurement for <code>${esc(sel.panel)}</code> —
      regenerate it with <code>--from-kn5</code>`);
  }
  const mm = (m) => (m < 1 ? `${Math.round(m * 1000)} mm` : `${m.toFixed(2)} m`);
  return `<label>on the car</label><div>${mm(sel.metres.w)} × ${mm(sel.metres.h)}</div>`;
}

/**
 * Switch a region between naming a panel and naming tags.
 *
 * The two are mutually exclusive in the format — `expandRegions` throws on a
 * region carrying both, and rightly, since they are two different answers to one
 * question — so this deletes as it writes. Getting that wrong would produce a
 * design the editor renders happily and the build refuses, which is the worst
 * available outcome and the reason it is done in one place.
 */
async function setPlacement(id, mode) {
  const region = (designRegions() ?? []).find((r) => r.id === id);
  if (!region) return status(`${id} is not one of this design's own regions`);
  const sel = state.placed.find((p) => p.id === id);
  let said;

  if (mode === 'panel') {
    if (region.tags === undefined) return;
    // Whichever panel it is actually on. A tag region can be on several, and
    // pinning it has to pick one — the selected placement is the one under the
    // cursor, so it is the one the person means.
    const panel = sel?.panel ?? state.surface.panels[0]?.name;
    if (!panel) return status('there is no panel here to pin it to');
    remember(`pin ${id}`);
    delete region.tags;
    delete region.limit;
    region.panel = panel;
    said = `${id} is pinned to ${panel} — exact here, absent on any other car`;
  } else {
    const tags = portableTags(sel?.panel ?? region.panel);
    if (!tags.length) return status(`${region.panel ?? 'this panel'} carries no tags to select it by`);
    remember(`free ${id}`);
    delete region.panel;
    region.tags = tags;
    said = `${id} now selects [${tags.join(', ')}] — adjust below and watch the count`;
  }
  setDesignDirty();
  await reloadState();
  await refresh();
  selectRegion(id);
  // AFTER the render, not before it. `refresh` finishes by writing its own
  // timing into the status line, so a message set first is shown for two
  // milliseconds and then replaced by "rendered in 0 ms" — which is how the
  // editor came to have several explanations nobody has ever read.
  status(said);
}

/**
 * Add or remove one tag from a region's selection.
 *
 * Removing the last one is refused rather than written. `tags: []` matches EVERY
 * panel, because `every` on an empty list is vacuously true — `expandRegions`
 * throws on it for that reason, and an editor that could write it would be
 * offering a click that makes the design unbuildable.
 */
async function toggleTag(id, tag) {
  const region = (designRegions() ?? []).find((r) => r.id === id);
  if (!region?.tags) return;
  const next = region.tags.includes(tag)
    ? region.tags.filter((t) => t !== tag)
    : [...region.tags, tag];
  if (!next.length) return status('a tag selection needs at least one tag — an empty one matches everything');

  remember(`tags ${id}`);
  region.tags = next;
  setDesignDirty();
  await reloadState();
  await refresh();
  selectRegion(id);
}

/**
 * Panel or tags, for a region the DESIGN owns.
 *
 * The difference the whole of `surfaces:` turns on, and until now it was
 * invisible: a region said `panel: 'left_mid'` or `tags: ['left', 'mid']` in a
 * file, and the editor drew the same rectangle either way. So a design's
 * portability could only be discovered by pointing it at a second car, which is
 * both late and hard to tell apart from the tool being broken.
 *
 * A switch rather than a question asked once at placement, because the answer is
 * genuinely revisable — a region drawn exactly where this car needs it often
 * turns out to belong everywhere, and the reverse happens too. And because the
 * count underneath is what makes tags trustworthy: switching re-renders, and the
 * editor then reports how many panels the RENDERER put it on rather than its own
 * opinion of how many it should have.
 *
 * Only for design regions. A fit may not change a placement rule — that is the
 * boundary the authoring plan is built on — so a fit-created copy shows where it
 * landed and no switch.
 */
function placementControl(id, sel) {
  if (!ownRegion(id)) return '';
  const region = (designRegions() ?? []).find((r) => r.id === id);
  if (!region) return '';

  const onTags = region.tags !== undefined;
  const landed = state.placed.filter((p) => p.id === id).length;
  const known = state.surface?.panels?.find((p) => p.name === sel.panel)?.tags ?? [];
  const chosen = onTags ? (region.tags ?? []) : portableTags(sel.panel);

  // A region on NEITHER is placed by coordinate, and there is no third button
  // for that. Showing the switch implied it was pinned, and "this panel" was a
  // button with nothing to pin to — the region is not on a panel, so `sel.panel`
  // is null and `setPlacement` returned without doing anything. It says what it
  // is instead, and what that costs, which is what somebody weighing
  // portability actually needs to know.
  if (!onTags && region.panel === undefined) {
    return `<label>placement</label>
      <div class="hint">a rectangle in the texture, on no panel — it lands
      <em>somewhere</em> on every car, and nothing can say whether that
      somewhere is the right one.</div>`;
  }

  const choice = `<div class="row">
    <button class="rot${onTags ? '' : ' on'}" data-place="panel">this panel</button>
    <button class="rot${onTags ? ' on' : ''}" data-place="tags"${known.length ? '' : ' disabled'}>by tags</button>
  </div>`;

  if (!onTags) {
    return `<label>placement</label>${choice}
      <div class="hint">pinned to <code>${esc(sel.panel ?? 'nothing')}</code>, which is this car's
      name for it — another car gets nothing here.</div>`;
  }

  // Every tag the panel under this region carries, lit where the region uses it.
  // Offered from the PANEL rather than from a fixed list, because tags are
  // measured per car and a menu of names this car does not use would be a menu
  // of ways to select nothing.
  const boxes = known.map((t) => `<button class="rot${chosen.includes(t) ? ' on' : ''}"
    data-tag="${esc(t)}">${esc(t)}</button>`).join(' ');

  return `<label>placement</label>${choice}
    <div class="row">${boxes}</div>
    <div class="hint">${landed
      ? `${landed === 1 ? 'one panel' : `${landed} panels`} on this car — portable: another car
         gets whatever it tags the same way`
      : '<strong>nothing on this car</strong> — and so nothing on any other either'}</div>`;
}

function derivedNote(id) {
  const r = state.surface.regions.find((x) => x.id === id);
  if (!r?.derived) return '';
  return `<p class="note">Addressed by position. Give this region an <code>id</code>
    in the livery, or inserting another region above it will move what this fit
    refers to.</p>`;
}

/**
 * Remove a copied region and everything descended from it. Returns the ids.
 *
 * Both spellings of the block, because a fit written before `copies` existed
 * says `mirrors` and both still load — so looking in one of them deletes half
 * of what was asked for.
 */
function deleteCopies(id) {
  const blocks = [state.fit.copies, state.fit.mirrors];
  const gone = new Set([id]);
  for (const block of blocks) delete block?.[id];
  // Breadth-first rather than one pass: a copy of a copy of the deleted region
  // is descended from it too, and one pass only reaches the children.
  for (const dead of gone) {
    for (const block of blocks) {
      for (const [k, v] of Object.entries(block ?? {})) {
        if (v.of !== dead || gone.has(k)) continue;
        gone.add(k);                       // the loop picks this up: Set iteration is live
        delete block[k];
      }
    }
  }
  return gone;
}

/** Shared by both inspector states, so Restore works when nothing is drawn. */
function wireInspectorButtons(id) {
  const inspectorEl = $('#inspector');
  // A region the FIT created has no design behind it, so "drop" would be a
  // half-measure: it would leave an entry describing something deliberately not
  // drawn, and nothing to ever restore it to. Deleting it is the honest verb.
  const del = inspectorEl.querySelector?.('#delete');
  if (del) {
    del.onclick = async () => {
      remember(`delete ${id}`);
      // Everything descended from it, not merely its direct copies. applyFit
      // resolves copy-of-copy in passes, so A -> B -> C is a real shape; taking
      // out A and B leaves C naming something that no longer exists, which is
      // saved into the fit and quietly draws nothing on the next build.
      const gone = deleteCopies(id);
      // And the session's opinions about them, which would otherwise outlive
      // them and attach themselves to the next region to take the name.
      for (const dead of gone) {
        const twin = state.paired.get(dead);
        state.paired.delete(dead);
        if (twin) state.paired.delete(twin);
        state.unlinked.delete(dead);
        state.severed.delete(dead);
      }

      state.selected = null;
      setDirty(true);
      await reloadState();
      await refresh();
      status(`deleted ${id}`);
    };
  }

  if (inspectorEl.querySelector?.('#drop') !== null) $('#drop').onclick = async () => {
    remember(`${state.fit.regions[id]?.drop ? 'restore' : 'drop'} ${id}`);
    const ov = override(id);
    if (ov.drop) delete ov.drop; else ov.drop = true;
    setDirty(true);
    await refresh();
  };
  // Absent for a region the fit created: there is no design behind it to go back
  // to, so Reset there was a button that did nothing at all.
  const reset = inspectorEl.querySelector?.('#reset');
  if (reset) reset.onclick = async () => {
    remember(`reset ${id}`);
    delete state.fit.regions[id];
    // Reset means back to the design, and the design's symmetry is part of what
    // it said. Leaving the other half of a pair adjusted would make "reset" the
    // one action that creates an asymmetry rather than removing one.
    for (const other of linkedTo(id)) delete state.fit.regions[other];
    setDirty(true);
    await refresh();
  };

  // Placement is a DESIGN edit, unlike everything else wired here: it changes
  // the rule by which the region finds a place on any car, which is precisely
  // the thing a fit is not allowed to touch.
  for (const b of $('#inspector').querySelectorAll?.('[data-place]') ?? []) {
    b.onclick = () => setPlacement(id, b.dataset.place);
  }
  for (const b of $('#inspector').querySelectorAll?.('[data-tag]') ?? []) {
    b.onclick = () => toggleTag(id, b.dataset.tag);
  }

  // Rotation is a fit override like any other, so it travels with the region
  // and never edits the design.
  for (const b of $('#inspector').querySelectorAll?.('[data-rotate]') ?? []) {
    b.onclick = async () => {
      const v = b.dataset.rotate;
      remember(`rotate ${id}`);
      const ov = override(id);
      if (v === 'auto') delete ov.rotate; else ov.rotate = Number(v);
      for (const other of linkedTo(id)) {
        const oo = override(other);
        if (v === 'auto') delete oo.rotate; else oo.rotate = Number(v);
      }
      setDirty(true);
      await refresh();
    };
  }

  const inspector = inspectorEl;

  // Break or restore the link. Recorded against BOTH ids: the switch is reached
  // from whichever half is selected, and a link broken from the left but still
  // reading "linked" from the right would be worse than no switch at all.
  const mirror = inspector.querySelector?.('#mirror');
  if (mirror) {
    mirror.onclick = () => {
      remember(`link ${id}`);
      const other = partnerOf(id);
      if (state.unlinked.has(id)) { state.unlinked.delete(id); state.unlinked.delete(other); }
      else { state.unlinked.add(id); if (other) state.unlinked.add(other); }
      drawInspector();
      // The car shows the twin's rectangle beside the selected one, and which
      // twin that is has just changed. Redrawing only the inspector left the
      // old partner lit up on the model while edits no longer reached it.
      drawOverlay();
      status(state.unlinked.has(id) ? 'sides edit independently' : 'sides move together');
    };
  }

  // Pair with a region the naming convention did not catch. Pairing MIRRORS
  // immediately rather than only taking effect on the next edit — otherwise
  // declaring a pair appears to do nothing, and the way to find out whether it
  // worked is to drag something and hope.
  const pairwith = inspector.querySelector?.('#pairwith');
  if (pairwith) {
    pairwith.onchange = async () => {
      const other = pairwith.value;
      if (!other) return;
      remember(`pair ${id}`);
      state.paired.set(id, other);
      state.paired.set(other, id);
      // Declaring a pair overrides a previous severance, or unpairing would be
      // permanent for the session and the dropdown would silently do nothing.
      state.severed.delete(id);
      state.severed.delete(other);
      state.unlinked.delete(id);
      state.unlinked.delete(other);
      await mirrorNow(id);
      status(`${id} and ${other} now move together`);
    };
  }

  // Create the other half. See mirrorCopy.
  const create = inspector.querySelector?.('#mirrorcreate');
  if (create) create.onclick = () => { remember(`mirror ${id}`); return mirrorCopy(id); };

  const duplicate = inspector.querySelector?.('#duplicate');
  if (duplicate) duplicate.onclick = () => { remember(`duplicate ${id}`); return duplicateRegion(id); };

  // One-shot: copy this placement across without changing the link. The action
  // a broken pair needs when the two sides have drifted and only one of them
  // was meant to.
  const mirrornow = inspector.querySelector?.('#mirrornow');
  if (mirrornow) mirrornow.onclick = () => { remember(`mirror ${id}`); return mirrorNow(id); };

  const unpair = inspector.querySelector?.('#unpair');
  if (unpair) {
    unpair.onclick = () => {
      remember(`unpair ${id}`);
      const other = partnerOf(id);
      // A pair found from the ids cannot be deleted from the map — it is not in
      // it — so unpairing records the SEVERANCE instead, against both halves.
      state.paired.delete(id);
      if (other) state.paired.delete(other);
      state.severed.add(id);
      if (other) state.severed.add(other);
      state.unlinked.delete(id);
      if (other) state.unlinked.delete(other);
      drawInspector();
      drawOverlay();                       // the former twin must stop being highlighted
      status(`${id} is on its own now`);
    };
  }
}

/**
 * Create the region's opposite number, on the mirrored panel.
 *
 * This is the one thing a fit does that ADDS a region, and the rule it bends is
 * one I wrote: a fit cannot add regions, because wanting to usually means the
 * design needs the change. A mirrored copy earns the exception by inventing no
 * artwork — treatment, colours and text all come from the region it names, and
 * the only new information is a placement, which is precisely what a fit is
 * for. Symmetry is a property of the CAR: a design that paints one badge is
 * portable to a car with one flank worth painting and to a car with two, and
 * the design cannot know which it is looking at.
 */
async function mirrorCopy(id) {
  const sel = state.placed.find((p) => p.id === id);
  if (!sel) return status('nothing placed to copy');
  const here = state.surface.panels.find((p) => p.name === sel.panel);
  if (!here) return status('this region has no panel to mirror across');

  // `mirrorOf` is a name, and a profile can carry one whose target is gone —
  // regeneration renames islands, and a hand-written profile may simply be
  // wrong. Dereferencing it unchecked turned "this car has no matching panel"
  // into a TypeError from inside a click handler.
  const there = state.surface.panels.find((p) => p.name === (here.mirrorOf ?? here.name));
  if (!there) {
    return status(`${sel.panel} says its mirror is ${here.mirrorOf}, which this car does not have`);
  }
  const flips = there.name === here.name ? selfMirrorFlips(here) : mirrorFlips(here, there);

  // The rotation the source actually has, which is the fit's if it overrode one
  // and the DESIGN's otherwise. Reading only the fit meant a mirrored copy of
  // artwork the livery had turned kept that angle unmirrored: applyFit clones
  // the source's own `rotate` unchanged, so the two halves faced the same way
  // instead of mirroring each other.
  const rotate = resolvedRotation(id);

  const copyId = await addCopy(id, 'mirror', {
    panel: there.name,
    at: mirrorAt(toPanelRelative(here.rect, sel.abs), flips),
    ...(rotate !== undefined ? { rotate: mirrorRotation(rotate, flips) } : {}),
  });
  // Linked from the start: it was created as this region's other half, and
  // having to then declare that would be asking twice.
  state.paired.set(id, copyId);
  state.paired.set(copyId, id);
  state.severed.delete(id);
  await refresh();
  selectRegion(id);
  status(`created ${copyId} on ${there.name}`);
}

/**
 * Duplicate a region into the DESIGN, nudged clear of the original.
 *
 * This used to write a fit `copy`, and it was the one place the fit/design line
 * was crossed for convenience rather than for a reason. A MIRRORED copy earns
 * its place there: it says *this car has two flanks*, which is a fact about the
 * car, and a design cannot know it. A duplicate says *I want two badges*, which
 * is a fact about the design and true of every car it is pointed at. It only
 * ever lived in the fit because the mechanism was already there.
 *
 * Now that a design can gain a region, it goes where it belongs. `copies` means
 * mirroring again.
 *
 * Offset rather than placed exactly on top, and offset the other way when there
 * is no room: a duplicate hidden under its original looks like the button did
 * nothing, and the way to find out otherwise is to drag the one you can see.
 */
async function duplicateRegion(id) {
  const sel = state.placed.find((p) => p.id === id);
  if (!sel) return status('nothing placed to duplicate');
  const source = (designRegions() ?? []).find((r) => r.id === id);
  if (!source) {
    // A fit-created region has no design behind it to copy. Duplicating one
    // would have to invent what it IS, which is the thing a fit may not do.
    return status(`${id} was made by the fit, so there is no design region to duplicate`);
  }

  const here = state.surface.panels.find((p) => p.name === sel.panel);
  const at = here ? toPanelRelative(here.rect, sel.abs) : [...sel.abs];
  const step = 0.06;
  const nudge = (v, size) => {
    const room = 1 - size;
    if (room <= 0) return v;                       // fills the panel; nowhere to go
    return v + step <= room ? v + step : Math.max(0, v - step);
  };
  const nudged = [nudge(at[0], at[2]), nudge(at[1], at[3]), at[2], at[3]];
  const stacked = nudged[0] === at[0] && nudged[1] === at[1];

  const copyId = freeRegionId(`${id}-copy`);
  remember(`duplicate ${id}`);
  // A copy of the design region, so it carries the treatment and its options.
  // `panel` and `at` are where this one goes; everything else is what it is.
  designRegions().push({
    ...structuredClone(source),
    id: copyId,
    ...(sel.panel ? { panel: sel.panel } : {}),
    at: nudged,
  });
  setDesignDirty();
  await reloadState();
  await refresh();
  selectRegion(copyId);
  status(stacked
    ? `duplicated as ${copyId} in the design, exactly on top — it fills its panel`
    : `duplicated as ${copyId} in the design`);
}

/**
 * The rotation a region actually has: the fit's if it overrode one, the design's
 * if it did not.
 *
 * A copy is made from what is ON the car, not from what the fit happens to
 * mention. Reading only the fit made a mirrored copy of rotated artwork keep the
 * angle unmirrored, because applyFit clones the source's own `rotate` and the
 * copy said nothing to the contrary.
 */
function resolvedRotation(id) {
  const o = copyEntry(id) ?? state.fit.regions[id] ?? {};
  if (o.rotate !== undefined) return o.rotate;
  return state.surface.regions.find((r) => r.id === id)?.rotate ?? undefined;
}

/** Write a copy into the fit and re-read what the surface now contains. */
async function addCopy(id, suffix, placement) {
  // Every id a fit could collide with, not merely this surface's. Fit ids are
  // FLAT across the livery — that is how a fit addresses a region without
  // knowing which texture it lives on — so a name free here can already belong
  // to a region on the suit, or to a copy in either spelling of the block. Only
  // checking this surface produced an entry that overwrote one of those, and the
  // region it replaced simply stopped being drawn.
  const taken = new Set([
    ...state.data.surfaces.flatMap((s) => s.regions.map((r) => r.id)),
    ...Object.keys(state.fit.copies ?? {}),
    ...Object.keys(state.fit.mirrors ?? {}),
    // Overrides too. An older fit can still carry an entry for `badge-copy`
    // after the region it adjusted left the design, and taking that name writes
    // one id under both `regions` and `copies` — which renders from the copy and
    // is then refused by validateFit on the way to disk.
    ...Object.keys(state.fit.regions ?? {}),
  ]);

  // Named after the source so the fit reads as what it is, and numbered on
  // collision because duplicating twice is an ordinary thing to do.
  let copyId = `${id}-${suffix}`;
  for (let n = 2; taken.has(copyId); n++) copyId = `${id}-${suffix}-${n}`;
  state.fit.copies ??= {};
  state.fit.copies[copyId] = { of: id, ...placement };
  setDirty(true);
  // A new region changes what the surface CONTAINS, and only /api/state knows
  // that. refresh() alone would draw the copy on the car and leave it missing
  // from the region list — visible, and unselectable.
  await reloadState();
  return copyId;
}

/**
 * Push this region's placement onto its opposite number, once.
 *
 * Goes through writeFit so there is exactly one implementation of what
 * mirroring means — measured flips, the twin's own panel, the rotation rule.
 * A second copy of that arithmetic living behind a button is how the two would
 * quietly diverge.
 */
async function mirrorNow(id) {
  const sel = state.placed.find((p) => p.id === id);
  if (!sel) return status('nothing placed to mirror');
  const other = partnerOf(id);
  if (!other) return status('no opposite number to mirror onto');
  const wasUnlinked = state.unlinked.has(id) || state.unlinked.has(other);
  state.unlinked.delete(id);
  state.unlinked.delete(other);
  writeFit(sel);
  // An explicit one-shot must not quietly re-link a pair somebody separated.
  if (wasUnlinked) { state.unlinked.add(id); state.unlinked.add(other); }
  setDirty(true);
  await refresh();
  status(`mirrored onto ${other}`);
}

/**
 * The other half of this region's pair, when the two are still linked.
 *
 * An array rather than a value, so callers loop instead of branching — every
 * one of them does the same thing to the partner as to the region itself, and a
 * null check at four call sites is four chances to forget one.
 */
function linkedTo(id) {
  const other = partnerOf(id);
  if (!other) return [];
  if (state.unlinked.has(id) || state.unlinked.has(other)) return [];
  return [other];
}

/**
 * This region's other half, linked or not.
 *
 * A pair the person declared outranks one found from the ids: they are looking
 * at the car and the convention is only a guess about what the names meant.
 */
function partnerOf(id) {
  if (state.severed.has(id)) return null;
  const declared = state.paired.get(id);
  if (declared) return state.surface.regions.some((r) => r.id === declared) ? declared : null;
  const found = state.surface.regions.find((r) => r.id === id)?.mirror;
  return found && state.surface.regions.some((r) => r.id === found) ? found : null;
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

/**
 * Show or hide an element, by ATTRIBUTE rather than by the `hidden` property.
 *
 * `hidden` lives on HTMLElement. `#overlay` is an `<svg>`, and SVGElement does
 * not have it — so `overlay.hidden = false` quietly defines a plain expando and
 * leaves the content attribute exactly where it was. Nothing throws and nothing
 * logs; the attribute simply cannot be removed that way, in any browser.
 *
 * And this page supplies its own `[hidden] { display: none !important }`, which
 * an attribute selector applies to SVG as readily as to anything else. So from
 * the moment the markup started shipping `hidden` on #overlay, the region
 * editor's overlay was permanently display:none EVERYWHERE — not, as the first
 * telling of this had it, only in the browser whose UA stylesheet happens to
 * cover SVG. What hid it was the rule this page ships on purpose.
 *
 * It went unnoticed because the two views under active work — whole car and
 * cockpit — do not use the overlay at all. The browser test that drives a real
 * pointer at a region is what found it, by having no region to click.
 *
 * Attributes work on both kinds of element. Used for every layer in this view
 * so the next one added cannot inherit the trap.
 */
export function setHidden(el, on) {
  if (!el) return;
  if (on) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

async function showView(which) {
  // The offer belongs to the click that produced it. Left up across a view
  // change it would invite adopting a surface you can no longer see, from a
  // sentence about a car you have navigated away from.
  if ($('#adopt')) $('#adopt').hidden = true;

  state.view = which;
  const is3d = which === '3d' || which === 'all' || which === 'cockpit';
  for (const [id, name] of [
    ['#tab-uv', 'uv'], ['#tab-3d', '3d'], ['#tab-all', 'all'], ['#tab-cockpit', 'cockpit'],
  ]) {
    $(id).className = `tab${which === name ? ' on' : ''}`;
  }
  setHidden($('#texture'), is3d);
  setHidden($('#overlay'), is3d);
  setHidden($('#carview'), !is3d);
  // Only where there is geometry to shade. On the UV tab you are reading the
  // sheet, and a control offering to light it would be offering nonsense.
  setHidden($('#litbox'), !is3d);
  if (!is3d) return;

  // Unhiding is not the same as being laid out. `hidden = false` takes effect on
  // the next frame, and until then the canvas is still 0x0 — and Firefox hands
  // back a null WebGL context for a zero-sized canvas, which this code reports
  // as "WebGL is unavailable in this browser". It is available; the canvas just
  // did not exist yet. Waiting one frame is the whole fix.
  await nextFrame();

  try {
    $('#viewnote').textContent = which === 'uv' || which === '3d' ? 'loading…' : 'rendering every surface…';
    if (which === 'all') await loadWholeCar();
    else if (which === 'cockpit') await loadCockpit();
    else await loadCarGeometry();
  } catch (e) {
    // No model is an ordinary situation, not a failure: plenty of people have a
    // profile for a car whose kn5 is not on this machine. Neither is a model
    // with no cockpit eye — an open passenger buggy, or a car this project's
    // steering-wheel search does not recognise — which loadCockpit reports the
    // same way, as a message rather than a crash.
    $('#viewnote').textContent = `no 3D view — ${e.message}`;
    status(`3D unavailable for ${state.surface.file}`);
    setHidden($('#carview'), true);
    setHidden($('#texture'), false);
    setHidden($('#overlay'), false);
    state.view = 'uv';
    $('#tab-uv').className = 'tab on';
    $('#tab-3d').className = 'tab';
    $('#tab-all').className = 'tab';
    $('#tab-cockpit').className = 'tab';
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
/**
 * Which groups are painted, according to the design as it stands.
 *
 * The geometry is cached, rightly: it is a fact about the car and costs
 * megabytes to fetch. Which group is PAINTED is a fact about the design, and the
 * design changes while the geometry does not — so the roles that came down with
 * the geometry are only ever as fresh as the moment it was fetched. Adopting a
 * surface left its meshes in a group still marked roleless, and no amount of
 * rendering the right texture would have put it anywhere.
 *
 * Keyed by FILE, which is the thing both sides agree on: a group carries the
 * texture its meshes use, and a surface carries the texture it writes. Role
 * names are the profile's and mean nothing to geometry.
 *
 * Exported so this can be tested without a GL context and a model download,
 * neither of which a fake DOM has.
 */
export function reRole(groups, surfaces) {
  const roleOf = new Map((surfaces ?? []).map((sf) => [String(sf.file).toLowerCase(), sf.role]));
  return (groups ?? []).map((g) => ({
    ...g,
    role: roleOf.get(String(g.file).toLowerCase()) ?? null,
  }));
}

/**
 * Fetch (once) and upload the whole-car geometry and every painted surface.
 * Shared by the orbit whole-car view and the cockpit view — they show the same
 * car, painted the same way, and differ only in what the camera does with it.
 */
async function ensureWholeCar() {
  if (!state.viewer) {
    state.viewer = createViewer($('#carview'));
    state.viewer.attach({ claim: claimCarPointer });
  }
  if (!state.wholeGeometry) {
    const res = await fetch('/api/model?all=1');
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? 'no model for this car');
    }
    state.wholeGeometry = unpackModel(await res.arrayBuffer());
  }
  // The WORKING design, like every other render in this editor. Without it the
  // preview came from the livery on disk, so a region added since the last save
  // was simply absent from the one view whose job is to show the whole thing —
  // and an adopted surface, which is unsaved by definition, could never appear.
  const { surfaces } = await api('/api/preview', { fit: state.fit, design: state.design });

  // Re-roled HERE, from the surfaces the design paints now.
  //
  // The geometry is cached, because it is a fact about the car and costs
  // megabytes to fetch. Which group is PAINTED is a fact about the design, and
  // the design changes while the geometry does not — so the roles that came
  // down with the geometry are only as fresh as the moment it was fetched.
  // Adopting a surface left its meshes in a group still marked roleless, and no
  // amount of rendering the right texture would have put it anywhere.
  //
  // Keyed by file, which is what both sides agree on: a group carries the
  // texture its meshes use, and a surface carries the texture it writes.
  const g = { ...state.wholeGeometry, groups: reRole(state.wholeGeometry.groups, state.data.surfaces) };
  const drew = await state.viewer.setWholeCar(g, surfaces);
  return { g, drew };
}

async function loadWholeCar() {
  const { g, drew } = await ensureWholeCar();
  // The camera this view wants, asked for rather than inherited. setWholeCar
  // used to leave the view in orbit mode as a side effect of uploading
  // geometry, and now that it only uploads when the geometry changed, coming
  // back here from the cockpit has to say so.
  state.viewer.setOrbit();

  const painted = new Set(g.groups.filter((x) => x.role).map((x) => x.role));
  const bare = g.groups.filter((x) => !x.role).reduce((s, x) => s + x.count / 3, 0);
  $('#viewnote').textContent =
    `${(g.indices.length / 3).toLocaleString()} triangles · ${painted.size} painted surface` +
    `${painted.size === 1 ? '' : 's'}` +
    (bare ? ` · ${bare.toLocaleString()} triangles unpainted, shown grey` : '') +
    // What the VIEWER actually managed, not what it was handed. Those two
    // diverged silently for three rounds of "I still cannot see the plate":
    // an upload that threw abandoned the rest of the loop and left the previous
    // frame on screen, with nothing in the console because the throw never
    // reached one.
    (drew?.failed?.length ? ` · ${drew.failed.length} FAILED TO UPLOAD: ${
      drew.failed.join('; ')}` : '') +
    ` · ${drew?.blended ?? 0} blended, ${drew?.additive ?? 0} additive` +
    ' — drag to orbit, wheel to zoom';
}

/**
 * The whole car again, but from the driver's seat instead of orbiting it.
 *
 * Answers a different question than the whole-car view: not "does this design
 * work on the car" but "what does the person racing it actually see" — which
 * parts of a wrap read from inside the cockpit, whether a number on the halo
 * or the mirrors ends up in the driver's eyeline.
 *
 * The eye position is the same one the profile's visibility pass uses
 * (`cockpitEye`, keyed off the steering wheel mesh), so this shows exactly the
 * point the "readable from the driver's seat" tag on a panel was measured
 * from. A car with no recognisable steering wheel — an open buggy, or a model
 * this project has not seen — has no such point, and this says so rather than
 * guessing one.
 */
async function loadCockpit() {
  const { g, drew } = await ensureWholeCar();
  const eye = state.wholeGeometry.cockpit;
  // ABSENT and NULL are different answers. The server states null for a car
  // whose model has no recognisable steering wheel; the key is missing only
  // when the server is running code older than this page, which is what a
  // reload without a restart gets you — the modules the server imports are
  // cached and the page's are not.
  if (eye === undefined) {
    throw new Error(
      'this server sent no cockpit field at all — it is running an older build than this page. Restart it.');
  }
  if (!eye) {
    throw new Error(
      'no cockpit eye for this car — liverykit could not find a steering wheel mesh in the model');
  }
  state.viewer.setCockpit(eye);

  const painted = new Set(g.groups.filter((x) => x.role).map((x) => x.role));
  $('#viewnote').textContent =
    `${painted.size} painted surface${painted.size === 1 ? '' : 's'}` +
    (drew?.failed?.length ? ` · ${drew.failed.length} FAILED TO UPLOAD: ${
      drew.failed.join('; ')}` : '') +
    // The car's own textures, as opposed to the design's renders above. A
    // missing one shows as grey on a part nobody painted, which reads as a
    // finished picture rather than a hole in it.
    (drew?.stockFailed?.length ? ` · ${drew.stockFailed.length} CAR TEXTURE${
      drew.stockFailed.length === 1 ? '' : 'S'} NOT SERVED: ${
      drew.stockFailed.join('; ')}` : '') +
    ' — drag to look around';
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
    state.viewer.attach({ claim: claimCarPointer });
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
  const opened = state.placed.find((p) => p.id === state.selected);
  highlightOnCar(opened?.abs ?? null, opened?.panel, linkedTo(state.selected)[0]);
  $('#viewnote').textContent =
    `${(geom.indices.length / 3).toLocaleString()} triangles painted by ${state.surface.file}` +
    ' — click a region to select it, drag to move it across panels, drag the' +
    ' marked corner to resize; drag bare bodywork to orbit';
}

/**
 * Show the selected region on the car, if there is a car on screen to show it on.
 *
 * Cheap and silent when the 3D view has never been opened, which is the common
 * case: this runs on every selection and every drag frame, and a UV-only session
 * should not pay for a feature it is not looking at.
 */
function highlightOnCar(abs, panelName, twinId) {
  if (!state.viewer) return;
  const rectOf = (name) => state.surface.panels.find((p) => p.name === name)?.rect ?? null;
  // The opposite number, and where it lives. Shown because a linked edit moves
  // BOTH, and watching only the half under the pointer means finding out what
  // happened to the other one by orbiting round to look.
  const twin = twinId ? state.placed.find((p) => p.id === twinId) : null;
  state.viewer.setHighlight({
    region: abs,
    panel: panelName === undefined ? null : rectOf(panelName),
    twin: twin?.abs ?? null,
    twinPanel: twin ? rectOf(twin.panel) : null,
  });
}

async function paintCar() {
  if (!state.viewer || !state.svg) return;
  try {
    const t = state.data.surfaces.find((x) => x.role === state.surface?.role);
    await state.viewer.setTexture(state.svg, t?.width ?? 1024, t?.height ?? t?.width ?? 1024);
  } catch (e) {
    $('#viewnote').textContent = `texture: ${e.message}`;
  }
}

// --- chrome -----------------------------------------------------------------

function setDirty(v) {
  state.dirty = v;
  updateSaveButtons();
  $('#status').className = v || state.designDirty ? 'status dirty' : 'status';
}

/**
 * Two buttons, each enabled only by its own kind of change.
 *
 * A design edit does not make the fit unsaved and a drag does not make the
 * design unsaved, so one dirty flag would light both and every save would write
 * a file nobody had touched.
 */
function updateSaveButtons() {
  const save = $('#save'); if (save) save.disabled = !state.dirty;
  const design = $('#savedesign'); if (design) design.disabled = !state.designDirty;
}

/** Mark the DESIGN changed — what a region is, rather than where it sits. */
function setDesignDirty() {
  state.designDirty = true;
  updateSaveButtons();
  $('#status').className = 'status dirty';
}
function status(msg) {
  // WHICH is unsaved, not merely that something is. There are two files and two
  // buttons now, and "unsaved" that does not say which one leaves you to work it
  // out from which button is enabled — in the far corner, while dragging.
  const unsaved = [state.dirty && 'fit', state.designDirty && 'design'].filter(Boolean);
  $('#status').textContent = unsaved.length ? `${msg} — ${unsaved.join(' and ')} unsaved` : msg;
  // Also under the canvas, where the eyes already are. A hint in the far corner
  // of the header is a hint nobody reads while dragging.
  $('#canvashint').textContent = msg;
}
/** Escape for both text nodes and quoted attributes. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- proposal polling --------------------------------------------------------
let currentProposal = null;

/**
 * Apply a proposal, and report the ops that would not go on.
 *
 * The ops throw now rather than ignoring a name they do not know, so this has
 * to catch — but it catches PER OP and keeps going, because a proposal is
 * several changes and losing the four that worked because the fifth was
 * misspelled helps nobody. What it will not do is let a rejected op pass for an
 * applied one: the refusals come back and go on screen.
 */
function applyProposalDiffInApp(p) {
  const refused = [];
  for (const [ops, apply, target] of [
    [p?.design, applyDesignOp, state.design],
    [p?.fit, applyFitOp, state.fit],
  ]) {
    if (!Array.isArray(ops)) continue;
    for (const op of ops) {
      try { apply(target, op); } catch (e) { refused.push(e.message); }
    }
  }
  return refused;
}

async function checkProposals() {
  if (currentProposal) return;
  try {
    const res = await api('/api/proposal');
    const p = res?.proposal;
    if (p && p.id && p.id !== currentProposal?.id) {
      currentProposal = p;
      remember(`proposal: ${p.why}`);
      const refused = applyProposalDiffInApp(p);
      if (refused.length) status(`${refused.length} of the proposal's changes were refused`);
      if (Array.isArray(p.fit) && p.fit.length > 0) setDirty(true);
      if (Array.isArray(p.design) && p.design.length > 0) setDesignDirty();
      await reloadState();
      await refresh();
      showProposalBanner(p, refused);
    }
  } catch {
    // server down or network glitch
  }
}

/**
 * The banner, and any part of the proposal that did not go on.
 *
 * The refusals belong HERE rather than wherever they were caught, because this
 * function runs last and sets `why` unconditionally — writing them earlier put
 * them on screen for one frame and then overwrote them, which is the same as
 * not reporting them. Accept/Discard is a decision about what the proposal did,
 * so what it failed to do has to be in front of you when you make it.
 */
function showProposalBanner(p, refused = []) {
  const banner = $('#proposal-banner');
  const why = $('#proposal-why');
  if (!banner || !why) return;
  why.textContent = refused.length
    ? `${p.why}  —  NOT APPLIED: ${refused.join(' ')}`
    : p.why;
  banner.hidden = false;
}

function hideProposalBanner() {
  const banner = $('#proposal-banner');
  if (banner) banner.hidden = true;
}

async function acceptProposal() {
  if (!currentProposal) return;
  const prop = currentProposal;
  try {
    await api('/api/proposal/ack', { id: prop.id, status: 'accepted' });
    currentProposal = null;
    hideProposalBanner();
    status('accepted proposal');
  } catch (e) {
    status(`failed to accept proposal: ${e.message}`);
  }
}

async function discardProposal() {
  if (!currentProposal) return;
  const prop = currentProposal;
  try {
    await api('/api/proposal/ack', { id: prop.id, status: 'discarded' });
    currentProposal = null;
    hideProposalBanner();
    await undo();
    status('discarded proposal');
  } catch (e) {
    status(`failed to discard proposal: ${e.message}`);
  }
}

const acceptBtn = $('#proposal-accept');
if (acceptBtn) acceptBtn.onclick = acceptProposal;
const discardBtn = $('#proposal-discard');
if (discardBtn) discardBtn.onclick = discardProposal;

const proposalTimer = setInterval(checkProposals, 1000);
if (proposalTimer?.unref) proposalTimer.unref();

// --- boot, last -------------------------------------------------------------
//
// After every declaration, so no helper can be reached before it exists.
//
// It opens on the CAR. That is where the work happens now — you can select,
// move, resize and rotate there, and it is the only view that answers whether a
// placement is any good. showView falls back to the UV sheet on its own if
// there is no model or no WebGL, so this is a preference rather than a demand.
await selectSurface(state.data.surfaces[0]?.from);
await showView('3d');
// Last, after the car is on screen, so a slow profile directory cannot delay
// anything anybody is waiting for. It answers `undefined` rather than throwing
// when there is nothing to list, because a second opinion is not a prerequisite
// for editing.
await loadOtherCars();
