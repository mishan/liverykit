// ---------------------------------------------------------------------------
// The editor's boot path, run without a browser.
//
// src/ui/app.js shipped once in a state where it threw during module evaluation
// — a `const` arrow used by a top-level `await` before its declaration — and the
// result was a page that rendered its static HTML and did nothing at all. From
// the outside that reads as an unfinished mockup rather than a crash, which is
// the worst possible failure: it looks like a design decision.
//
// That is the third temporal-dead-zone bug in this project, so it gets a test
// rather than another apology. The DOM here is the smallest thing that lets the
// module run: enough to answer the queries app.js makes, record what it wrote,
// and let a click be delivered.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { editorState, renderSurface } from '../src/ui/server.mjs';
import { loadProfile, binding } from '../src/profile.mjs';
import { loadFit } from '../src/fit.mjs';
import '../src/index.mjs';

/** The least DOM that lets app.js get through its boot. */
function fakeDom() {
  const made = new Map();
  const node = (id) => {
    const el = {
      id,
      innerHTML: '',
      textContent: '',
      className: '',
      dataset: {},
      style: {},
      disabled: false,
      onclick: null,
      onchange: null,
      onpointerdown: null,
      children: [],
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1000, height: 1000, left: 0, top: 0 }),
    };
    return el;
  };
  return {
    made,
    querySelector(sel) {
      if (!made.has(sel)) made.set(sel, node(sel));
      return made.get(sel);
    },
  };
}

async function runApp({ state, render }) {
  const dom = fakeDom();
  const calls = [];
  const g = globalThis;

  // Installed for the whole test, not just the import. Handlers run later —
  // clicking a region re-renders, which needs both document and fetch — so
  // tearing the globals down after the module loads breaks every interaction
  // the test is trying to exercise.
  g.document = dom;
  g.performance ??= { now: () => 0 };
  g.structuredClone ??= (o) => JSON.parse(JSON.stringify(o));
  // A window that can carry the pointermove/pointerup pair a drag listens for.
  const listeners = new Map();
  g.window = {
    addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t, fn) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
    emit: (t, ev) => (listeners.get(t) ?? []).slice().forEach((fn) => fn(ev)),
  };
  g.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    const body = path === '/api/state' ? state : render;
    return { ok: true, status: 200, json: async () => body };
  };

  // Cache-busted so each test gets a fresh evaluation; a module that throws on
  // first import would otherwise be cached as failed and every later test would
  // see the cached failure instead of the real one.
  const mod = await import(`../src/ui/app.js?t=${Date.now()}${Math.random()}`);
  return { dom, calls, mod, window: g.window };
}

test('the editor module boots instead of dying in a dead zone', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit });
  const render = renderSurface({ livery, profile, fit, role });

  const { dom, calls } = await runApp({ state, render });

  // It asked the server for both halves, which means it got past every
  // declaration it needed on the way.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`),
    ['GET /api/state', 'POST /api/render']);

  // And it actually drew: the header, the surface list, the panels, the regions,
  // the overlay and the texture all have content.
  assert.equal(dom.querySelector('#livery').textContent, livery.name);
  assert.match(dom.querySelector('#surface').innerHTML, /<option/);
  assert.match(dom.querySelector('#panels').innerHTML, /left_mid/);
  assert.match(dom.querySelector('#regions').innerHTML, /number-left/);
  assert.match(dom.querySelector('#texture').innerHTML, /^<svg/);
  assert.match(dom.querySelector('#overlay').innerHTML, /<rect/);
});

test('the editor escapes what it puts in the page', async () => {
  // Not because a car pack is likely to be hostile — because a filename with a
  // quote in it breaks the attribute it sits in, and the page then looks broken
  // rather than the name unusual.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null });
  state.surfaces[0].file = 'evil".dds';
  state.surfaces[0].panels[0] = { name: '<script>x</script>', rect: [0, 0, 1, 1], tags: ['a"b'] };
  const render = renderSurface({ livery, profile, fit: null, role });

  const { dom } = await runApp({ state, render });
  const html = dom.querySelector('#surface').innerHTML + dom.querySelector('#panels').innerHTML;
  assert.doesNotMatch(html, /<script>/, 'a panel name must not become a tag');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /evil&quot;\.dds/, 'a quote in a filename must not end the attribute');
});

test('app.js declares its helpers before the boot await reaches them', async () => {
  // A structural check as well as a behavioural one: the boot must be the last
  // statement, so no future edit can reintroduce the ordering problem without
  // moving it.
  const src = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const boot = src.lastIndexOf('await selectSurface(');
  assert.ok(boot > 0, 'the module still boots by selecting a surface');
  const after = src.slice(boot).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.equal(after.length, 1, `nothing may follow the boot await, found: ${after.slice(1)}`);
});

test('clicking a region selects it and gives it something to drag', async () => {
  // The editor shipped once where every handler was bound to a node that the
  // next innerHTML replaced, so the page highlighted on hover and did nothing on
  // click. Handlers are delegated to the containers now, and this exercises the
  // whole path rather than trusting that they are.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const { dom } = await runApp({
    state: editorState({ livery, profile, fit }),
    render: renderSurface({ livery, profile, fit, role }),
  });

  const overlay = dom.querySelector('#overlay');
  assert.doesNotMatch(overlay.innerHTML, /class="box"/, 'nothing is selected yet');

  // The containers carry the handlers, and they survive every redraw.
  assert.equal(typeof dom.querySelector('#regions').onclick, 'function');
  assert.equal(typeof dom.querySelector('#panels').onclick, 'function');
  assert.equal(typeof dom.querySelector('#overlay').onpointerdown, 'function');

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  assert.match(overlay.innerHTML, /class="box"/, 'the selected region gets a draggable box');
  assert.match(overlay.innerHTML, /data-drag="move"/);
  assert.match(overlay.innerHTML, /class="handle"/, 'and a resize handle');
  assert.match(dom.querySelector('#regions').innerHTML, /class="sel/, 'and the list shows it');
  assert.match(dom.querySelector('#inspector').innerHTML, /number-left/);
});

test('dragging a region writes a panel-relative at into the fit', async () => {
  // The conversion the design settled on, exercised end to end: the mouse works
  // in absolute texture fractions, the fit stores panel-relative.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const { dom, window: win } = await runApp({
    state: editorState({ livery, profile, fit }),
    render: renderSurface({ livery, profile, fit, role }),
  });

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  const before = JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left'].at;

  // Press on the box, move a tenth of the texture right and down, release.
  dom.querySelector('#overlay').onpointerdown({
    preventDefault() {}, clientX: 100, clientY: 100, target: { dataset: { drag: 'move' } },
  });
  win.emit('pointermove', { clientX: 200, clientY: 200 });
  win.emit('pointerup', {});
  await new Promise((r) => setTimeout(r, 20));       // the drop re-renders

  const after = JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left'].at;
  assert.notDeepEqual(after, before, 'the drag reached the fit');
  assert.ok(after.every((n) => Number.isFinite(n)), `at must stay numeric, got ${after}`);
  assert.ok(after[0] > before[0] && after[1] > before[1], 'and moved the way the pointer did');
  assert.equal(dom.querySelector('#save').disabled, false, 'and the fit is now unsaved');
});

test('the car geometry survives the trip to the browser', async () => {
  // Packed on the server, unpacked by the viewer. Both halves are tested at once
  // because a mismatch between them is silent: the mesh still draws, just wrong.
  const { modelGeometry, packGeometry } = await import('../src/ui/server.mjs');
  const { unpack } = await import('../src/ui/view3d.js');
  const { parseKn5 } = await import('../src/engine/kn5.mjs');

  const model = await parseKn5('content/cars/abarth500/abarth500.kn5', { keepTextureData: false });
  const g = modelGeometry(model, 'SkinBase_DEFAULT.dds');

  assert.ok(g.positions.length / 3 > 10000, 'a car body is not a handful of vertices');
  assert.equal(g.indices.length % 3, 0, 'triangles');
  assert.ok(Math.max(...g.indices) < g.positions.length / 3, 'no index past the end');

  // Real car dimensions, which is the cheapest check that the transforms were
  // applied: a Fiat 500 is about 1.9 m wide and 3.7 m long.
  const width = g.bounds.hi[0] - g.bounds.lo[0];
  const length = g.bounds.hi[2] - g.bounds.lo[2];
  assert.ok(width > 1.5 && width < 2.2, `width ${width.toFixed(2)} m`);
  assert.ok(length > 3.0 && length < 4.2, `length ${length.toFixed(2)} m`);

  const back = unpack(new Uint8Array(packGeometry(g)).buffer);
  assert.deepEqual([...back.positions.slice(0, 9)], [...g.positions.slice(0, 9)]);
  assert.deepEqual([...back.uvs.slice(0, 6)], [...g.uvs.slice(0, 6)]);
  assert.deepEqual([...back.indices.slice(0, 12)], [...g.indices.slice(0, 12)]);
  assert.equal(back.positions.length, g.positions.length);
  assert.equal(back.indices.length, g.indices.length);
});

test('the page and the script agree about what exists', async () => {
  // A structural check, because the DOM harness above cannot make one: it
  // invents an element for any selector asked of it, which is exactly how it
  // hid two bugs that made the editor completely unusable.
  //
  // The first was a DUPLICATE id. The 3D canvas was given `car`, which the
  // header's car-name span already had, and the stylesheet then applied
  // `position: absolute; inset: 0` to both. The span's containing block is the
  // viewport, so it became an invisible page-sized sheet over the whole editor
  // and swallowed every click. Nothing looked wrong.
  //
  // The second was an INVALID selector. `#3dnote` cannot be a CSS id selector —
  // they may not start with a digit — so querySelector throws a SyntaxError
  // rather than returning null.
  const [html, app, css] = await Promise.all(
    ['index.html', 'app.js', 'style.css'].map((f) =>
      readFile(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')));

  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((v, i) => ids.indexOf(v) !== i), [],
    'duplicate ids: querySelector silently takes the first, and CSS takes both');

  const selectors = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];

  // These are built by drawInspector into #inspector's innerHTML, so they exist
  // when they are asked for but never appear in the static page.
  const dynamic = new Set(['#drop', '#reset']);
  const missing = selectors.filter((s) =>
    s.startsWith('#') && !dynamic.has(s) && !ids.includes(s.slice(1)));
  assert.deepEqual(missing, [], 'app.js queries ids the page does not contain');

  assert.deepEqual(selectors.filter((s) => /^#[0-9]/.test(s)), [],
    'an id selector may not begin with a digit — querySelector throws on these');

  // `hidden` is only a UA rule of `display: none`, and any id or class rule
  // setting `display` outranks it. #carview did exactly that: the canvas stayed
  // over the stage while marked hidden, ate every click meant for a panel or a
  // drag box, and went solid black once WebGL cleared it — so the UV view went
  // blank and stayed blank while the tabs themselves worked.
  //
  // The reset must therefore exist, and must be able to win.
  assert.match(css, /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/,
    'the stylesheet needs a [hidden] reset that outranks its own display rules');

  // And anything app.js toggles with `hidden` must be covered by it.
  const toggled = [...new Set([...app.matchAll(/\$\('#([\w-]+)'\)\.hidden/g)].map((m) => m[1]))];
  assert.ok(toggled.length, 'the editor toggles something with hidden');
  for (const id of toggled) {
    assert.ok(ids.includes(id), `app.js hides #${id}, which the page does not contain`);
  }

  // Every id the stylesheet positions absolutely must be one of the stage
  // layers. That is precisely the rule the #car collision broke.
  //
  // Parsed rule by rule rather than with one regex over the whole file: a
  // pattern that spans `{` happily matches a hex colour in the previous rule's
  // body, which is a fine way to make a test that fails for the wrong reason.
  // Comments first: they sit between rules, so splitting on `}` glues a
  // comment onto the next selector — and this file's comments mention the very
  // id the check is about.
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const [selector, body = ''] = rule.split('{');
    if (!/position:\s*absolute/.test(body)) continue;
    for (const [, id] of selector.matchAll(/#([\w-]+)/g)) {
      assert.ok(['texture', 'overlay', 'carview'].includes(id),
        `#${id} is positioned absolutely but is not a stage layer`);
    }
  }
});
