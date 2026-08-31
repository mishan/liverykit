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

/**
 * Boot app.js against a fake DOM.
 *
 * Two ways to answer its requests. `state` and `render` are fixed objects, which
 * is enough for anything that only reads. `server` — `{ livery, profile }` — runs
 * the real editorState and renderSurface against whatever fit the app POSTS,
 * which is the only way to test the SET of regions changing: creating or
 * deleting a copy shows up nowhere until the server is asked again, and asked
 * with the working fit rather than the saved one.
 */
async function runApp({ state, render, server = null }) {
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
    const sent = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? 'GET', body: sent });
    const answer = () => {
      if (!server) return path === '/api/state' ? state : render;
      const fit = sent?.fit ?? server.fit ?? null;
      // The working DESIGN is honoured exactly as the real server honours it. A
      // harness that ignored it would render from the file on disk and report
      // that every option control does nothing — or worse, that one works.
      const livery = sent?.design ?? server.livery;
      if (path === '/api/state') return editorState({ ...server, livery, fit, liveryId: 'test' });
      return renderSurface({ ...server, livery, fit, role: sent?.role ?? server.role });
    };
    // THROUGH JSON, as the real transport does. Handing the object over
    // directly let the fake keep things the wire cannot: a null-prototype map
    // arrives at the browser as an ordinary object, and a `roles` lookup that
    // was safe here was not safe there. A harness that transports better than
    // the network is a harness that hides transport bugs.
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(answer())) };
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

  const state = editorState({ livery, profile, fit, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit, role });

  const { dom, calls } = await runApp({ state, render });

  // It asked the server for both halves, which means it got past every
  // declaration it needed on the way.
  const seen = calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(seen.includes('GET /api/state'), seen.join(', '));
  assert.ok(seen.includes('POST /api/render'), seen.join(', '));

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

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
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
  // The LAST one. `indexOf` found the first, which stopped being the boot the
  // moment a helper had cause to select a surface itself — and then reported
  // every declaration below that helper as coming after the boot, which is a
  // page of noise pointing at nothing.
  const boot = src.lastIndexOf('await selectSurface(');
  assert.ok(boot > 0, 'the module still boots by selecting a surface');

  // The boot is more than one statement now — it opens the car view too — so
  // the rule is not "one line" but "nothing DECLARED after the boot begins".
  // That is what the original bug was: a `const` below a top-level await that
  // reached it. Top-level awaits after this point are the boot itself.
  const after = src.slice(boot).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
  const declarations = after.filter((l) => /^(function|const|let|var|class)\b/.test(l));
  assert.deepEqual(declarations, [],
    `nothing may be declared after the boot await: ${declarations.join(' | ')}`);
  assert.ok(after.every((l) => /^await |^\}?\)?;?$/.test(l) || l.startsWith('await')),
    `only boot statements may follow: ${after.join(' | ')}`);
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
    state: editorState({ livery, profile, fit, liveryId: 'neon-grid-any' }),
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

  const state = editorState({ livery, profile, fit, liveryId: 'neon-grid-any' });
  const { dom, window: win } = await runApp({
    state,
    render: renderSurface({ livery, profile, fit, role }),
  });

  // Where a region actually sits on the sheet, from what the fit records. A
  // drag can now carry a region onto a NEIGHBOURING PANEL, and once it does,
  // `at` is measured against a different rectangle — so comparing raw `at`
  // before and after would compare two different coordinate systems and call
  // a move in the right direction a move in the wrong one.
  const panels = state.surfaces.find((x) => x.role === role).panels;
  const absolute = (entry, fallbackPanel) => {
    const host = panels.find((p) => p.name === (entry.panel ?? fallbackPanel));
    const [px, py, pw, ph] = host ? host.rect : [0, 0, 1, 1];
    const [ax, ay, aw, ah] = entry.at;
    return [px + ax * pw, py + ay * ph, aw * pw, ah * ph];
  };

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  const fitBefore = JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left'];
  const before = fitBefore.at;
  const absBefore = absolute(fitBefore, fitBefore.panel);

  // Press on the box, move a tenth of the texture right and down, release.
  dom.querySelector('#overlay').onpointerdown({
    preventDefault() {}, clientX: 100, clientY: 100, target: { dataset: { drag: 'move' } },
  });
  win.emit('pointermove', { clientX: 200, clientY: 200 });
  win.emit('pointerup', {});
  await new Promise((r) => setTimeout(r, 20));       // the drop re-renders

  const fitAfter = JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left'];
  const after = fitAfter.at;
  assert.notDeepEqual(after, before, 'the drag reached the fit');
  assert.ok(after.every((n) => Number.isFinite(n)), `at must stay numeric, got ${after}`);
  // PANEL-RELATIVE is the whole point of the format: outside 0..1 the renderer
  // refuses the region, and a drag must never produce one.
  assert.ok(after.every((n) => n >= 0 && n <= 1), `at must stay within its panel, got ${after}`);

  // A drag that crosses a boundary must record the panel it landed on. Without
  // that the fit keeps the new coordinates measured against the OLD panel —
  // artwork in the wrong place, from a fit that reads perfectly well.
  const absAfter = absolute(fitAfter, fitBefore.panel);
  assert.ok(absAfter[0] > absBefore[0] && absAfter[1] > absBefore[1],
    `moved the way the pointer did: ${absBefore} -> ${absAfter}`);
  assert.equal(dom.querySelector('#save').disabled, false, 'and the fit is now unsaved');
});

test('a region dragged back to its declared panel drops the override', async () => {
  // A fit is overrides only. An entry that restates what the design already says
  // is not merely noise: it pins this car to today's design, so a later change
  // to where the region belongs silently stops applying here.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  // A design that names a panel outright, so there is a declared panel to
  // return to. The shipped portable design selects by tag and has none.
  const [home, away] = Object.entries(profile.panels[role])
    .sort(([, a], [, b]) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])
    .map(([n]) => n);
  assert.ok(home && away && home !== away, 'the fixture needs two panels to move between');
  const design = {
    ...livery,
    surfaces: { body: { background: 'base', regions: [
      { id: 'badge', treatment: 'fill', color: 'accent', panel: home, at: [0.2, 0.2, 0.3, 0.3] },
    ] } },
  };

  const fit = { livery: 'neon-grid-any', car: profile.id, regions: { badge: { panel: away, at: [0, 0, 0.3, 0.3] } } };
  const { dom } = await runApp({
    state: editorState({ livery: design, profile, fit, liveryId: 'neon-grid-any' }),
    render: renderSurface({ livery: design, profile, fit, role }),
  });

  const written = () => JSON.parse(dom.querySelector('#fitjson').textContent).regions.badge;
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  assert.equal(written().panel, away, 'the override starts out pinning the region elsewhere');

  // Put it back where the design puts it. Committing that must clear the pin,
  // not restate it.
  dom.querySelector('#panels').onclick({ target: { dataset: { panel: home } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(written().panel, undefined, `the override should be gone, got ${JSON.stringify(written())}`);
  assert.ok(Array.isArray(written().at), 'and the placement it was moved to is still recorded');
});

test('the car geometry survives the trip to the browser', async () => {
  // Packed on the server, unpacked by the viewer. Both halves are tested at once
  // because a mismatch between them is silent: the mesh still draws, just wrong.
  const { modelGeometry, packGeometry } = await import('../src/ui/server.mjs');
  const { unpack } = await import('../src/ui/view3d.js');
  //
  // Built from a fixture rather than a real car. This used to read a kn5 out of
  // content/, which passed on the machine it was written on and failed in CI —
  // that file is somebody else's artwork and is not in the repository, and never
  // can be. The fixture also lets the assertions be exact: against a real car
  // this said "width between 1.5 and 2.2 m", which tests a Fiat more than it
  // tests the transform stack.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const model = parseKn5Buffer(carKn5());
  const g = modelGeometry(model, CAR.texture);

  // Counted from the fixture's own constants, so subdividing it more finely
  // later cannot leave this test asserting a stale number.
  const perFace = (CAR.grid + 1) ** 2;
  assert.equal(g.positions.length / 3, perFace * CAR.faceCount,
    'every face keeps its own corners — welding them would merge the UV islands');
  assert.equal(g.indices.length, CAR.grid ** 2 * 6 * CAR.faceCount, 'two triangles a quad');
  assert.ok(Math.max(...g.indices) < g.positions.length / 3, 'no index past the end');

  const size = [0, 1, 2].map((k) => Number((g.bounds.hi[k] - g.bounds.lo[k]).toFixed(3)));
  assert.deepEqual(size, [CAR.width, CAR.height, CAR.length],
    'the node transforms were applied, and applied exactly once');

  // UVs arrive in TEXTURE space, already flipped out of AC's negative-V
  // convention. Getting this wrong puts the artwork on the car upside down,
  // which reads as a bad unwrap rather than as a bug in this function.
  assert.ok(Math.min(...g.uvs) >= 0 && Math.max(...g.uvs) <= 1,
    `uvs outside 0..1: ${Math.min(...g.uvs)}..${Math.max(...g.uvs)}`);

  const back = unpack(new Uint8Array(packGeometry(g)).buffer);
  assert.deepEqual([...back.positions], [...g.positions]);
  assert.deepEqual([...back.uvs], [...g.uvs]);
  assert.deepEqual([...back.indices], [...g.indices]);
});

test('a selected region turns into a highlight the shader can use', async () => {
  const { highlightUniforms } = await import('../src/ui/view3d.js');

  // "Nothing selected" has to be expressible, because it is the state the
  // editor spends most of its time in.
  for (const empty of [undefined, {}, { region: null }, { region: [] },
    { region: [0.1, 0.1, 0, 0.4] }, { region: [0.1, 0.1, 0.4, 0] }]) {
    assert.deepEqual(highlightUniforms(empty).region, [0, 0, 0, 0], JSON.stringify(empty));
  }
  // NaN reaches here from a drag in progress. A NaN uniform does not throw; it
  // silently fails every comparison in the shader, so the highlight vanishes
  // and the car looks like the feature is broken.
  assert.deepEqual(highlightUniforms({ region: [NaN, 0, NaN, 0.2] }).region, [0, 0, 0, 0]);

  const big = highlightUniforms({ region: [0.1, 0.2, 0.5, 0.4] });
  assert.deepEqual(big.region, [0.1, 0.2, 0.5, 0.4], 'passed through in texture space');
  assert.equal(big.border, 0.0025, 'an ordinary region gets the fixed thin edge');

  // A region a few texels across must not come out as a solid block of accent —
  // at that size a fixed border meets itself in the middle.
  const tiny = highlightUniforms({ region: [0.5, 0.5, 0.004, 0.006] });
  assert.ok(tiny.border < 0.004 / 2, `border ${tiny.border} would swallow a 0.004-wide region`);
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

  // Ids app.js CREATES at runtime must not collide with ids the page already
  // has. querySelector takes the first in document order, so an injected
  // element earlier in the tree silently steals every lookup of that name from
  // the real one — which is how a `<datalist id="palette">` in the inspector
  // came to intercept the palette panel on the right.
  const made = [...new Set([...app.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]))];
  const clash = made.filter((id) => ids.includes(id));
  assert.deepEqual(clash, [], 'app.js builds ids the static page already uses');

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

test('the camera matrices compose in the convention GLSL reads them', async () => {
  // perspective() and lookAt() build COLUMN-major arrays, which is what
  // uniformMatrix4fv(transpose = false) expects, and mul() was originally a
  // row-major multiply. The composed matrix put geometry behind the eye — a
  // vertex that should land at w = 4.7 came out at w = -0.3 — so the viewport
  // showed the inside of the car with every letter mirrored.
  const { _internal } = await import('../src/ui/view3d.js');
  const { perspective, lookAt, mul } = _internal;

  // Apply a column-major matrix the way the shader does.
  const apply = (m, v) => [0, 1, 2, 3].map((r) =>
    m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);

  const P = perspective(0.8, 1.4, 0.05, 100);
  const V = lookAt([3, 2, 5], [0, 0.7, 0], [0, 1, 0]);
  const mvp = mul(P, V);

  for (const pt of [[0, 0.7, 0, 1], [1, 0.5, -1.8, 1], [-0.9, 1.6, 2, 1]]) {
    const stepwise = apply(P, apply(V, pt));
    const composed = apply(mvp, pt);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(stepwise[i] - composed[i]) < 1e-6,
        `composing P and V must equal applying them in turn: ${composed} vs ${stepwise}`);
    }
  }

  // And the car must be IN FRONT of the camera: w > 0 for a point at the
  // target, which is the check that would have caught the inside-out view.
  const [, , , w] = apply(mvp, [0, 0.7, 0, 1]);
  assert.ok(w > 0, `the look-at target must be in front of the eye, got w = ${w}`);
});

test('the whole car packs every mesh exactly once, painted or not', async () => {
  const { wholeModelGeometry, packModel } = await import('../src/ui/server.mjs');
  const { unpackModel } = await import('../src/ui/view3d.js');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const model = parseKn5Buffer(carKn5());
  const g = wholeModelGeometry(model, [{ role: 'body', file: CAR.texture }]);

  // Every triangle in the model is drawn by exactly one group. Drawing one
  // twice is invisible on an opaque mesh and doubles the cost; missing one
  // leaves a hole that reads as a broken export rather than an unpainted part.
  const total = g.groups.reduce((s, x) => s + x.count, 0);
  assert.equal(total, g.indices.length, 'the groups must tile the index buffer');
  const covered = new Array(g.indices.length).fill(0);
  for (const x of g.groups) for (let i = x.start; i < x.start + x.count; i++) covered[i]++;
  assert.ok(covered.every((n) => n === 1), 'no triangle drawn twice or skipped');

  const back = unpackModel(new Uint8Array(packModel(g)).buffer);
  assert.deepEqual([...back.positions], [...g.positions]);
  assert.deepEqual([...back.uvs], [...g.uvs]);
  assert.deepEqual([...back.indices], [...g.indices]);
  assert.deepEqual(back.groups, g.groups);
});

test('the whole-car header is padded so typed arrays can view the buffer', async () => {
  // Float32Array over a buffer must start on a multiple of four. The header is
  // arbitrary-length JSON, so without padding this throws on three payloads out
  // of four — and which three depends on how long the role names happen to be.
  const { packModel } = await import('../src/ui/server.mjs');
  const { unpackModel } = await import('../src/ui/view3d.js');

  for (const role of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    const g = {
      positions: Float32Array.from([0, 1, 2]),
      uvs: Float32Array.from([0, 1]),
      normals: Float32Array.from([0, 1, 0]),
      indices: Uint32Array.from([0]),
      groups: [{ role, file: `${role}.dds`, start: 0, count: 1 }],
      bounds: { lo: [0, 0, 0], hi: [1, 1, 1] },
    };
    const buf = new Uint8Array(packModel(g)).buffer;
    const back = unpackModel(buf);          // throws on a misaligned offset
    assert.equal(back.groups[0].role, role);
    assert.deepEqual([...back.positions], [0, 1, 2]);
    // The normals share the alignment problem and are the newest array, so they
    // are the one most likely to be read from the wrong offset.
    assert.deepEqual([...back.normals], [0, 1, 0]);
  }
});

test('an unpainted mesh still reaches the viewer, in its own group', async () => {
  const { wholeModelGeometry } = await import('../src/ui/server.mjs');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const model = parseKn5Buffer(carKn5());
  // A livery that paints nothing at all: every triangle should still be there,
  // in the roleless group the viewer draws grey.
  const none = wholeModelGeometry(model, []);
  assert.equal(none.groups.length, 1);
  assert.equal(none.groups[0].role, null);
  assert.equal(none.groups[0].count, none.indices.length, 'all of it, unpainted');

  const all = wholeModelGeometry(model, [{ role: 'body', file: CAR.texture }]);
  assert.equal(all.indices.length, none.indices.length,
    'painting a surface must not change how much car there is');
  assert.deepEqual(all.groups.map((x) => x.role), ['body'],
    'with the only texture painted there is nothing left over');
});

test('a ray finds the texel under it, not merely the triangle', async () => {
  const { rayTriangle, cameraRay } = await import('../src/ui/view3d.js');

  // A unit triangle in the z = 0 plane, seen from straight in front.
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0];
  const straightOn = rayTriangle([0.25, 0.25, 5], [0, 0, -1], a, b, c);
  assert.ok(straightOn, 'a ray aimed at the middle should hit');
  assert.equal(Number(straightOn.dist.toFixed(6)), 5);
  // Barycentrics: u weights the second corner, v the third, and 1-u-v the first.
  assert.equal(Number(straightOn.u.toFixed(6)), 0.25);
  assert.equal(Number(straightOn.v.toFixed(6)), 0.25);

  assert.equal(rayTriangle([2, 2, 5], [0, 0, -1], a, b, c), null, 'a miss is a miss');
  assert.equal(rayTriangle([0.25, 0.25, -5], [0, 0, -1], a, b, c), null,
    'geometry behind the eye must not be pickable — it is not on screen');
  // Winding is not culled: car meshes are not reliably wound one way, and a
  // triangle you can plainly see should be pickable from the side you see it.
  assert.ok(rayTriangle([0.25, 0.25, -5], [0, 0, 1], a, b, c), 'hit from behind');
});

test('the camera ray points where the pixel is', async () => {
  const { cameraRay } = await import('../src/ui/view3d.js');
  const eye = [0, 0, 5], target = [0, 0, 0], up = [0, 1, 0];

  const centre = cameraRay(eye, target, up, 0.8, 1, 0, 0);
  assert.deepEqual(centre.dir.map((n) => Number(n.toFixed(6))), [0, 0, -1],
    'the middle of the canvas looks straight at the target');
  assert.deepEqual(centre.orig, eye);

  // Up on screen is up in the world; right on screen is +x when looking down -z.
  assert.ok(cameraRay(eye, target, up, 0.8, 1, 0, 0.9).dir[1] > 0, 'up is up');
  assert.ok(cameraRay(eye, target, up, 0.8, 1, 0.9, 0).dir[0] > 0, 'right is right');

  // Aspect stretches horizontally only — a wide canvas must not also widen the
  // vertical field, which would make the picked point drift from the cursor.
  const wide = cameraRay(eye, target, up, 0.8, 2, 0.5, 0.5);
  const square = cameraRay(eye, target, up, 0.8, 1, 0.5, 0.5);
  assert.ok(Math.abs(wide.dir[0]) > Math.abs(square.dir[0]));
  assert.equal(Number((wide.dir[1] / wide.dir[2]).toFixed(6)),
    Number((square.dir[1] / square.dir[2]).toFixed(6)));
});

test('picking a face of the fixture car returns that face’s UV', async () => {
  // The end-to-end claim: a ray cast at a known face comes back with the texture
  // coordinate that face was unwrapped to. This is the arithmetic behind
  // dragging a region on the car, and it is checkable without a GPU.
  const { rayTriangle, cameraRay } = await import('../src/ui/view3d.js');
  const { modelGeometry } = await import('../src/ui/server.mjs');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const g = modelGeometry(parseKn5Buffer(carKn5()), CAR.texture);
  // Looking at the car's left flank (+x) from outside it.
  const eye = [6, CAR.height / 2, 0];
  const { orig, dir } = cameraRay(eye, [0, CAR.height / 2, 0], [0, 1, 0], 0.8, 1, 0, 0);

  let best = null;
  const at = (i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [ia, ib, ic] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    const hit = rayTriangle(orig, dir, at(ia), at(ib), at(ic));
    if (hit && (!best || hit.dist < best.dist)) best = { ...hit, ia, ib, ic };
  }
  assert.ok(best, 'the ray should meet the car');

  const w = 1 - best.u - best.v;
  const uv = (k) => g.uvs[best.ia * 2 + k] * w + g.uvs[best.ib * 2 + k] * best.u
    + g.uvs[best.ic * 2 + k] * best.v;
  const [rx, ry, rw, rh] = CAR.faces.left;
  assert.ok(uv(0) >= rx && uv(0) <= rx + rw && uv(1) >= ry && uv(1) <= ry + rh,
    `hit landed at ${uv(0).toFixed(3)},${uv(1).toFixed(3)}, outside the left flank ${CAR.faces.left}`);
  // Dead centre of the flank, so dead centre of its island.
  assert.equal(Number(uv(0).toFixed(3)), Number((rx + rw / 2).toFixed(3)));
  assert.equal(Number(uv(1).toFixed(3)), Number((ry + rh / 2).toFixed(3)));
});

test('a pointer on the car decides between orbit, select, move and resize', async () => {
  // The GL-dependent browser test can only run where a GL driver exists, and a
  // headless box often has none. This is the same decision logic with the pick
  // handed in directly: what a pointer does is a function of where it landed and
  // what is selected, and none of that needs a GPU.
  //
  // The rectangles are set here rather than taken from the livery, because the
  // example paints its whole sheet and leaves no bare texture to aim at — the
  // "miss" case would be untestable against it.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const ids = state.surfaces[0].regions.map((r) => r.id);
  const big = ids[0], small = ids[1];
  const panel = state.surfaces[0].panels[0].name;
  // Built from a real placement so every field the inspector reads is present;
  // only the rectangles are chosen.
  const like = (id, abs) => ({ ...render.placed[0], id, panel, abs });
  render.placed = [like(big, [0.1, 0.1, 0.4, 0.4]), like(small, [0.2, 0.2, 0.04, 0.04])];

  const { dom, mod } = await runApp({ state, render });
  const ev = { preventDefault() {} };
  // innerHTML, not textContent: the fake DOM stores what was written and does
  // not derive one from the other, and drawInspector writes innerHTML.
  const selected = () => dom.querySelector('#inspector').innerHTML;

  // Empty space belongs to the camera. Refusing to orbit because the ray missed
  // every region would make the model feel stuck.
  assert.equal(mod.claimCarPointer({ u: 0.9, v: 0.9 }, ev), false, 'a miss orbits');
  assert.equal(mod.claimCarPointer(null, ev), false, 'no hit at all orbits');

  // A press inside a region selects it AND claims the gesture, so the car does
  // not swing round underneath the selection just made.
  assert.equal(mod.claimCarPointer({ u: 0.4, v: 0.4 }, ev), true);
  assert.match(selected(), new RegExp(big), 'the region under the cursor is selected');

  // The smallest match wins. A background fill covering the panel sits under
  // everything else; if the largest won, it would swallow every click meant for
  // the number painted on top of it and the number would be unselectable.
  assert.equal(mod.claimCarPointer({ u: 0.21, v: 0.21 }, ev), true);
  assert.match(selected(), new RegExp(small),
    'the small region on top must win, not the fill underneath it');
});

test('a whole-car view that cannot open falls back to something usable', async () => {
  // Opening it needs WebGL and a model, and this harness has neither — which is
  // exactly the situation of anyone whose machine has no GL driver. What matters
  // is that the editor lands back on the UV view still working, rather than on a
  // dead stage. That was this editor's most persistent failure.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const id = state.surfaces[0].regions[0].id;
  const panel = state.surfaces[0].panels[0].name;
  render.placed = [{ ...render.placed[0], id, panel, abs: [0.1, 0.1, 0.4, 0.4] }];

  const { dom, mod } = await runApp({ state, render });
  dom.querySelector('#tab-all').onclick?.();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(dom.querySelector('#tab-uv').className, 'tab on', 'back on the UV tab');
  assert.equal(dom.querySelector('#tab-all').className, 'tab', 'and not still on Whole car');
  assert.equal(dom.querySelector('#texture').hidden, false, 'the sheet is visible again');
  assert.equal(dom.querySelector('#overlay').hidden, false, 'and the overlay is reachable');
  // And the editor still responds: the pointer logic did not get wedged in a
  // view that failed to open.
  assert.equal(mod.claimCarPointer({ u: 0.3, v: 0.3 }, { preventDefault() {} }), true);
});

test('the highlight carries the panel, the twin, and the twin\'s panel', async () => {
  const { highlightUniforms } = await import('../src/ui/view3d.js');

  const all = highlightUniforms({
    region: [0.2, 0.2, 0.1, 0.1],
    panel: [0.1, 0.1, 0.5, 0.5],
    twin: [0.7, 0.2, 0.1, 0.1],
    twinPanel: [0.6, 0.1, 0.5, 0.5],
  });
  assert.deepEqual(all.region, [0.2, 0.2, 0.1, 0.1]);
  assert.deepEqual(all.panel, [0.1, 0.1, 0.5, 0.5]);
  assert.deepEqual(all.twin, [0.7, 0.2, 0.1, 0.1], 'the opposite number is shown too');
  assert.deepEqual(all.twinPanel, [0.6, 0.1, 0.5, 0.5], 'and the surface it lives on');

  // Every companion rectangle is optional and independently so. A region placed
  // by absolute coordinates has no host panel; an unpaired region has no twin;
  // and claiming either would draw a boundary that constrains nothing.
  const lone = highlightUniforms({ region: [0.2, 0.2, 0.1, 0.1] });
  assert.deepEqual(lone.panel, [0, 0, 0, 0]);
  assert.deepEqual(lone.twin, [0, 0, 0, 0]);
  assert.deepEqual(lone.twinPanel, [0, 0, 0, 0]);

  for (const bad of [[0, 0, 0, 0], [0, 0, NaN, 1], null, 'x']) {
    assert.deepEqual(highlightUniforms({ region: [0.2, 0.2, 0.1, 0.1], panel: bad }).panel,
      [0, 0, 0, 0], JSON.stringify(bad));
  }

  // Nothing selected means none of it — a lone panel outline with no artwork in
  // it would say a region is there when none is.
  const nothing = highlightUniforms({ panel: [0.1, 0.1, 0.5, 0.5], twin: [0.7, 0.2, 0.1, 0.1] });
  assert.deepEqual(nothing.panel, [0, 0, 0, 0]);
  assert.deepEqual(nothing.twin, [0, 0, 0, 0]);
});

test('dragging across a boundary takes the region to the new panel', async () => {
  // Panels are an artefact of how the model was unwrapped: a door and the wing
  // behind it are one surface to look at and two panels to address. A drag that
  // stopped dead at that invisible line would be the tool imposing its own
  // bookkeeping on the person using it.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const surface = state.surfaces.find((x) => x.role === role);

  // Two panels side by side in UV, so a drag between them is unambiguous.
  const [from, to] = [
    { name: 'from_panel', rect: [0.0, 0.0, 0.2, 0.2], tags: ['left', 'mid'], anisotropy: 1 },
    { name: 'to_panel', rect: [0.5, 0.5, 0.2, 0.2], tags: ['right', 'mid'], anisotropy: 1 },
  ];
  surface.panels = [from, to];
  const id = surface.regions[0].id;
  render.placed = [{ ...render.placed[0], id, panel: from.name, abs: [0.05, 0.05, 0.05, 0.05] }];

  const { dom, window: win } = await runApp({ state, render });
  dom.querySelector('#regions').onclick({ target: { dataset: { id } } });

  // Drag far enough that the region's centre lands inside the far panel. The
  // fake overlay is 1000x1000, so a pixel is a thousandth of the texture.
  dom.querySelector('#overlay').onpointerdown({
    preventDefault() {}, clientX: 0, clientY: 0, target: { dataset: { drag: 'move' } },
  });
  win.emit('pointermove', { clientX: 570, clientY: 570 });
  win.emit('pointerup', {});
  await new Promise((r) => setTimeout(r, 20));

  const entry = JSON.parse(dom.querySelector('#fitjson').textContent).regions[id];
  assert.equal(entry.panel, 'to_panel',
    'the fit must record the panel the region landed on, not the one it left');
  // And `at` must be measured against the NEW panel. Recording the new
  // coordinates against the old rectangle is the silent version of this bug:
  // the fit reads perfectly well and puts the artwork somewhere else.
  assert.ok(entry.at.every((n) => n >= 0 && n <= 1),
    `at must be panel-relative to to_panel, got ${entry.at}`);
});

test('every shader uniform is located and every location is set', async () => {
  // A shader is the one part of this project no test here can compile — GLSL is
  // the driver's job, and headless boxes routinely have no driver. What CAN be
  // checked is the seam either side of it, which is where the mistakes actually
  // happen: adding a uniform to the source and forgetting to look up its
  // location, or looking it up and never writing to it. Neither throws. The
  // uniform silently reads zero, and a `vec4` of zeros here means "no selection"
  // — so the highlight just stops appearing, with nothing to explain why.
  const src = await readFile(new URL('../src/ui/view3d.js', import.meta.url), 'utf8');

  const declared = [...src.matchAll(/^uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);
  assert.ok(declared.includes('region') && declared.includes('panel'),
    `expected the highlight uniforms, found: ${declared}`);

  for (const name of declared) {
    assert.match(src, new RegExp(`getUniformLocation\\(prog, '${name}'\\)`),
      `the shader declares "${name}" but nothing looks up its location`);
    assert.match(src, new RegExp(`gl\\.uniform\\w+\\(loc\\.${name}\\b`),
      `nothing ever writes to "${name}" — it will read as zero forever`);
  }

  // Both draw paths must set both highlight uniforms. The grouped path
  // deliberately zeroes them, which still counts as setting them; leaving one
  // over from the previous path would dim the whole car around a rectangle that
  // means nothing on nineteen of its twenty textures.
  // Sliced from `function draw()` to the viewer's own `return {` — searched
  // FROM the draw index, because several helpers earlier in the file return
  // object literals and the first match lands well before draw() begins.
  const drawAt = src.indexOf('function draw()');
  const draw = src.slice(drawAt, src.indexOf('return {', drawAt));
  for (const name of ['region', 'panel']) {
    const writes = [...draw.matchAll(new RegExp(`loc\\.${name}\\b`, 'g'))].length;
    assert.equal(writes, 2, `draw() should set "${name}" on both paths, found ${writes}`);
  }

  // Balanced braces in each shader, which catches the copy-paste that ends a
  // function early and turns the rest of the source into a syntax error.
  for (const [which, body] of [['VS', /const VS = `([\s\S]*?)`;/], ['FS', /const FS = `([\s\S]*?)`;/]]) {
    const text = src.match(body)?.[1] ?? '';
    assert.ok(text.length, `${which} source not found`);
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    assert.equal(open, close, `${which} has ${open} { and ${close} }`);
    assert.match(text, /void main\(\)/, `${which} needs a main`);
  }
});

test('a region id that names a side finds its opposite number', async () => {
  const { partnerId } = await import('../src/ui/server.mjs');
  assert.equal(partnerId('driver-left'), 'driver-right');
  assert.equal(partnerId('driver_right'), 'driver_left');
  assert.equal(partnerId('numberLeft'), 'numberRight');
  assert.equal(partnerId('TEAM-RIGHT'), 'TEAM-LEFT');
  assert.equal(partnerId('left'), 'right');

  // Words that merely contain the letters are not sides. Without the boundary
  // checks `alright` would pair with `alleft`, which exists nowhere, and the
  // link would silently do nothing while claiming to be on.
  for (const no of ['flew', 'alright', 'rightful', 'leftover', 'brightest']) {
    assert.equal(partnerId(no), null, no);
  }
  assert.equal(partnerId(undefined), null);
  assert.equal(partnerId(42), null);
});

test('mirror pairs need both halves and mirrored panels', async () => {
  const { mirrorPairs } = await import('../src/ui/server.mjs');
  const profile = {
    panels: {
      body: {
        left_mid: { rect: [0, 0, 0.4, 0.4], mirrorOf: 'right_mid' },
        right_mid: { rect: [0.5, 0, 0.4, 0.4], mirrorOf: 'left_mid' },
        roof: { rect: [0, 0.5, 0.4, 0.4] },
      },
    },
  };
  const pairs = (regions) => mirrorPairs({ surfaces: { body: { regions } } }, profile, 'body');

  assert.deepEqual([...pairs([
    { id: 'number-left', panel: 'left_mid' },
    { id: 'number-right', panel: 'right_mid' },
  ])], [['number-left', 'number-right'], ['number-right', 'number-left']]);

  // One half missing: nothing to link to.
  assert.equal(pairs([{ id: 'number-left', panel: 'left_mid' }]).size, 0);

  // Named sides on panels that are NOT each other's mirror. A livery is free to
  // do this and it is not a mistake, but linking them would move artwork from a
  // door onto a roof and call it symmetry.
  assert.equal(pairs([
    { id: 'badge-left', panel: 'left_mid' },
    { id: 'badge-right', panel: 'roof' },
  ]).size, 0);

  // Tag-selected regions declare no panel, so there is nothing to contradict
  // and the design's own naming is taken at its word.
  assert.equal(pairs([
    { id: 'stripe-left', tags: ['left'] },
    { id: 'stripe-right', tags: ['right'] },
  ]).size, 2);
});

test('a mirror pair is linked only where the panels can be checked', async () => {
  // The rule is "if both name a panel outright those panels have to be each
  // other's mirror". Two ways to get that wrong, and both link things that
  // should not be linked or refuse things that should.
  const { mirrorPairs } = await import('../src/ui/server.mjs');
  const profile = {
    panels: {
      body: {
        left_mid: { rect: [0, 0, 0.4, 0.4], mirrorOf: 'right_mid' },
        right_mid: { rect: [0.5, 0, 0.4, 0.4], mirrorOf: 'left_mid' },
        centre_nose: { rect: [0, 0.5, 0.4, 0.4] },      // straddles the centreline
        roof: { rect: [0.5, 0.5, 0.4, 0.4] },
      },
    },
    aliases: { body: { flankLeft: 'left_mid', flankRight: 'right_mid' } },
  };
  const pairs = (regions) => mirrorPairs({ surfaces: { body: { regions } } }, profile, 'body');

  // A livery may name a panel through the profile's aliases — that is what they
  // are for. Failing to resolve them made a genuine mirror look unverifiable.
  assert.equal(pairs([
    { id: 'number-left', panel: 'flankLeft' },
    { id: 'number-right', panel: 'flankRight' },
  ]).size, 2, 'aliases resolve, exactly as the renderer resolves them');

  // A panel with no mirror IS its own: it crosses the centreline, so both halves
  // live on it, mirrored within it. A car with two numbers on its nose.
  assert.equal(pairs([
    { id: 'number-left', panel: 'centre_nose' },
    { id: 'number-right', panel: 'centre_nose' },
  ]).size, 2, 'a centreline panel is its own mirror');

  // But a two-sided panel named by both halves is not: they would stack.
  assert.equal(pairs([
    { id: 'number-left', panel: 'left_mid' },
    { id: 'number-right', panel: 'left_mid' },
  ]).size, 0, 'a panel that HAS a mirror is not its own');

  // A name that resolves to nothing cannot be shown to be anyone's mirror.
  // Linking on the grounds that the evidence is missing is how a badge ends up
  // on a roof.
  assert.equal(pairs([
    { id: 'badge-left', panel: 'no_such_panel' },
    { id: 'badge-right', panel: 'roof' },
  ]).size, 0, 'unverifiable is unlinked, not linked');
  assert.equal(pairs([
    { id: 'badge-left', panel: 'left_mid' },
    { id: 'badge-right', panel: 'no_such_panel' },
  ]).size, 0, 'and it does not matter which half is the unknown one');
});

test('the shipped example livery pairs all three of its sided regions', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const surface = state.surfaces[0];

  const linked = surface.regions.filter((r) => r.mirror).map((r) => `${r.id}->${r.mirror}`);
  assert.deepEqual(linked.sort(), [
    'driver-left->driver-right', 'driver-right->driver-left',
    'number-left->number-right', 'number-right->number-left',
    'team-left->team-right', 'team-right->team-left',
  ]);
});

test('rotating one half of a pair rotates the other', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const { dom } = await runApp({
    state: editorState({ livery, profile, fit, liveryId: 'neon-grid-any' }),
    render: renderSurface({ livery, profile, fit, role }),
  });

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });

  // The inspector's rotation buttons are found through the container, the same
  // way a pointer would find them.
  const inspector = dom.querySelector('#inspector');
  const buttons = new Map();
  inspector.querySelectorAll = (sel) => (sel === '[data-rotate]' ? [...buttons.values()] : []);
  for (const v of ['auto', '0', '90', '180', '270']) {
    buttons.set(v, { dataset: { rotate: v }, onclick: null });
  }
  inspector.querySelector = () => null;              // no mirror button in this stub
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });

  await buttons.get('90').onclick();
  const fitAfter = JSON.parse(dom.querySelector('#fitjson').textContent).regions;
  assert.equal(fitAfter['number-left'].rotate, 90);
  assert.equal(fitAfter['number-right'].rotate, 90,
    'the opposite number should have turned with it');

  // `auto` is the absence of an opinion, so it REMOVES the override rather than
  // storing a fifth angle — otherwise the design could never take the wheel
  // back on a car whose panel is laid out differently.
  await buttons.get('auto').onclick();
  const back = JSON.parse(dom.querySelector('#fitjson').textContent).regions;
  assert.equal(back['number-left'].rotate, undefined);
  assert.equal(back['number-right'].rotate, undefined);
});

test('a mirrored placement is measured, not assumed', async () => {
  const { mirrorFlips, mirrorAt, mirrorRotation } = await import('../src/fit.mjs');

  // The RSS4's two flanks, as measured from the model. Their u axes run in
  // opposite directions once one is reflected through the centreline, which is
  // why copying `at` across moved the number forward on one side and backward
  // on the other.
  const left = { uAxis: [-0.203, -0.052, -0.978], vAxis: [0.02, -0.999, 0.03] };
  const right = { uAxis: [-0.201, 0.051, 0.978], vAxis: [-0.02, -0.999, 0.03] };
  const flips = mirrorFlips(left, right);
  assert.equal(flips.u, true, 'the flanks run opposite ways along the car');
  assert.equal(flips.v, false, 'but agree about which way is up');

  // Forward on one side has to be forward on the other.
  assert.deepEqual(mirrorAt([0.1, 0.2, 0.3, 0.4], flips), [0.6, 0.2, 0.3, 0.4]);
  // Mirroring twice is the identity, which is the cheapest check that this is
  // a reflection and not a slide.
  assert.deepEqual(mirrorAt(mirrorAt([0.1, 0.2, 0.3, 0.4], flips), flips), [0.1, 0.2, 0.3, 0.4]);

  // Panels laid out the same way need no flip at all.
  const same = mirrorFlips(left, { uAxis: [0.203, -0.052, -0.978], vAxis: left.vAxis });
  assert.deepEqual(same, { u: false, v: false });
  assert.deepEqual(mirrorAt([0.1, 0.2, 0.3, 0.4], same), [0.1, 0.2, 0.3, 0.4]);

  // Rotation is decided by BOTH axes. Solving up(f) = S up(t) for the four
  // sign combinations gives one answer each, and the Abarth's flanks — u
  // reversed, v not — are the case that was wrong: a driver name rotated 270
  // was copied across as 270 and came out upside down, because the answer is
  // -t, which is 90.
  assert.equal(mirrorRotation(270, { u: true, v: false }), 90, 'the reported bug');
  assert.equal(mirrorRotation(90, { u: true, v: false }), 270);
  assert.equal(mirrorRotation(90, { u: false, v: true }), 90);
  assert.equal(mirrorRotation(0, { u: false, v: true }), 180);
  assert.equal(mirrorRotation(0, { u: true, v: true }), 180);
  assert.equal(mirrorRotation(90, { u: true, v: true }), 270);
  assert.equal(mirrorRotation(90, { u: false, v: false }), 90);

  // Upright text was right under the old rule too, which is exactly why this
  // survived: it is only wrong once something is turned.
  assert.equal(mirrorRotation(0, { u: true, v: false }), 0);

  // Mirroring twice returns where it started, for every combination. That is
  // the property the old rule quietly failed and the cheapest check that these
  // four cases are one reflection rather than four guesses.
  for (const f of [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 1, v: 1 }]) {
    const flips = { u: !!f.u, v: !!f.v };
    for (const t of [0, 90, 180, 270]) {
      assert.equal(mirrorRotation(mirrorRotation(t, flips), flips), t,
        `${t} through ${JSON.stringify(flips)} twice`);
    }
  }
  // Angles arriving unnormalised, from a fit written by hand.
  assert.equal(mirrorRotation(-90, { u: true, v: false }), 90);
  assert.equal(mirrorRotation(450, { u: false, v: false }), 90);
  // `auto` is not an angle. It defers to each panel's own measured rotation,
  // which already accounts for every bit of this.
  assert.equal(mirrorRotation('auto', { u: true, v: true }), 'auto');
  assert.equal(mirrorRotation(undefined, { u: true, v: true }), undefined);

  // A profile from before the axes were recorded reports no flip rather than
  // guessing — the old behaviour, degrading quietly.
  assert.deepEqual(mirrorFlips({}, {}), { u: false, v: false });
  assert.deepEqual(mirrorFlips({ uAxis: [1, 0, 0] }, {}), { u: false, v: false });
});

test('the shipped profiles record which way their panels run', async () => {
  // Without these the mirror silently falls back to copying, which is the bug
  // that started this. A profile that has lost them looks completely fine.
  for (const car of ['rss_formula_rss_4', 'abarth500']) {
    const p = JSON.parse(await readFile(new URL(`../cars/${car}.json`, import.meta.url), 'utf8'));
    const measured = Object.values(p.panels).flatMap((ps) => Object.values(ps))
      .filter((x) => x.confidence === 'measured');
    const withAxes = measured.filter((x) => Array.isArray(x.uAxis) && Array.isArray(x.vAxis));
    assert.ok(withAxes.length / measured.length > 0.95,
      `${car}: only ${withAxes.length} of ${measured.length} measured panels record their axes`);
  }
});

test('both copies of the mirror arithmetic agree', async () => {
  // app.js cannot import fit.mjs — that module reads files, so it opens with
  // `node:fs/promises` and the import would fail in a browser. The functions
  // are duplicated, and a divergence would be invisible: the editor would place
  // artwork one way, a rebuild from the CLI another, and the fit would look
  // perfectly reasonable in both.
  const fit = await import('../src/fit.mjs');
  const { dom } = await runApp({
    state: editorState({
      livery: (await import('../liveries/neon-grid-any.mjs')).default,
      profile: await loadProfile(new URL('../cars/abarth500.json', import.meta.url)),
      fit: null,
    }),
    render: renderSurface({
      livery: (await import('../liveries/neon-grid-any.mjs')).default,
      profile: await loadProfile(new URL('../cars/abarth500.json', import.meta.url)),
      fit: null,
      role: binding(await loadProfile(new URL('../cars/abarth500.json', import.meta.url)), 'body').roles[0],
    }),
  });
  assert.ok(dom, 'the app module loaded');
  const app = await import(`../src/ui/app.js?agree=${Math.random()}`);

  const panels = [
    { uAxis: [-0.2, 0, -0.98], vAxis: [0, -1, 0] },
    { uAxis: [-0.2, 0, 0.98], vAxis: [0, -1, 0] },
    { uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    {},
  ];
  for (const a of panels) {
    for (const b of panels) {
      assert.deepEqual(app.mirrorFlips(a, b), fit.mirrorFlips(a, b), JSON.stringify([a, b]));
      assert.deepEqual(app.selfMirrorFlips(a), fit.selfMirrorFlips(a), JSON.stringify(a));
      const flips = fit.mirrorFlips(a, b);
      for (const at of [[0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1], [0.45, 0.45, 0.1, 0.1]]) {
        assert.deepEqual(app.mirrorAt(at, flips), fit.mirrorAt(at, flips), `${at} ${JSON.stringify(flips)}`);
      }
      for (const r of ['auto', 0, 90, 180, 270, undefined]) {
        assert.deepEqual(app.mirrorRotation(r, flips), fit.mirrorRotation(r, flips), `${r}`);
      }
    }
  }
});

test('a panel that straddles the centreline is its own mirror', async () => {
  const { selfMirrorFlips, mirrorAt } = await import('../src/fit.mjs');

  // A nose, laid out the obvious way: +u runs across the car, so the centreline
  // cuts the sheet left-to-right and that is the axis to reverse.
  const nose = { uAxis: [0.98, 0.1, 0.15], vAxis: [0.05, -0.99, 0.1] };
  assert.deepEqual(selfMirrorFlips(nose), { u: true, v: false });
  assert.deepEqual(mirrorAt([0.1, 0.3, 0.2, 0.2], selfMirrorFlips(nose)), [0.7, 0.3, 0.2, 0.2]);

  // The same nose, packed sideways by the unwrapper. Now +v is the axis running
  // across the car, and reversing u would mirror it top to bottom instead —
  // both numbers stacked one above the other rather than side by side.
  const sideways = { uAxis: [0.05, -0.99, 0.1], vAxis: [0.98, 0.1, 0.15] };
  assert.deepEqual(selfMirrorFlips(sideways), { u: false, v: true });

  // Mirroring twice returns where it started, on either layout.
  for (const p of [nose, sideways]) {
    const f = selfMirrorFlips(p);
    assert.deepEqual(mirrorAt(mirrorAt([0.1, 0.3, 0.2, 0.2], f), f), [0.1, 0.3, 0.2, 0.2]);
  }

  // Nothing measured: no flip, rather than a guess about which way is across.
  assert.deepEqual(selfMirrorFlips({}), { u: false, v: false });
  assert.deepEqual(selfMirrorFlips(undefined), { u: false, v: false });
});

test('dragging one half of a pair onto a shared panel brings the other with it', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const surface = state.surfaces.find((x) => x.role === role);

  // A flank with a mirror, and a nose with none — the two cases.
  const flankL = { name: 'flankL', rect: [0, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'flankR', uAxis: [-0.2, 0, -0.98], vAxis: [0, -1, 0] };
  const flankR = { name: 'flankR', rect: [0.25, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'flankL', uAxis: [-0.2, 0, 0.98], vAxis: [0, -1, 0] };
  const nose = { name: 'nose', rect: [0.5, 0.5, 0.4, 0.4], tags: [], anisotropy: 1,
    uAxis: [0.98, 0, 0.1], vAxis: [0, -1, 0] };
  surface.panels = [flankL, flankR, nose];
  render.placed = [
    { ...render.placed[0], id: 'number-left', panel: 'flankL', abs: [0.02, 0.02, 0.05, 0.05] },
    { ...render.placed[0], id: 'number-right', panel: 'flankR', abs: [0.27, 0.02, 0.05, 0.05] },
  ];

  const { dom, window: win } = await runApp({ state, render });
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });

  // Drag the left one onto the nose. The overlay is 1000x1000 in the harness.
  dom.querySelector('#overlay').onpointerdown({
    preventDefault() {}, clientX: 0, clientY: 0, target: { dataset: { drag: 'move' } },
  });
  win.emit('pointermove', { clientX: 660, clientY: 660 });
  win.emit('pointerup', {});
  await new Promise((r) => setTimeout(r, 30));

  const regions = JSON.parse(dom.querySelector('#fitjson').textContent).regions;
  assert.equal(regions['number-left'].panel, 'nose', 'the dragged half landed on the nose');
  assert.equal(regions['number-right'].panel, 'nose',
    'and its opposite number followed, rather than being left behind on a flank');

  // Mirrored WITHIN the nose, not stacked on top of it. Two regions at the same
  // place would render as one and look like the pair had silently collapsed.
  const { selfMirrorFlips, mirrorAt } = await import('../src/fit.mjs');
  assert.deepEqual(regions['number-right'].at,
    mirrorAt(regions['number-left'].at, selfMirrorFlips(nose)));
  assert.notDeepEqual(regions['number-right'].at, regions['number-left'].at,
    'the two halves must not end up in the same place');
});

test('a pair can be declared, mirrored once, and severed', async () => {
  // The naming convention is a guess about what a design meant by its ids. A
  // livery is free to call its halves anything, so the person looking at the
  // car has to be able to say "these two are one idea" — and to take it back.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const surface = state.surfaces.find((x) => x.role === role);

  const flankL = { name: 'flankL', rect: [0, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'flankR', uAxis: [-0.2, 0, -0.98], vAxis: [0, -1, 0] };
  const flankR = { name: 'flankR', rect: [0.25, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'flankL', uAxis: [-0.2, 0, 0.98], vAxis: [0, -1, 0] };
  surface.panels = [flankL, flankR];

  // Two regions the convention will NOT pair: no side in either name.
  surface.regions = [
    { ...surface.regions[0], id: 'badgeA', panel: 'flankL', mirror: null },
    { ...surface.regions[1], id: 'badgeB', panel: 'flankR', mirror: null },
  ];
  render.placed = [
    { ...render.placed[0], id: 'badgeA', panel: 'flankL', abs: [0.02, 0.02, 0.05, 0.05] },
    { ...render.placed[0], id: 'badgeB', panel: 'flankR', abs: [0.40, 0.14, 0.05, 0.05] },
  ];

  const { dom, mod } = await runApp({ state, render });
  const inspector = dom.querySelector('#inspector');

  // The stub inspector has to answer for the controls the real one writes.
  const nodes = new Map();
  inspector.querySelector = (sel) => nodes.get(sel) ?? null;
  inspector.querySelectorAll = () => [];
  const stub = (sel, extra = {}) => { const n = { onclick: null, onchange: null, ...extra }; nodes.set(sel, n); return n; };
  const pairwith = stub('#pairwith', { value: 'badgeB' });
  stub('#mirror'); const mirrornow = stub('#mirrornow'); const unpair = stub('#unpair');
  stub('#mirrorcreate'); stub('#duplicate');

  // The controls are always present and disabled when they would do nothing, so
  // the assertions are about STATE rather than about what exists.
  const disabled = (which) => new RegExp(`id="${which}"[^>]*\\sdisabled`).test(inspector.innerHTML);

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badgeA' } } });
  assert.equal(disabled('pairwith'), false, 'an unpaired region can be paired');
  assert.equal(disabled('mirrorcreate'), false, 'or have its other half created');
  assert.equal(disabled('unpair'), true, 'and has nothing to unpair');
  assert.equal(disabled('mirror'), true, 'and no link to break');

  // Declaring the pair must mirror IMMEDIATELY. Otherwise it appears to do
  // nothing, and the only way to find out whether it worked is to drag
  // something and hope.
  await pairwith.onchange();
  const { mirrorFlips, mirrorAt } = await import('../src/fit.mjs');
  const flips = mirrorFlips(flankL, flankR);
  let regions = JSON.parse(dom.querySelector('#fitjson').textContent).regions;
  assert.ok(regions.badgeA?.at, 'the pairing wrote a placement for the region itself');
  assert.deepEqual(regions.badgeB.at, mirrorAt(regions.badgeA.at, flips),
    'and put its new partner at the mirrored position straight away');

  // Severing it. The convention cannot be argued with by deleting a map entry —
  // there is no entry — so unpairing has to record the severance.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badgeA' } } });
  assert.equal(disabled('unpair'), false, 'a paired region can be unpaired');
  assert.equal(disabled('pairwith'), true, 'and cannot be paired with a third');
  unpair.onclick();
  assert.equal(disabled('unpair'), true, 'a severed region is unpaired again');

  // And re-pairing after severing has to work, or unpair would be permanent
  // for the session and the dropdown would silently do nothing.
  await pairwith.onchange();
  assert.equal(disabled('unpair'), false, 'declared again');
  assert.ok(mirrornow.onclick, 'and the one-shot is wired while paired');
});

test('mirror now does not quietly re-link a pair somebody separated', async () => {
  // The one-shot exists for exactly this case: two sides deliberately editing
  // apart, and a single copy across wanted without giving up that decision.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const surface = state.surfaces.find((x) => x.role === role);
  surface.panels = [
    { name: 'L', rect: [0, 0, 0.2, 0.2], tags: [], anisotropy: 1, mirrorOf: 'R', uAxis: [-0.2, 0, -0.98], vAxis: [0, -1, 0] },
    { name: 'R', rect: [0.25, 0, 0.2, 0.2], tags: [], anisotropy: 1, mirrorOf: 'L', uAxis: [-0.2, 0, 0.98], vAxis: [0, -1, 0] },
  ];
  render.placed = [
    { ...render.placed[0], id: 'number-left', panel: 'L', abs: [0.02, 0.02, 0.05, 0.05] },
    { ...render.placed[0], id: 'number-right', panel: 'R', abs: [0.40, 0.14, 0.05, 0.05] },
  ];

  const { dom } = await runApp({ state, render });
  const inspector = dom.querySelector('#inspector');
  const nodes = new Map();
  inspector.querySelector = (sel) => nodes.get(sel) ?? null;
  inspector.querySelectorAll = () => [];
  const mk = (sel) => { const n = { onclick: null, onchange: null }; nodes.set(sel, n); return n; };
  const mirror = mk('#mirror'); const mirrornow = mk('#mirrornow'); mk('#unpair');

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  mirror.onclick();                                  // separate the two sides
  assert.match(inspector.innerHTML, /independent/, 'the sides are now independent');

  await mirrornow.onclick();
  assert.match(dom.querySelector('#inspector').innerHTML, /independent/,
    'a one-shot must leave them independent, not silently re-link them');
});

test('a mirrored copy renders through the same path a build uses', async () => {
  // The editor writing a fit nobody else understands would be worse than no
  // feature. This goes through applyFit — the one function both the editor and
  // the CLI use — so a mirrored copy is a property of the FIT, not of the tool
  // that happened to create it.
  const { applyFit } = await import('../src/fit.mjs');
  const profile = {
    panels: { body: { L: { rect: [0, 0, 0.4, 0.4] }, R: { rect: [0.5, 0, 0.4, 0.4] } } },
  };
  const regions = [{ id: 'badge', panel: 'L', treatment: 'text', text: 'AC', color: 'ink' }];
  const fit = {
    livery: 'x', car: 'y',
    mirrors: { 'badge-mirror': { of: 'badge', panel: 'R', at: [0.3, 0.2, 0.2, 0.2] } },
  };

  const used = new Set();
  const notes = [];
  const out = applyFit(regions, fit, { profile, role: 'body', surfaceKey: 'paint.body', used, notes });

  assert.equal(out.regions.length, 2, 'the copy is drawn alongside the original');
  const copy = out.regions.find((r) => r.__key === 'badge-mirror');
  assert.ok(copy, 'the copy is addressable by its own id');

  // It INHERITS the artwork and overrides only the placement. A fit that could
  // set colours or text would be a second livery language wearing a disguise.
  assert.equal(copy.treatment, 'text');
  assert.equal(copy.text, 'AC');
  assert.equal(copy.color, 'ink');
  assert.equal(copy.panel, 'R');
  assert.deepEqual(copy.at, [0.3, 0.2, 0.2, 0.2]);
  assert.notEqual(copy, out.regions[0], 'and it is a copy, not the same object');

  // Both ids count as used, or the editor would report the source as a stale
  // fit entry the moment it became somebody's mirror.
  assert.ok(used.has('badge-mirror') && used.has('badge'));
  assert.deepEqual(notes, []);
});

test('a mirrored copy pointing at a panel the car lacks is reported, not drawn', async () => {
  const { applyFit } = await import('../src/fit.mjs');
  const profile = { panels: { body: { L: { rect: [0, 0, 0.4, 0.4] } } } };
  const notes = [];
  const out = applyFit(
    [{ id: 'badge', panel: 'L', treatment: 'fill' }],
    { livery: 'x', car: 'y', mirrors: { 'badge-mirror': { of: 'badge', panel: 'GONE' } } },
    { profile, role: 'body', surfaceKey: 'paint.body', notes },
  );
  assert.equal(out.regions.length, 1, 'nothing is drawn on a panel that does not exist');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /GONE/);
});

test('mirrors on other surfaces are skipped in silence', async () => {
  // applyFit runs once per surface. Reporting every other surface's mirrors as
  // stale would bury the real notes under one line per surface per mirror.
  const { applyFit, unusedFitIds } = await import('../src/fit.mjs');
  const profile = { panels: { body: { L: { rect: [0, 0, 0.4, 0.4] } } } };
  const notes = [];
  const used = new Set();
  applyFit(
    [{ id: 'badge', panel: 'L', treatment: 'fill' }],
    { livery: 'x', car: 'y', mirrors: { elsewhere: { of: 'a-region-on-the-suit', panel: 'L' } } },
    { profile, role: 'body', surfaceKey: 'paint.body', used, notes },
  );
  assert.deepEqual(notes, []);
  // But it is still counted as unused overall, so a mirror pointing at nothing
  // anywhere is reported once, by the caller that can see every surface.
  assert.deepEqual(unusedFitIds({ mirrors: { elsewhere: {} } }, used), ['elsewhere']);
});

test('creating a mirrored copy writes it into the fit and lists it', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit: null, liveryId: 'neon-grid-any' });
  const render = renderSurface({ livery, profile, fit: null, role });
  const surface = state.surfaces.find((x) => x.role === role);
  const L = { name: 'L', rect: [0, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'R', uAxis: [-0.2, 0, -0.98], vAxis: [0, -1, 0] };
  const R = { name: 'R', rect: [0.25, 0, 0.2, 0.2], tags: [], anisotropy: 1,
    mirrorOf: 'L', uAxis: [-0.2, 0, 0.98], vAxis: [0, -1, 0] };
  surface.panels = [L, R];
  surface.regions = [{ ...surface.regions[0], id: 'badge', panel: 'L', mirror: null }];
  render.placed = [{ ...render.placed[0], id: 'badge', panel: 'L', abs: [0.02, 0.02, 0.05, 0.05] }];

  const { dom } = await runApp({ state, render });
  const inspector = dom.querySelector('#inspector');
  const nodes = new Map();
  inspector.querySelector = (sel) => nodes.get(sel) ?? null;
  inspector.querySelectorAll = () => [];
  const create = { onclick: null };
  nodes.set('#mirrorcreate', create);
  nodes.set('#duplicate', { onclick: null });

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  assert.match(inspector.innerHTML, /Create mirrored copy/,
    'an unpaired region should offer to have its other half made');

  await create.onclick();

  const fit = JSON.parse(dom.querySelector('#fitjson').textContent);
  const copy = fit.copies?.['badge-mirror'];
  assert.ok(copy, `no mirrored copy was written: ${JSON.stringify(fit)}`);
  assert.equal(copy.of, 'badge');
  assert.equal(copy.panel, 'R', 'it goes on the measured mirror of the source panel');

  const { mirrorFlips, mirrorAt, toPanelRelative } = await import('../src/fit.mjs');
  const at = toPanelRelative(L.rect, [0.02, 0.02, 0.05, 0.05]);
  assert.deepEqual(copy.at, mirrorAt(at, mirrorFlips(L, R)),
    'and at the mirrored position, using the measured flip');
});

test('duplicating a region writes it into the design, unpaired', async () => {
  // A duplicate used to be written into the FIT, which was the one place the
  // fit/design line was crossed for convenience rather than for a reason. A
  // mirrored copy says "this car has two flanks", which a design cannot know; a
  // duplicate says "I want two badges", which is true of every car.
  const server = copyFixture();
  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom,
    ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#duplicate').onclick();

  const fit = JSON.parse(dom.querySelector('#fitjson').textContent);
  assert.deepEqual(fit.copies ?? {}, {}, 'nothing about this belongs to one car');

  const regions = JSON.parse(dom.querySelector('#designjson').textContent).surfaces.body.regions;
  const copy = regions.find((r) => r.id === 'badge-copy');
  const source = regions.find((r) => r.id === 'badge');
  assert.ok(copy, `no duplicate in the design: ${JSON.stringify(regions)}`);
  assert.equal(copy.treatment, source.treatment, 'it carries the artwork, not a reference to it');
  assert.equal(copy.color, source.color);
  assert.equal(copy.panel, 'L', 'and stays on the same panel');

  // OFFSET, not stacked. A duplicate hidden under its original looks exactly
  // like the button did nothing, and the way to discover otherwise is to drag
  // the one you can see and find a second underneath.
  assert.notDeepEqual(copy.at, source.at, 'a duplicate must not sit exactly on top');
  assert.ok(copy.at[0] > source.at[0] && copy.at[1] > source.at[1], `offset: ${copy.at}`);
  assert.ok(copy.at.every((n) => n >= 0 && n <= 1), `still panel-relative: ${copy.at}`);
  assert.deepEqual(copy.at.slice(2), source.at.slice(2), 'and keeps its size');

  // Not paired with its source: two badges on one panel are two things, and
  // linking them would make every edit move both.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge-copy' } } });
  const inspector = dom.querySelector('#inspector').innerHTML;
  assert.match(inspector, /data-linked="false"/);
  assert.match(inspector, /not paired/, 'two badges on one panel are two things');
});

test('both spellings of a copy block load, and copies wins', async () => {
  // `mirrors` was the first name, before duplicating without mirroring turned
  // out to be the same feature. Fits written in the last hour keep working.
  const { copiesOf, validateFit } = await import('../src/fit.mjs');
  assert.deepEqual(copiesOf({ mirrors: { a: { of: 'x' } } }), { a: { of: 'x' } });
  assert.deepEqual(copiesOf({ copies: { a: { of: 'x' } } }), { a: { of: 'x' } });
  assert.deepEqual(copiesOf({}), {});
  assert.deepEqual(copiesOf(null), {});
  assert.deepEqual(
    copiesOf({ mirrors: { a: { of: 'old' } }, copies: { a: { of: 'new' } } }),
    { a: { of: 'new' } }, 'the current spelling wins a collision');

  // And validation covers both, so an old fit cannot smuggle in a field the
  // new one would reject.
  assert.throws(() => validateFit({ livery: 'x', car: 'y', mirrors: { a: { of: 'b', color: 'red' } } }),
    /may not set "color"/);
});

test('undo steps back through several actions, and redo forward again', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const { dom } = await runApp({
    state: editorState({ livery, profile, fit, liveryId: 'neon-grid-any' }),
    render: renderSurface({ livery, profile, fit, role }),
  });

  const inspector = dom.querySelector('#inspector');
  const buttons = new Map();
  inspector.querySelectorAll = (sel) => (sel === '[data-rotate]' ? [...buttons.values()] : []);
  inspector.querySelector = () => null;
  for (const v of ['auto', '0', '90', '180', '270']) buttons.set(v, { dataset: { rotate: v }, onclick: null });

  const rot = () => JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left']?.rotate;
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  const start = rot();

  assert.equal(dom.querySelector('#undo').disabled, true, 'nothing to undo yet');

  await buttons.get('90').onclick();
  await buttons.get('180').onclick();
  await buttons.get('270').onclick();
  assert.equal(rot(), 270);
  assert.equal(dom.querySelector('#undo').disabled, false);

  // MULTIPLE steps back, which is the whole ask.
  await dom.querySelector('#undo').onclick();
  assert.equal(rot(), 180, 'one step back');
  await dom.querySelector('#undo').onclick();
  assert.equal(rot(), 90, 'two steps back');
  await dom.querySelector('#undo').onclick();
  assert.equal(rot(), start, 'back to where it started');
  assert.equal(dom.querySelector('#undo').disabled, true, 'and there is no further back');

  // Forward again.
  await dom.querySelector('#redo').onclick();
  assert.equal(rot(), 90);
  await dom.querySelector('#redo').onclick();
  assert.equal(rot(), 180);

  // A new action abandons the redo branch — keeping it would let a redo jump to
  // a state that no longer follows from anything.
  await buttons.get('0').onclick();
  assert.equal(dom.querySelector('#redo').disabled, true, 'the redo branch is gone');
  assert.equal(rot(), 0);
});

test('undo restores regions an edit created, and removes ones it did not', async () => {
  // Undo has to cope with the SET of regions changing, not just their
  // placements. Undoing a duplicate removes one; redo brings it back. It has to
  // reach the DESIGN as well as the fit now, because that is where a duplicate
  // lands — a stack that restored half the editor would be worse than none.
  const server = copyFixture();
  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom,
    ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);

  const ids = () => JSON.parse(dom.querySelector('#designjson').textContent)
    .surfaces.body.regions.map((r) => r.id);

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#duplicate').onclick();
  assert.deepEqual(ids(), ['badge', 'badge-copy'], 'the duplicate exists');

  await dom.querySelector('#undo').onclick();
  assert.deepEqual(ids(), ['badge'], 'undo removed the region it created');
  assert.doesNotMatch(dom.querySelector('#regions').innerHTML, /badge-copy/,
    'and the list came back in step with it');

  await dom.querySelector('#redo').onclick();
  assert.deepEqual(ids(), ['badge', 'badge-copy'], 'and redo brought it back');
});

test('a drag is one undo step, not one per pointer event', async () => {
  // The stack has to hold ACTIONS. Remembering per pointermove would fill it
  // with intermediate positions of one gesture and make undo mean "go back four
  // pixels" — technically correct and completely useless.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const { dom, window: win } = await runApp({
    state: editorState({ livery, profile, fit, liveryId: 'neon-grid-any' }),
    render: renderSurface({ livery, profile, fit, role }),
  });

  const at = () => JSON.parse(dom.querySelector('#fitjson').textContent).regions['number-left'].at;
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'number-left' } } });
  const before = at();

  dom.querySelector('#overlay').onpointerdown({
    preventDefault() {}, clientX: 100, clientY: 100, target: { dataset: { drag: 'move' } },
  });
  // Ten moves. One gesture.
  for (let i = 1; i <= 10; i++) win.emit('pointermove', { clientX: 100 + i * 10, clientY: 100 + i * 10 });
  win.emit('pointerup', {});
  await new Promise((r) => setTimeout(r, 30));
  assert.notDeepEqual(at(), before, 'the drag landed');

  await dom.querySelector('#undo').onclick();
  assert.deepEqual(at(), before, 'ONE undo returns to before the whole gesture');
  assert.equal(dom.querySelector('#undo').disabled, true, 'and there is nothing behind it');
});

// --- copies, end to end -----------------------------------------------------
//
// The tests above check that a copy is WRITTEN into the fit. That is half the
// story: a copy that renders on the car and is missing from the region list is
// worse than one that was never made, because it is there, it is wrong, and
// there is no way to select it to say so. So these drive the real editorState
// and renderSurface, answered from the working fit exactly as the server does.

/** A two-panel car and a design with one badge on the left of it. */
function copyFixture() {
  const axis = (u, v) => ({ uAxis: u, vAxis: v });
  const profile = {
    id: 'fixture',
    name: 'Fixture',
    textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    bind: { body: { roles: ['body'], source: 'human' } },
    panels: {
      body: {
        L: { rect: [0, 0, 0.4, 0.4], tags: ['left'], mirrorOf: 'R', ...axis([-0.2, 0, -0.98], [0, -1, 0]) },
        R: { rect: [0.5, 0, 0.4, 0.4], tags: ['right'], mirrorOf: 'L', ...axis([-0.2, 0, 0.98], [0, -1, 0]) },
      },
    },
  };
  const livery = {
    name: 'Fixture', folder: 'fixture', car: 'fixture',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        background: 'ink',
        regions: [{ id: 'badge', panel: 'L', at: [0.1, 0.1, 0.3, 0.3], treatment: 'fill', color: 'accent' }],
      },
    },
  };
  return { livery, profile, role: 'body' };
}

/**
 * Rows inside a redrawn panel, keyed the way app.js finds them.
 *
 * The rows have to exist BEFORE the panel is wired, because wiring walks
 * `querySelectorAll` — so they are registered and then a real render is forced
 * through the app's own path rather than by calling anything private.
 */
async function panelRows(dom, sel, attr, rows) {
  const el = dom.querySelector(sel);
  const fields = new Map(rows.map(([name, part]) => [`${name}:${part}`,
    { dataset: { [attr]: name, part }, value: '', onchange: null }]));
  el.querySelectorAll = (q) => (q === `[data-${attr}]` ? [...fields.values()] : []);
  el.rowFor = (name, part) => fields.get(`${name}:${part}`);
  // A real <select> always has a value; the fake one has to be told.
  dom.querySelector('#surface').value = 'surfaces.body';
  await dom.querySelector('#surface').onchange();
  return el;
}

/** Give the fake inspector the buttons app.js looks for, and hand them back. */
function inspectorButtons(dom, names, opts = []) {
  const inspector = dom.querySelector('#inspector');
  const nodes = new Map(names.map((n) => [n, { onclick: null, onchange: null, value: '' }]));
  // Option controls are found with querySelectorAll('[data-opt]'), so they are
  // handed back keyed by the option they edit.
  const fields = new Map(opts.map(([key, kind]) => [key, {
    dataset: { opt: key, kind }, value: '', onclick: null, onchange: null,
  }]));
  inspector.querySelector = (sel) => nodes.get(sel) ?? null;
  inspector.querySelectorAll = (sel) => (sel === '[data-opt]' ? [...fields.values()] : []);
  return { nodes, fields };
}

test('editing a copy goes into the copy, not into an override of nothing', async () => {
  // Every edit went to fit.regions[id]. applyFit does not consult that for a
  // copy — the placement lives in the copies entry — so the drag appeared to do
  // nothing and snapped back on the next render. Worse, the entry stayed behind,
  // and validateFit refuses an id that is both a copy and an override: Save then
  // failed on a file the editor had written itself.
  const { validateFit } = await import('../src/fit.mjs');
  const server = copyFixture();
  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith', '#reset', '#drop']);
  const fit = () => JSON.parse(dom.querySelector('#fitjson').textContent);

  // A MIRRORED copy, which is what the fit's `copies` block is for now that a
  // duplicate goes into the design.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#mirrorcreate').onclick();

  const before = structuredClone(fit().copies['badge-mirror']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge-mirror' } } });
  dom.querySelector('#panels').onclick({ target: { dataset: { panel: 'L' } } });
  await new Promise((r) => setTimeout(r, 20));

  const after = fit();
  assert.equal(after.regions['badge-mirror'], undefined,
    'a copy must not gain an override entry — validateFit refuses a file with both');
  assert.equal(after.copies['badge-mirror'].panel, 'L', 'the move is recorded in the copy itself');
  assert.notDeepEqual(after.copies['badge-mirror'], before, 'and it actually changed');
  assert.equal(after.copies['badge-mirror'].of, 'badge', 'still a copy of the same region');

  // The whole point: the file the editor just wrote has to be loadable.
  assert.doesNotThrow(() => validateFit(after), 'Save must not reject the editor\'s own output');

  // And the placement survives the round trip rather than snapping back.
  const { applyFit } = await import('../src/fit.mjs');
  const out = applyFit(server.livery.surfaces.body.regions, after,
    { profile: server.profile, role: 'body', surfaceKey: 'body', notes: [] }).regions;
  assert.equal(out.find((r) => r.__key === 'badge-mirror').panel, 'L',
    'the renderer agrees with what the editor recorded');
});

test('a copy that cannot be placed can still be deleted', async () => {
  // A copy whose panel went away is listed but has no placement, which used to
  // take the inspector's no-placement path — Drop and Reset only. Drop writes
  // `drop` into the copy entry, which validateFit refuses outright, and Reset
  // deletes an override that was never there. So the one thing that made sense
  // was the one thing not offered.
  const server = copyFixture();
  server.fit = {
    livery: 'l', car: 'fixture',
    copies: { 'badge-gone': { of: 'badge', panel: 'no_such_panel' } },
  };
  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#delete', '#drop', '#reset', '#mirrorcreate', '#duplicate', '#mirror', '#unpair', '#mirrornow', '#pairwith']);

  assert.match(dom.querySelector('#regions').innerHTML, /badge-gone/, 'it is listed');
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge-gone' } } });
  const html = dom.querySelector('#inspector').innerHTML;
  assert.match(html, /Delete/, 'an unplaceable copy has to be removable');
  assert.doesNotMatch(html, /Drop on this car/, 'dropping a copy writes a fit that will not load');
  assert.doesNotMatch(html, /Reset/, 'and there is no design behind it to reset to');

  await buttons.get('#delete').onclick();
  assert.equal(JSON.parse(dom.querySelector('#fitjson').textContent).copies?.['badge-gone'], undefined);
});

test('a copy cannot take an id belonging to another surface', async () => {
  // Fit ids are FLAT across the livery — that is how a fit names a region
  // without knowing which texture it lives on — while applyFit runs once per
  // surface. So "is this name free?" asked of the regions in front of it is the
  // wrong question, and a copy could quietly claim a name the design uses
  // somewhere else.
  const { applyFit, allRegionKeys } = await import('../src/fit.mjs');
  const profile = { panels: { body: { L: { rect: [0, 0, 0.4, 0.4] } } } };
  const targets = [
    { from: 'body', role: 'body', spec: { regions: [{ id: 'badge', panel: 'L', treatment: 'fill' }] } },
    { from: 'suit', role: 'suit', spec: { regions: [{ id: 'sponsor', treatment: 'fill' }] } },
  ];
  const reserved = allRegionKeys(targets);
  assert.deepEqual([...reserved].sort(), ['badge', 'sponsor']);

  const notes = [];
  const { regions } = applyFit(
    targets[0].spec.regions,
    { livery: 'x', car: 'y', copies: { sponsor: { of: 'badge', panel: 'L' } } },
    { profile, role: 'body', surfaceKey: 'body', reserved, notes },
  );
  assert.deepEqual(regions.map((r) => r.__key), ['badge'], 'the copy was refused');
  assert.match(notes[0].text, /already declares/);

  // Without the reserved set it is accepted, which is the bug: the surface it
  // collides with is not the one being drawn.
  const ok = applyFit(
    targets[0].spec.regions,
    { livery: 'x', car: 'y', copies: { elsewhere: { of: 'badge', panel: 'L' } } },
    { profile, role: 'body', surfaceKey: 'body', reserved, notes: [] },
  );
  assert.deepEqual(ok.regions.map((r) => r.__key), ['badge', 'elsewhere'], 'a free name is fine');
});

test('a mirrored copy turns the rotation the design gave the source', async () => {
  // The angle was read from the fit only. A livery is free to rotate a region
  // itself, and applyFit clones the source's own `rotate` unchanged — so a
  // mirrored copy of turned artwork faced the same way as its source instead of
  // mirroring it, which on opposite flanks is upside down.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.surfaces.body.regions[0].rotate = 30;

  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#mirrorcreate').onclick();

  const copy = JSON.parse(dom.querySelector('#fitjson').textContent).copies['badge-mirror'];
  assert.ok(copy, 'the copy was made');
  assert.notEqual(copy.rotate, undefined, "the design's rotation has to reach the copy");
  assert.notEqual(copy.rotate, 30, 'and be mirrored rather than repeated');
});

test('a mirror whose target panel is missing is reported, not thrown', async () => {
  // `mirrorOf` is a name, and a profile can carry one whose target has gone.
  // Dereferencing it unchecked turned "this car has no matching panel" into a
  // TypeError from inside a click handler.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body.L.mirrorOf = 'no_such_panel';

  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#mirrorcreate').onclick();

  assert.match(dom.querySelector('#status').textContent, /does not have/,
    'it should say so rather than throw');
  assert.equal(JSON.parse(dom.querySelector('#fitjson').textContent).copies, undefined);
});

test('a created copy is listed, selectable and deletable', async () => {
  // The region list came from the SAVED fit, so a copy made in the editor was
  // rendered on the car and absent from the list: not selectable, not movable,
  // not deletable, and still written to the file on Save.
  const server = copyFixture();
  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);

  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#mirrorcreate').onclick();

  const fit = () => JSON.parse(dom.querySelector('#fitjson').textContent);
  assert.ok(fit().copies?.['badge-mirror'], `no copy written: ${JSON.stringify(fit())}`);
  assert.match(dom.querySelector('#regions').innerHTML, /badge-mirror/,
    'the copy has to appear in the region list, or it cannot be worked on at all');

  // And it can be selected, which is the thing the stale reload made impossible.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge-mirror' } } });
  assert.match(dom.querySelector('#regions').innerHTML, /class="sel[^"]*"[^>]*data-id="badge-mirror"/,
    `the copy should be the selected row: ${dom.querySelector('#regions').innerHTML}`);
  assert.match(dom.querySelector('#inspector').innerHTML, /Delete/,
    'a region the design never mentioned can only be deleted, so it must offer that');

  await buttons.get('#delete').onclick();
  assert.equal(fit().copies?.['badge-mirror'], undefined, 'delete removes it from the fit');
  assert.doesNotMatch(dom.querySelector('#regions').innerHTML, /badge-mirror/,
    'and from the list, without a save in between');
});

test('a copy of a copy is listed too, and deleting the root takes both', async () => {
  // applyFit resolves copy-of-copy in passes, so A -> B -> C is a real shape a
  // hand-written fit can have. The region list resolved one pass against the
  // design's own regions, so the third link rendered and never appeared; and
  // delete removed only direct children, leaving grandchildren naming a region
  // that no longer existed, saved that way and drawing nothing.
  //
  // Seeded rather than built through the UI: duplicating now writes the DESIGN,
  // so the only copies a fit still holds are mirrors, and a chain of them is not
  // something the editor offers to make. The shape still has to load and behave.
  const server = copyFixture();
  server.fit = {
    livery: 'l', car: 'fixture',
    copies: {
      'badge-copy': { of: 'badge', panel: 'L', at: [0.4, 0.4, 0.2, 0.2] },
      'badge-copy-copy': { of: 'badge-copy', panel: 'L', at: [0.6, 0.6, 0.2, 0.2] },
      'badge-copy-copy-copy': { of: 'badge-copy-copy', panel: 'L', at: [0.7, 0.7, 0.2, 0.2] },
    },
  };

  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom,
    ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);
  const fit = () => JSON.parse(dom.querySelector('#fitjson').textContent);
  const regions = () => dom.querySelector('#regions').innerHTML;

  // Every link is listed, including the third, which is the one a single pass
  // rendered without ever showing.
  for (const id of ['badge-copy', 'badge-copy-copy', 'badge-copy-copy-copy']) {
    assert.match(regions(), new RegExp(id), `${id} should be listed`);
  }

  // Delete the middle one. Everything descended from it has to go: a copy naming
  // a region that no longer exists is saved that way and draws nothing.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge-copy' } } });
  await buttons.get('#delete').onclick();
  assert.deepEqual(Object.keys(fit().copies ?? {}), [],
    'deleting a copy takes everything descended from it, not just its children');
  assert.doesNotMatch(regions(), /badge-copy/);
});

test('a duplicate is offset even when there is no room on the positive side', async () => {
  // The nudge was positive-only and clamped, so a region against the far edge
  // produced a copy at exactly the original's coordinates — which looks like the
  // button doing nothing, and the way to find out otherwise is to drag the one
  // you can see and discover a second underneath.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.surfaces.body.regions[0].at = [0.7, 0.7, 0.3, 0.3];   // hard against the corner

  const { dom } = await runApp({ server });
  const { nodes: buttons } = inspectorButtons(dom, ['#mirrorcreate', '#duplicate', '#delete', '#mirror', '#unpair', '#mirrornow', '#pairwith']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await buttons.get('#duplicate').onclick();

  const copy = JSON.parse(dom.querySelector('#designjson').textContent)
    .surfaces.body.regions.find((r) => r.id === 'badge-copy');
  assert.ok(copy, 'the duplicate goes into the design');
  assert.notDeepEqual(copy.at.slice(0, 2), [0.7, 0.7], 'the copy must be visibly clear of its source');
  assert.ok(copy.at[0] >= 0 && copy.at[1] >= 0, `and still inside its panel: ${copy.at}`);
});

test('a copy may not take the id of a region the livery declares', async () => {
  // Ids are how everything downstream addresses a region. Two answering to one
  // name is not a duplicate drawing, it is a region that cannot be selected or
  // updated reliably — so the design keeps the name and the copy is reported.
  const { applyFit } = await import('../src/fit.mjs');
  const profile = { panels: { body: { L: { rect: [0, 0, 0.4, 0.4] } } } };
  const notes = [];
  const { regions } = applyFit(
    [{ id: 'badge', panel: 'L', treatment: 'fill' }, { id: 'crest', panel: 'L', treatment: 'fill' }],
    { livery: 'x', car: 'y', copies: { crest: { of: 'badge', panel: 'L' } } },
    { profile, role: 'body', surfaceKey: 'paint.body', notes },
  );
  assert.deepEqual(regions.map((r) => r.__key), ['badge', 'crest']);
  assert.equal(regions.filter((r) => r.__key === 'crest').length, 1, 'one region answers to "crest"');
  assert.equal(regions.find((r) => r.__key === 'crest').treatment, 'fill');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /already declares/);
});

test('an id belonging to another surface is not reported as stale', async () => {
  // A fit is flat and applyFit runs once per surface, so a set of used ids
  // gathered from one surface knows nothing about the others. Asked per surface,
  // every override and every copy belonging to anywhere else was reported as
  // matching no region — one note per foreign id per surface, burying the real
  // ones.
  const { fitUsage } = await import('../src/ui/server.mjs');
  const { unusedFitIds } = await import('../src/fit.mjs');
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));

  assert.deepEqual(unusedFitIds(fit, fitUsage(livery, profile, fit)), [],
    'the shipped fit reaches every id it names, on one surface or another');

  // Rendering any single surface must say the same thing.
  for (const role of ['skinbase_default', 'rims']) {
    const out = renderSurface({ livery, profile, fit, role });
    assert.deepEqual(out.notes.filter((n) => n.status === 'fit-stale'), [],
      `${role} reported another surface's ids as stale: ${JSON.stringify(out.notes)}`);
  }

  // And an id that really does match nothing anywhere is still reported.
  const bogus = { ...fit, regions: { ...fit.regions, 'no-such-region': { drop: true } } };
  assert.deepEqual(unusedFitIds(bogus, fitUsage(livery, profile, bogus)), ['no-such-region']);
});

// --- the design's own options ----------------------------------------------

test('the editor offers a control for what a treatment actually takes', async () => {
  // Before this the inspector could move a region and say nothing about what it
  // was. `text` takes nine options and the only way to learn that was to read
  // the pack.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3],
    treatment: 'text', text: 'HELLO', color: 'accent',
  };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete'], [['text', 'string']]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });

  const html = dom.querySelector('#inspector').innerHTML;
  assert.match(html, /Letter spacing/, 'a described option is labelled, not left as a key');
  assert.match(html, /data-opt="tracking"/);
  assert.match(html, /placeholder="0\.08"/, "the code's default is offered as a hint, not written in");
  assert.match(html, /Copy region as JSON/);
  // Options the region does not set must not acquire a value just by appearing.
  assert.doesNotMatch(html, /data-opt="tracking"[^>]*value="0\.08"/);
});

test('changing an option changes the design and the picture, and nothing else', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3],
    treatment: 'text', text: 'HELLO', color: 'accent',
  };

  const { dom } = await runApp({ server });
  const { fields } = inspectorButtons(dom, ['#delete'], [['text', 'string'], ['tracking', 'number']]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });

  const svgBefore = dom.querySelector('#texture').innerHTML;
  fields.get('text').value = 'GOODBYE';
  await fields.get('text').onchange();

  assert.notEqual(dom.querySelector('#texture').innerHTML, svgBefore,
    'the render has to come back changed, or the control is decorative');
  assert.match(dom.querySelector('#texture').innerHTML, /GOODBYE/);

  // The DESIGN changed. The fit did not: this is not an adjustment for one car.
  assert.deepEqual(JSON.parse(dom.querySelector('#fitjson').textContent).regions ?? {}, {},
    'editing what a region IS must not write a per-car override');

  // Clearing a control removes the key rather than writing an empty value, so a
  // design says only what somebody chose.
  fields.get('tracking').value = '0.3';
  await fields.get('tracking').onchange();
  fields.get('tracking').value = '';
  await fields.get('tracking').onchange();
  assert.match(dom.querySelector('#texture').innerHTML, /GOODBYE/, 'still rendering');
});

test('a livery carrying code is not offered as data to edit', async () => {
  // JSON.stringify drops a function without a word, so a procedural design
  // edited this way would show one thing and build another. Refusing is the
  // same rule as everywhere else here, one level up.
  const { serialisableDesign } = await import('../src/livery.mjs');
  const { design, lossy } = serialisableDesign({
    name: 'L', palette: { ink: '#000' },
    surfaces: { body: { regions: [{ id: 'a', treatment: 'fill' }] } },
    render: { font: () => 'DejaVu Sans' },
  });
  assert.deepEqual(lossy, ['render.font']);
  assert.equal(design.render.font, undefined);

  // And the shipped designs are clean, which is what makes step one usable.
  for (const name of ['neon-grid', 'neon-grid-any']) {
    const livery = (await import(`../liveries/${name}.mjs`)).default;
    assert.deepEqual(serialisableDesign(livery).lossy, [], `${name} should round-trip`);
  }
});

test('the two halves agree on which fields belong to a treatment', async () => {
  // The server decides what to send as a region's options and the inspector
  // decides which to offer a control for. Two lists would drift, and the symptom
  // is a control that edits a field nobody reads. There is one list.
  const { treatmentOptions, STRUCTURAL } = await import('../src/ui/fields.js');
  const server = await readFile(new URL('../src/ui/server.mjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  for (const [name, src] of [['server.mjs', server], ['app.js', app]]) {
    assert.match(src, /from '\.\/fields\.js'/, `${name} must take the split from one place`);
  }

  // `__key` is stamped onto rendered regions by applyFit so everything
  // downstream can name one. It is bookkeeping, and an editable control for it
  // would write a field the renderer ignores.
  const region = { id: 'a', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'cyan', __key: 'a' };
  assert.deepEqual(treatmentOptions(region), { color: 'cyan' });
  assert.ok(STRUCTURAL.has('panel') && !STRUCTURAL.has('color'));
  assert.ok(!STRUCTURAL.has('scale'), 'both text treatments read scale as an option');
});

test('a treatment no pack provides is called out, not called undocumented', async () => {
  // Two different situations that had one message. A pack that shipped no
  // description still paints; a treatment name no pack provides does not paint
  // at all — renderTexture throws on it.
  //
  // Which is why this fixture DROPS the region on this car: a dropped region is
  // never handed to the renderer, so the surface still draws and the inspector
  // is reachable. Undropping it is exactly what a person would try next, and the
  // note is what tells them why they should not.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'sparkles',  // synthwave, not loaded
  };
  server.fit = { livery: 'l', car: 'fixture', regions: { badge: { drop: true } } };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete', '#drop', '#reset']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });

  const html = dom.querySelector('#inspector').innerHTML;
  assert.match(html, /cannot be painted at all/, 'say what is actually wrong');
  assert.match(html, /sparkles/);
  assert.doesNotMatch(html, /Nothing describes this treatment/,
    'that message is for a pack that shipped no description, which is a different thing');
});

test('an edit that will not parse changes nothing, and says so', async () => {
  // Returning undefined for unparseable input made `change` delete the key, so
  // typing over an existing value erased it the moment the intermediate text
  // stopped parsing — and the only sign was the artwork changing mid-keystroke.
  //
  // Checked through the RENDER rather than through the working design, which is
  // the honest place: `letter-spacing` is `size * tracking`, so losing the
  // option is visible in the SVG exactly as it would be on the car.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3],
    treatment: 'text', text: 'HELLO', tracking: 0.4,
  };

  const { dom } = await runApp({ server });
  const { fields } = inspectorButtons(dom, ['#delete'], [['tracking', 'number']]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });

  const spacing = () => /letter-spacing="([\d.]+)"/.exec(dom.querySelector('#texture').innerHTML)?.[1];
  const wide = spacing();
  assert.ok(wide, 'the text should be rendered with a letter-spacing to watch');

  // Mid-thought: a minus sign on its own is not a number yet.
  fields.get('tracking').value = '-';
  await fields.get('tracking').onchange();
  assert.equal(spacing(), wide, 'an unparseable edit must leave the value alone');
  assert.match(dom.querySelector('#status').textContent, /not a number/);

  // A real one does change it.
  fields.get('tracking').value = '0.05';
  await fields.get('tracking').onchange();
  const narrow = spacing();
  assert.notEqual(narrow, wide, 'a valid edit still gets through');

  // And cleared means "no opinion" — back to the treatment's own default of
  // 0.08, which is wider than the 0.05 just set and narrower than the 0.4 before.
  fields.get('tracking').value = '';
  await fields.get('tracking').onchange();
  assert.ok(Number(spacing()) > Number(narrow) && Number(spacing()) < Number(wide),
    `clearing should fall back to the treatment's default, got ${spacing()}`);
});

test('a region can be added to the design, ordered, and taken out again', async () => {
  // Order IS paint order — later regions draw over earlier ones — so moving a
  // row is not a cosmetic nicety, it is the only way to say what covers what.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom } = await runApp({ server });
  const { nodes } = inspectorButtons(dom,
    ['#delete', '#earlier', '#later', '#removeregion', '#copyregion', '#reset', '#drop']);

  // The picker offers what the design's packs actually provide.
  assert.match(dom.querySelector('#newtreatment').innerHTML, /value="fill"/);
  assert.match(dom.querySelector('#newtreatment').innerHTML, /Halftone dissolve/);

  dom.querySelector('#newtreatment').value = 'stripe';
  await dom.querySelector('#addregion').onclick();

  const design = () => JSON.parse(dom.querySelector('#designjson').textContent);
  let regions = design().surfaces.body.regions;
  assert.deepEqual(regions.map((r) => r.id), ['badge', 'stripe'], 'added, and added last');
  assert.match(dom.querySelector('#regions').innerHTML, /stripe/, 'and listed');

  // Painting earlier means moving down the array, which is what the button says.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'stripe' } } });
  await nodes.get('#earlier').onclick();
  assert.deepEqual(design().surfaces.body.regions.map((r) => r.id), ['stripe', 'badge']);

  // Removing takes the fit's opinion of it too, or every later build reports a
  // stale id nobody can act on.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'stripe' } } });
  await nodes.get('#removeregion').onclick();
  regions = design().surfaces.body.regions;
  assert.deepEqual(regions.map((r) => r.id), ['badge']);
  assert.equal(JSON.parse(dom.querySelector('#fitjson').textContent).regions?.stripe, undefined);
});

test('an added region gets a name nothing else is using', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  const add = async (t) => {
    dom.querySelector('#newtreatment').value = t;
    await dom.querySelector('#addregion').onclick();
  };
  await add('fill');
  await add('fill');
  await add('fill');

  const ids = JSON.parse(dom.querySelector('#designjson').textContent)
    .surfaces.body.regions.map((r) => r.id);
  assert.deepEqual(ids, ['badge', 'fill', 'fill-2', 'fill-3']);
  assert.equal(new Set(ids).size, ids.length, 'ids are how a fit addresses a region');
});

test('the status line says which of the two files is unsaved', async () => {
  // Two files and two buttons now. "unsaved" that does not say which leaves you
  // to work it out from which button is enabled, in the far corner of the
  // header, while dragging.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'text', text: 'HI',
  };

  const { dom } = await runApp({ server });
  const { fields } = inspectorButtons(dom, ['#delete'], [['text', 'string']]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  assert.doesNotMatch(dom.querySelector('#status').textContent, /unsaved/, 'nothing changed yet');

  // A DESIGN change alone still has to be reported, which the fit's own dirty
  // flag knew nothing about.
  fields.get('text').value = 'BYE';
  await fields.get('text').onchange();
  assert.match(dom.querySelector('#status').textContent, /design unsaved/);
  assert.doesNotMatch(dom.querySelector('#status').textContent, /fit and design/);

  // And a fit change on top names both.
  dom.querySelector('#panels').onclick({ target: { dataset: { panel: 'R' } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(dom.querySelector('#status').textContent, /fit and design unsaved/);
});

// --- palette and identity ---------------------------------------------------

test('a palette row shows how many things depend on it before you touch it', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014', accent: '#00F0FF', spare: '#ff0000' };
  server.livery.surfaces.body.background = 'ink';
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  const html = dom.querySelector('#palette').innerHTML;

  assert.match(html, /data-palette="accent"/);
  assert.match(html, /title="badge"/, 'and says which regions, not merely how many');
  assert.match(html, /title="surfaces\.body background"/, 'a background counts as a reference');
  // A colour nothing refers to is dimmed rather than hidden: it is a candidate
  // for removal, not a mistake.
  assert.match(html, /class="named unused"[\s\S]*data-palette="spare"/);
});

test('changing a colour repaints everything that names it', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014', accent: '#00F0FF' };
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  const palette = await panelRows(dom, '#palette', 'palette', [['accent', 'value']]);
  assert.match(dom.querySelector('#texture').innerHTML, /#00F0FF/i);

  const value = palette.rowFor('accent', 'value');
  value.value = '#FF00FF';
  await value.onchange();

  assert.match(dom.querySelector('#texture').innerHTML, /#FF00FF/i, 'the render follows the palette');
  assert.equal(JSON.parse(dom.querySelector('#designjson').textContent).palette.accent, '#FF00FF');
  assert.match(dom.querySelector('#status').textContent, /design unsaved/,
    'a colour is design, not a per-car adjustment');
  assert.deepEqual(JSON.parse(dom.querySelector('#fitjson').textContent).regions ?? {}, {});
});

test('renaming a colour takes its references with it', async () => {
  // The references are known, so leaving them pointing at a name that is gone
  // would be choosing to break something the code can see — and it would render
  // as a literal colour called `accent`, silently.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014', accent: '#00F0FF' };
  server.livery.surfaces.body.background = 'accent';
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  const palette = await panelRows(dom, '#palette', 'palette', [['accent', 'name']]);
  const name = palette.rowFor('accent', 'name');
  name.value = 'gulf-blue';
  await name.onchange();

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.deepEqual(Object.keys(design.palette), ['ink', 'gulf-blue'], 'and keeps its place in the file');
  assert.equal(design.surfaces.body.regions[0].color, 'gulf-blue');
  assert.equal(design.surfaces.body.background, 'gulf-blue');
  assert.match(dom.querySelector('#texture').innerHTML, /#00F0FF/i, 'the picture does not change');
  assert.doesNotMatch(dom.querySelector('#dangling').innerHTML, /gulf-blue/,
    'nothing is left dangling');
});

test('a name the design uses and does not define is reported, since nothing else will', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.identity = { driver: 'A. Driver' };
  server.livery.surfaces.body.regions[0] = {
    id: 'name', panel: 'L', at: [0.1, 0.1, 0.4, 0.3],
    treatment: 'text', text: '{driver} #{number}', color: 'ghost',
  };

  const { dom } = await runApp({ server });
  const dangling = dom.querySelector('#dangling').innerHTML;

  // The token renders as nothing at all, mid-sentence.
  assert.match(dangling, /Nothing gives <code>number<\/code> a value/);
  assert.match(dangling, /name renders with a hole/);
  assert.match(dom.querySelector('#texture').innerHTML, />A\. Driver #</,
    'which is exactly what the render does, silently');

  // The colour goes to the renderer as a literal, which is right for `#hex` and
  // wrong in a way nothing reports for a palette entry that went away.
  assert.match(dangling, /<code>ghost<\/code> is not in the palette/);

  // Giving it a value clears the warning.
  const identity = await panelRows(dom, '#identity', 'token', [['driver', 'value']]);
  const driver = identity.rowFor('driver', 'value');
  driver.value = 'M. Nasledov';
  await driver.onchange();
  assert.match(dom.querySelector('#texture').innerHTML, /M\. Nasledov/);
});

test('renaming a token rewrites the text that interpolates it', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.identity = { driver: 'A. Driver' };
  server.livery.surfaces.body.regions[0] = {
    id: 'name', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'text', text: '{driver} / {driver}',
  };

  const { dom } = await runApp({ server });
  const identity = await panelRows(dom, '#identity', 'token', [['driver', 'name']]);
  const name = identity.rowFor('driver', 'name');
  name.value = 'pilot';
  await name.onchange();

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.deepEqual(Object.keys(design.identity), ['pilot']);
  assert.equal(design.surfaces.body.regions[0].text, '{pilot} / {pilot}', 'every mention, not the first');
  assert.match(dom.querySelector('#texture').innerHTML, />A\. Driver \/ A\. Driver</,
    'and the render is unchanged, which is the point of a rename');
  assert.equal(dom.querySelector('#dangling').innerHTML, '');
});

test('adding a colour keeps what you typed until you press Add', async () => {
  // The add row is static furniture. Rebuilding it inside the redrawn panel
  // would clear the field under the cursor on every render.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom } = await runApp({ server });
  dom.querySelector('#newcolourname').value = 'gulf-orange';
  dom.querySelector('#newcolourvalue').value = '#F5A11B';

  // A render in between, as any edit would cause.
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  assert.equal(dom.querySelector('#newcolourname').value, 'gulf-orange', 'still there');

  await dom.querySelector('#addcolour').onclick();
  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.equal(design.palette['gulf-orange'], '#F5A11B');
  assert.equal(dom.querySelector('#newcolourname').value, '', 'and the row is cleared for the next one');
});

test('a one-off colour on a region can be named into the palette', async () => {
  // The loop closing: pick a colour on a region, name it, and the rest of the
  // design can use it — which is how a palette gets built in practice, rather
  // than written out in advance.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014' };
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill', color: '#F5A11B',
  };

  const { dom } = await runApp({ server });
  const inspector = dom.querySelector('#inspector');
  const button = { dataset: { nameColour: 'color' }, onclick: null };
  inspector.querySelector = () => null;
  inspector.querySelectorAll = (q) => (q === '[data-name-colour]' ? [button] : []);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });

  assert.match(inspector.innerHTML, /data-name-colour="color"/, 'a literal colour offers the button');

  globalThis.prompt = () => 'gulf-orange';
  try {
    await button.onclick();
  } finally {
    delete globalThis.prompt;
  }

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.equal(design.palette['gulf-orange'], '#F5A11B', 'the colour joins the palette');
  assert.equal(design.surfaces.body.regions[0].color, 'gulf-orange', 'and the region points at the name');
  assert.match(dom.querySelector('#texture').innerHTML, /#F5A11B/i, 'the picture does not change');
  assert.match(dom.querySelector('#palette').innerHTML, /data-palette="gulf-orange"/);
});

test('a colour that is already a palette name is not offered for naming', async () => {
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014', accent: '#00F0FF' };
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  assert.doesNotMatch(dom.querySelector('#inspector').innerHTML, /data-name-colour/,
    'it already has a name');
});

test('a palette value never reaches the page as CSS', async () => {
  // A livery is a file people SHARE, so its values are not the editor's to
  // trust. `esc` escapes HTML, and a style attribute is not HTML — it is
  // semicolon-separated declarations, so `red;position:fixed;inset:0` would have
  // gone through `esc` untouched and come out the other side as a page-sized
  // invisible sheet over the editor that swallows every click. This project has
  // already had that bug once, from a duplicate id, and wrote a test about it.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  const hostile = 'red;position:fixed;inset:0;z-index:9999';
  server.livery.palette = { ink: '#101014', trap: hostile };

  const { dom } = await runApp({ server });
  const el = dom.querySelector('#palette');
  assert.match(el.innerHTML, /data-swatch="trap"/, 'the swatch is drawn');
  assert.doesNotMatch(el.innerHTML, /style=/, 'and the panel emits no style attribute at all');
  // The value is still in the markup — inside an input's `value`, where it
  // belongs and where `esc` is the right and sufficient tool. That is the field
  // you edit to fix it.
  assert.match(el.innerHTML, /value="red;position:fixed/);

  // And the colour is applied through the CSSOM, whose setter parses one
  // `<color>` and drops anything else — so the hostile value paints nothing
  // rather than laying a sheet over the page.
  const swatches = ['ink', 'trap'].map((n) => ({ dataset: { swatch: n }, style: {} }));
  el.querySelectorAll = (q) => (q === '[data-swatch]' ? swatches : []);
  dom.querySelector('#surface').value = 'surfaces.body';
  await dom.querySelector('#surface').onchange();
  assert.equal(swatches[0].style.backgroundColor, '#101014', 'a real colour is set');
  assert.equal(swatches[1].style.backgroundColor, hostile,
    'and the hostile one is handed to the parser, not to the document');
});

test('a name the palette does not have is not offered for naming either', async () => {
  // The button writes `palette[chosen] = value`, so it is only ever right when
  // the value is a COLOUR. Offered on `ghost` — a palette entry that went away,
  // or a typo — it would write `palette.spooky = 'ghost'` and point the region
  // at `spooky`. The region still reaches librsvg as `fill="ghost"` and still
  // paints nothing anybody chose; the only thing that changes is that the
  // dangling panel goes quiet, because `spooky` is a palette entry now. That
  // trades a true warning for a false silence.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.palette = { ink: '#101014' };
  const region = { id: 'badge', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'fill' };

  const offered = async (color) => {
    server.livery.surfaces.body.regions[0] = { ...region, color };
    const { dom } = await runApp({ server });
    inspectorButtons(dom, ['#delete']);
    dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
    return {
      button: /data-name-colour/.test(dom.querySelector('#inspector').innerHTML),
      // The panel's verdict on THIS value, not on any dangling name — the two
      // halves being one judgement is the property under test, so asking about
      // the wrong value would make the agreement free.
      warned: dom.querySelector('#dangling').innerHTML.includes(`<code>${color}</code>`),
    };
  };

  const ghost = await offered('ghost');
  assert.equal(ghost.button, false, 'a bare word is a broken reference, not a colour to name');
  assert.equal(ghost.warned, true, 'and the panel says so, which is the thing worth keeping');

  assert.equal((await offered('#F5A11B')).button, true, 'a literal colour still offers it');
  assert.equal((await offered('rgb(1,2,3)')).button, true);

  // A named CSS colour IS a colour. This was the one case the editor used to get
  // wrong — in the safe direction, but wrong — because the honest alternative
  // was maintaining 148 colour names against a spec by hand. `colord` knows
  // them, so the excuse is gone and the answer is simply right.
  assert.equal((await offered('red')).button, true, 'a named colour is a colour');
  assert.equal((await offered('rebeccapurple')).button, true);
  assert.equal((await offered('rebecapurple')).button, false,
    'and a typo of one is a dangling name, which is the distinction that matters');
  assert.equal((await offered('red')).warned, false, 'the panel agrees, because it is the same function');
});

test('a token that could never be substituted is refused where it is typed', async () => {
  // `renderTexture` interpolates `{name}` for `\w+` and nothing else, so a token
  // called `driver-name` is unreachable: the braces survive into the SVG and the
  // car is painted with the literal text `{driver-name}`. Nothing reports it —
  // the renderer sees ordinary text, and the dangling panel would call the token
  // defined and used, which is wrong twice.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.identity = { driver: 'A. Driver' };
  server.livery.surfaces.body.regions[0] = {
    id: 'name', panel: 'L', at: [0.1, 0.1, 0.4, 0.3], treatment: 'text', text: '{driver}',
  };

  const { dom } = await runApp({ server });
  const design = () => JSON.parse(dom.querySelector('#designjson').textContent);

  dom.querySelector('#newtokenname').value = 'driver-name';
  dom.querySelector('#newtokenvalue').value = 'A. Driver';
  await dom.querySelector('#addtoken').onclick();
  assert.deepEqual(Object.keys(design().identity), ['driver'], 'the token was not created');
  assert.match(dom.querySelector('#status').textContent, /could never be used/);
  assert.equal(dom.querySelector('#newtokenname').value, 'driver-name',
    'and what was typed is still there to be corrected');

  // Renaming into one is the worse case, because the rewrite below it would
  // carry a working `{driver}` over to a `{driver-name}` that prints itself.
  const identity = await panelRows(dom, '#identity', 'token', [['driver', 'name']]);
  const row = identity.rowFor('driver', 'name');
  row.value = 'driver-name';
  await row.onchange();
  assert.deepEqual(Object.keys(design().identity), ['driver'], 'the rename did not happen');
  assert.equal(design().surfaces.body.regions[0].text, '{driver}', 'and the text still resolves');
  assert.match(dom.querySelector('#texture').innerHTML, />A\. Driver</);

  // A name that CAN interpolate goes through, so this is a rule and not a wall.
  row.value = 'driver_name';
  await row.onchange();
  assert.deepEqual(Object.keys(design().identity), ['driver_name']);
  assert.equal(design().surfaces.body.regions[0].text, '{driver_name}');
});

test('a livery the editor cannot save does not offer to add to it', async () => {
  // The panels go dark for a design carrying code, because showing edits that
  // could never be written back is the failure this whole step is organised
  // against. The Add rows sit OUTSIDE those panels — deliberately, so they keep
  // what you are typing — which is exactly how they stayed live after the panels
  // above them had given up.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.identity = { driver: 'A. Driver' };
  server.livery.render = { font: () => 'DejaVu Sans' };

  const { dom } = await runApp({ server });
  for (const id of ['#newcolourname', '#newcolourvalue', '#addcolour',
    '#newtokenname', '#newtokenvalue', '#addtoken']) {
    assert.equal(dom.querySelector(id).disabled, true, `${id} should be disabled`);
  }
  assert.match(dom.querySelector('#palette').innerHTML, /contains code/);
  assert.match(dom.querySelector('#identity').innerHTML, /contains code/,
    'the disabled row needs a reason standing next to it');

  // The attribute is what a person sees; the handler is what actually holds.
  dom.querySelector('#newcolourname').value = 'gulf-orange';
  dom.querySelector('#newcolourvalue').value = '#F5A11B';
  await dom.querySelector('#addcolour').onclick();
  dom.querySelector('#newtokenname').value = 'number';
  await dom.querySelector('#addtoken').onclick();

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.equal(design.palette['gulf-orange'], undefined, 'nothing was added to the palette');
  assert.equal(design.identity.number, undefined, 'nor to the identity');
  assert.match(dom.querySelector('#status').textContent, /contains code/);
  assert.doesNotMatch(dom.querySelector('#status').textContent, /unsaved/,
    'and nothing was marked as needing saving');
});

test('the inspector says how big a region is on the actual car', async () => {
  // Every other number in the inspector is a fraction of an image: `at` is
  // panel-relative, the overlay is texture-relative, the anisotropy is a ratio.
  // None of them answer whether the sponsor you just placed comes out the size
  // of a postcard or the size of a door, which is the question.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  // The fixture's L panel is a quarter of the sheet; give it a measurement, so
  // the arithmetic below has exactly one right answer.
  server.profile.panels.body.L.metresPerUv = [8, 2];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', panel: 'L', at: [0, 0, 0.5, 0.5], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  const shown = dom.querySelector('#inspector').innerHTML;

  // The panel is [0, 0, 0.4, 0.4] of the sheet and the region is half of it, so
  // 0.2 of the sheet across: 0.2 x 8 = 1.6 m, and 0.2 x 2 = 400 mm.
  //
  // NOT 0.5 x 8 = 4 m, which is what multiplying `at` by the measurement gives.
  // `metresPerUv` is per unit of the WHOLE sheet and `at` is panel-relative, so
  // that version reports a region on a small panel as though it spanned the car
  // — believably, and wrong by however large the panel is. I wrote it first.
  assert.match(shown, /1\.60 m × 400 mm/,
    `expected 1.60 m × 400 mm from a panel-relative half of a 0.4 panel, got: ${shown.slice(0, 400)}`);

  // Metres and millimetres, because 0.4 m is a number you have to convert in
  // your head to picture and 400 mm is not.
  assert.doesNotMatch(shown, /0\.40 m/);
});

test('a profile that never measured its panels says so, rather than nothing', async () => {
  // Both bundled cars are in this state until somebody regenerates them, so it
  // is the case most people will see first. A blank row would read as a bug in
  // the editor; a zero would read as a measurement.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  const shown = dom.querySelector('#inspector').innerHTML;

  assert.match(shown, /no measurement for/);
  assert.match(shown, /--from-kn5/, 'and says what to do about it');
  assert.match(shown, /<code>L<\/code>/, 'naming the panel whose measurement is missing');
  assert.doesNotMatch(shown, /\bNaN\b|undefined/);
});

test('a region on no panel is not told to regenerate a profile that is fine', async () => {
  // Both reasons for having no size arrive as `metres: null`, and they want
  // different things done about them. An absolute rectangle is not ON a panel,
  // and `metresPerUv` belongs to a panel — panels on one car differ in scale by
  // more than ten times, so there is nothing to fall back to. Telling somebody
  // to rebuild their profile would send them off to fix something that is not
  // broken and leave them no wiser when the number still did not appear.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body.L.metresPerUv = [8, 2];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', at: [0.1, 0.1, 0.3, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  const shown = dom.querySelector('#inspector').innerHTML;

  assert.match(shown, /placed by coordinate/);
  assert.doesNotMatch(shown, /--from-kn5/,
    'the profile is measured; regenerating it would change nothing');
});
test('a region can be freed from this car\'s panel names, and pinned back', async () => {
  // The difference the whole of `surfaces:` turns on, and until now it was
  // invisible in the editor: `panel: 'L'` and `tags: ['left']` draw the same
  // rectangle here and mean completely different things on the next car.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body.L.tags = ['left', 'mid', 'visible'];
  server.profile.panels.body.R.tags = ['right', 'mid', 'visible'];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  delete server.livery.car;

  const { dom } = await runApp({ server });
  const design = () => JSON.parse(dom.querySelector('#designjson').textContent);
  const region = () => design().surfaces.body.regions[0];

  const buttons = (names) => {
    const inspector = dom.querySelector('#inspector');
    const made = new Map(names.map((n) => [n, { dataset: n, onclick: null }]));
    inspector.querySelectorAll = (q) => [...made.values()]
      .filter((b) => (q === '[data-place]' ? b.dataset.place : q === '[data-tag]' ? b.dataset.tag : false));
    inspector.querySelector = () => null;
    return made;
  };

  // Freed: the panel name goes, the tags arrive, and they are the SIDE and
  // SECTION rather than everything the panel happens to carry — `visible` is
  // measured, true, and not a way of finding this panel on another car.
  let b = buttons([{ place: 'tags' }]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await [...b.values()][0].onclick();
  assert.equal(region().panel, undefined, 'the car-specific name is gone');
  assert.deepEqual(region().tags, ['left', 'mid']);
  assert.match(dom.querySelector('#status').textContent, /left, mid/);

  // A tag can be added — including one the default declined to assume.
  b = buttons([{ tag: 'visible' }]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await [...b.values()][0].onclick();
  assert.deepEqual(region().tags, ['left', 'mid', 'visible']);

  // Pinned back: the tags go and the panel returns. Both fields must never be
  // set at once — `expandRegions` throws on a region carrying both, so an
  // editor that wrote one would render happily and fail the build.
  b = buttons([{ place: 'panel' }]);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await [...b.values()][0].onclick();
  assert.equal(region().panel, 'L');
  assert.equal(region().tags, undefined, 'panel and tags may never both be set');
});

test('a tag selection may not be emptied, because empty matches everything', async () => {
  // `tags: []` matches EVERY panel — `every` on an empty list is vacuously true
  // — which is why expandRegions throws on it. A button that could write it
  // would be a click that makes the design unbuildable.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body.L.tags = ['left'];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', tags: ['left'], at: [0.1, 0.1, 0.3, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  const inspector = dom.querySelector('#inspector');
  const only = { dataset: { tag: 'left' }, onclick: null };
  inspector.querySelector = () => null;
  inspector.querySelectorAll = (q) => (q === '[data-tag]' ? [only] : []);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  await only.onclick();

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.deepEqual(design.surfaces.body.regions[0].tags, ['left'], 'the last tag is kept');
  assert.match(dom.querySelector('#status').textContent, /at least one tag/);
});

test('a design that says which car it is for gets exact placements', async () => {
  // The default follows what the design has already declared about itself. A
  // `car` field means it is FOR that car and the exact panel name is the better
  // answer; without one it means to travel, and pinning each new region to this
  // car's names would be the editor undoing that a region at a time.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body.L.tags = ['left', 'mid'];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const forThisCar = async (car) => {
    server.livery.car = car;
    if (!car) delete server.livery.car;
    const { dom } = await runApp({ server });
    dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
    dom.querySelector('#newtreatment').value = 'fill';
    await dom.querySelector('#addregion').onclick();
    const d = JSON.parse(dom.querySelector('#designjson').textContent);
    return d.surfaces.body.regions.at(-1);
  };

  assert.deepEqual((await forThisCar('fixture')).panel, 'L', 'a design for one car names the panel');
  assert.equal((await forThisCar('fixture')).tags, undefined);

  const portable = await forThisCar(null);
  assert.deepEqual(portable.tags, ['left', 'mid'], 'a design with no car travels by default');
  assert.equal(portable.panel, undefined);
});

test('the other-car check reports misses by name, and does not call absolutes fine', async () => {
  // The panel exists to answer a question you cannot ask by looking: does this
  // design travel. So the shape of the answer matters — a count says there is a
  // problem, a name says which region to go and change.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, calls } = await runApp({ server });
  const report = {
    car: 'other', name: 'Some Other Car',
    surfaces: [{ from: 'surfaces.wing', status: 'absent' }],
    regions: [
      { id: 'flank', from: 'surfaces.body', kind: 'tags', status: 'matched', panels: ['a', 'b'] },
      { id: 'nose-badge', from: 'surfaces.body', kind: 'panel', status: 'missing',
        panels: [], why: 'this car has no panel called "centre_nose"' },
      { id: 'stripe', from: 'surfaces.body', kind: 'absolute', status: 'absolute', panels: [] },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) =>
    (path === '/api/portability'
      ? { ok: true, status: 200, json: async () => report }
      : realFetch(path, init));
  try {
    dom.querySelector('#othercar').value = 'other';
    await dom.querySelector('#othercar').onchange();
  } finally {
    globalThis.fetch = realFetch;
  }

  const shown = dom.querySelector('#portability').innerHTML;
  // Whitespace-tolerant: the markup wraps, and where it wraps is not the point.
  assert.match(shown, /1 of 3 regions land on\s+Some Other Car/);
  assert.match(shown, /nose-badge/, 'a miss is named, because the next action is to go and fix that one');
  assert.match(shown, /no panel called/);
  assert.match(shown, /surfaces\.wing/, 'and a surface the car lacks is worth seeing too');

  // The one that would be easiest to get wrong: an absolute placement always
  // resolves, which is exactly why it is the most likely to be quietly wrong on
  // another car. Reporting it as a pass would be the reassuring silence this
  // project refuses.
  assert.doesNotMatch(shown, /<div class="note">! <code>stripe/, 'an absolute is not a failure');
  assert.match(shown, /1 placed by coordinate/, 'but it is not counted as fine either');

  // And it asked about the WORKING design rather than the file on disk.
  const asked = calls.find((c) => c.path === '/api/portability');
  assert.ok(asked === undefined || asked.body.design, 'the design travels with the question');
});

test('the other-car check survives an answer that is not a report', async () => {
  // A 404 from /api/portability is JSON too, and it carries an `error` rather
  // than a report. Reading it and carrying on reached `regions.filter` on
  // undefined and threw — so the panel went blank on the one occasion it had
  // something worth saying.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  const { dom } = await runApp({ server });

  const realFetch = globalThis.fetch;
  const answer = async (status, body) => {
    globalThis.fetch = async (path, init) =>
      (path === '/api/portability'
        ? { ok: status === 200, status, json: async () => body }
        : realFetch(path, init));
    try {
      dom.querySelector('#othercar').value = 'other';
      await dom.querySelector('#othercar').onchange();
    } finally {
      globalThis.fetch = realFetch;
    }
    return dom.querySelector('#portability').innerHTML;
  };

  assert.match(await answer(404, { error: 'no profile called "ghost"' }), /no profile called/);
  assert.match(await answer(500, {}), /500/, 'even an answer with nothing in it says something');
  assert.match(await answer(200, { fatal: 'two surfaces claim one role' }), /two surfaces claim one role/);
  // The shape that used to throw: a 200 with no regions array.
  assert.match(await answer(200, { car: 'x', name: 'X' }), /no regions/);
});

test('a region on no panel is not offered a switch that cannot do anything', async () => {
  // The switch is panel-or-tags, and a region placed by coordinate is on
  // neither. Showing it implied the region was pinned, and "this panel" was a
  // button with nothing to pin to.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions[0] = {
    id: 'badge', at: [0.1, 0.1, 0.3, 0.3], treatment: 'fill', color: 'accent',
  };

  const { dom } = await runApp({ server });
  inspectorButtons(dom, ['#delete']);
  dom.querySelector('#regions').onclick({ target: { dataset: { id: 'badge' } } });
  const shown = dom.querySelector('#inspector').innerHTML;

  assert.doesNotMatch(shown, /data-place=/, 'no button that would do nothing');
  assert.match(shown, /on no panel/, 'but it says what it is');
  assert.match(shown, /every car/, 'and what that costs when the design travels');
});

test('adding to a surface with no panels says so, rather than naming undefined', async () => {
  // `panel` is undefined when nothing is mapped, and the region goes in as a
  // bare rectangle. The status line used to read "added fill on undefined —
  // pinned to this car", which is the editor reading its own variable aloud.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.panels.body = {};
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.body.regions = [];

  const { dom } = await runApp({ server });
  dom.querySelector('#newtreatment').value = 'fill';
  await dom.querySelector('#addregion').onclick();

  const said = dom.querySelector('#status').textContent;
  assert.doesNotMatch(said, /undefined/);
  assert.match(said, /no panels mapped/);

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  const added = design.surfaces.body.regions.at(-1);
  assert.equal(added.panel, undefined, 'and it really is a bare rectangle');
  assert.equal(added.tags, undefined);
});

test('clicking an unpainted part of the car offers to paint it, and names it', async () => {
  // A car ships four plausible number-plate textures at 1024 square, and telling
  // them apart by name is guesswork. Pointing at the one on the door is not —
  // the whole-car groups know which texture each part uses, and the state knows
  // which role each texture is. This is the join between them.
  const server = copyFixture();
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, mod } = await runApp({ server });
  const claim = mod.claimCarPointer;

  // Whole-car view: the gesture is orbiting, so the claim must DECLINE even
  // when it has something to say. Taking the drag to show a hint would cost the
  // camera movement that is the main thing this view is for.
  dom.querySelector('#tab-all').onclick();
  const hit = (group) => claim({ u: 0.5, v: 0.5, group }, {});

  assert.equal(hit({ role: null, file: 'b.dds' }), false, 'it never takes the gesture');

  // A part the design does not paint, and the car does have a role for.
  hit({ role: null, file: 'b.dds' });
  assert.equal(dom.querySelector('#adopt').hidden, false);
  assert.match(dom.querySelector('#adoptwhat').textContent, /b\.dds/, 'named, because that is the answer');
  assert.equal(dom.querySelector('#adoptsurface').hidden, false);

  // A part already painted is where you are working, not an offer.
  hit({ role: 'body', file: 'b.dds' });
  assert.equal(dom.querySelector('#adopt').hidden, true);

  // And bare space behind the car.
  hit({ role: null, file: 'b.dds' });
  claim(null, {});
  assert.equal(dom.querySelector('#adopt').hidden, true, 'nothing under the pointer, nothing to offer');
});

test('a surface the profile says not to paint is refused, with the reason', async () => {
  // A normal map encodes surface direction and a shader map encodes gloss.
  // Painting either gives a car that loads, lights wrongly, and reports nothing
  // — so offering them would be the editor inviting a mistake the profile
  // already knows about.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.doNotPaint = [{ file: 'b_nm.dds', reason: 'normal map — encodes surface direction' }];
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, mod } = await runApp({ server });
  dom.querySelector('#tab-all').onclick();
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'b_nm.dds' } }, {});

  assert.equal(dom.querySelector('#adopt').hidden, false, 'it still says what the part is');
  assert.match(dom.querySelector('#adoptwhat').textContent, /normal map/, 'and why not');
  assert.equal(dom.querySelector('#adoptsurface').hidden, true, 'but offers no button');
});

test('adopting a surface writes paint, not surfaces, and goes there', async () => {
  // `paint.<role>` names a texture role directly; `surfaces.<term>` goes through
  // the car's bindings. These are exactly the surfaces with no binding and
  // usually no panels — a banner is too small a share of the car to survive the
  // panel threshold — so `paint` is not a shortcut, it is the only thing that
  // addresses them at all.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  // A second texture the design does not touch — a banner, exactly the case
  // this exists for: too small a share of the car to have panels of its own.
  server.profile.textures.banner = { file: 'banner.dds', width: 1024, height: 512 };
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, mod } = await runApp({ server });
  dom.querySelector('#tab-all').onclick();
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'banner.dds' } }, {});
  await dom.querySelector('#adoptsurface').onclick();

  const design = JSON.parse(dom.querySelector('#designjson').textContent);
  assert.ok(design.paint?.banner, 'written as paint, keyed by the texture role');
  assert.deepEqual(design.paint.banner.regions, [], 'and empty, so the black says you have taken it over');
  assert.equal(design.paint.banner.background, undefined, 'no invented background');
  assert.equal(design.surfaces?.banner, undefined, 'not through a binding the car does not have');

  assert.match(dom.querySelector('#status').textContent, /renders black/);
  assert.equal(dom.querySelector('#adopt').hidden, true, 'the offer is spent');

  // And a role the design already paints is refused rather than written. Two
  // claims on one texture is a design `resolveTargets` throws on, because one
  // write would silently overwrite the other — so this must never be reachable
  // by a click, whichever route the design took to get there first.
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'b.dds' } }, {});
  await dom.querySelector('#adoptsurface').onclick();
  assert.match(dom.querySelector('#status').textContent, /already painted/);
  assert.equal(JSON.parse(dom.querySelector('#designjson').textContent).paint?.body, undefined);
});


test('a surface that cannot be adopted leaves the design exactly as it was', async () => {
  // Reported: adopting a surface emptied the design. I could not reproduce it,
  // which is the point of this test — the guard above only sees what the
  // editor's surface list holds, and that list carries the PRIMARY target of
  // each term, so a role claimed by some other route is invisible to it.
  //
  // So the change is proposed before it is applied: made on a copy, checked by
  // the server, and only then does it become the design you are holding. That
  // makes the whole class safe rather than the one case I could think of.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.textures.banner = { file: 'banner.dds', width: 1024, height: 512 };
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, mod } = await runApp({ server });
  const before = dom.querySelector('#designjson').textContent;

  // The server refuses whatever comes next.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) =>
    (path === '/api/state' && init?.method === 'POST'
      ? { ok: false, status: 500, json: async () => ({ error: 'paints texture role "banner" twice' }) }
      : realFetch(path, init));

  dom.querySelector('#tab-all').onclick();
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'banner.dds' } }, {});
  try {
    await dom.querySelector('#adoptsurface').onclick();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(dom.querySelector('#designjson').textContent, before,
    'the design is untouched, down to the byte');
  assert.match(dom.querySelector('#status').textContent, /could not paint banner/);
  assert.match(dom.querySelector('#status').textContent, /twice/, 'and says why, from the server');
  assert.doesNotMatch(dom.querySelector('#status').textContent, /unsaved/,
    'and nothing was marked dirty for a change that did not happen');
});


test('adopting a surface does not shift what every other one points at', async () => {
  // Reported: after adopting, `surfaces.body` showed the adopted surface and
  // `surfaces.tyres` showed the body. Nothing was lost and the design was
  // intact — the picker was pointing at the wrong ones, which is worse, because
  // everything you do next is real and lands somewhere else.
  //
  // The options carried their INDEX and were built once at boot. Adopting adds
  // an entry, and `resolveTargets` walks `paint` before `surfaces`, so the new
  // one arrives at the FRONT and shifts every index below it while the select
  // kept the old numbers.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.textures.tyres = { file: 'tyres.dds', width: 512, height: 512 };
  server.profile.textures.banner = { file: 'banner.dds', width: 1024, height: 512 };
  server.profile.bind = {
    body: { roles: ['body'], source: 'human' },
    tyres: { roles: ['tyres'], source: 'human' },
  };
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];
  server.livery.surfaces.tyres = { regions: [{ id: 'tyre1', treatment: 'fill', color: 'ink' }] };

  const { dom, mod } = await runApp({ server });
  const options = () => dom.querySelector('#surface').innerHTML;
  assert.match(options(), /value="surfaces\.body"/, 'options name the surface, not its position');

  dom.querySelector('#tab-all').onclick();
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'banner.dds' } }, {});
  await dom.querySelector('#adoptsurface').onclick();

  // The new one exists, and the old ones still name themselves.
  assert.match(options(), /value="paint\.banner"/, 'the adopted surface is offered');
  assert.match(options(), /value="surfaces\.body"/);
  assert.match(options(), /value="surfaces\.tyres"/);

  // And picking one by name gets THAT one — asserted on the regions it shows,
  // not on the value just written into the select, which would only prove the
  // test can set a property.
  const pick = async (from) => {
    dom.querySelector('#surface').value = from;
    await dom.querySelector('#surface').onchange();
    return dom.querySelector('#regions').innerHTML;
  };

  assert.match(await pick('surfaces.tyres'), /tyre1/, 'the tyres surface shows the tyres region');
  const body = await pick('surfaces.body');
  assert.match(body, /badge/, 'and body shows the body region');
  assert.doesNotMatch(body, /tyre1/, 'not whatever took position zero');
  assert.match(await pick('paint.banner'), /class="hint"|^\s*$|<li/, 'the adopted one is reachable too');
});

test('the whole-car view is re-roled from the design, not from the cached geometry', async () => {
  // Reported: regions added to a newly adopted surface never appeared in Whole
  // car. The geometry is cached — a fact about the car, megabytes to fetch — and
  // the ROLES came down with it, so they were only as fresh as that fetch.
  // Adopting left the new surface's meshes in a group still marked roleless,
  // and no amount of rendering the right texture would have put it anywhere.
  // Through `runApp`, because app.js reads `document` as it loads — but the
  // function itself needs no DOM, no GL context and no model download, which is
  // the point of pulling it out of `loadWholeCar`.
  const { mod } = await runApp({ server: copyFixture() });
  const { reRole } = mod;
  assert.ok(reRole, 'reRole is exported so this can be tested at all');

  // Geometry as fetched when the design painted only the body.
  const groups = [
    { role: 'body', file: 'b.dds', start: 0, count: 6 },
    { role: null, file: 'banner.dds', start: 6, count: 6 },
    { role: null, file: 'glass.dds', start: 12, count: 6 },
  ];

  // The design now also paints the banner, and its file is how the two meet —
  // role names are the profile's and mean nothing to geometry.
  const after = reRole(groups, [
    { role: 'body', file: 'b.dds' },
    { role: 'banner', file: 'BANNER.dds' },
  ]);
  assert.deepEqual(after.map((g) => g.role), ['body', 'banner', null],
    'the adopted surface is painted, and the glass is still not');
  assert.deepEqual(after.map((g) => g.start), [0, 6, 12], 'and nothing else about the group moves');

  // Losing a surface goes the other way, which the cached roles could never do.
  assert.deepEqual(reRole(groups, [{ role: 'body', file: 'b.dds' }]).map((g) => g.role),
    ['body', null, null]);
  assert.deepEqual(reRole(groups, []).map((g) => g.role), [null, null, null]);
  assert.deepEqual(reRole(undefined, undefined), []);
});


test('a texture named like a special key is a texture, not a prototype', async () => {
  // Every key in the roles index is a FILENAME out of a car somebody else made.
  // `__proto__.dds` is a legal filename and a special key on an ordinary object:
  // writing one mutates the prototype instead of the map, and `constructor`
  // answers with a function nobody stored. Both fail silently, and the second
  // would refuse to offer a surface for a reason that does not exist.
  const server = copyFixture();
  server.profile = structuredClone(server.profile);
  server.profile.textures.evil = { file: '__proto__.dds', width: 64, height: 64 };
  server.profile.textures.ctor = { file: 'constructor.dds', width: 64, height: 64 };
  server.livery = structuredClone(server.livery);
  server.livery.packs = ['core'];

  const { dom, mod } = await runApp({ server });
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype on the way here');

  dom.querySelector('#tab-all').onclick();

  // A file whose name is a special key still resolves to its own role.
  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: '__proto__.dds' } }, {});
  assert.equal(dom.querySelector('#adopt').hidden, false);
  assert.match(dom.querySelector('#adoptwhat').textContent, /__proto__\.dds/);

  mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file: 'constructor.dds' } }, {});
  assert.equal(dom.querySelector('#adopt').hidden, false, 'and is offered, not silently refused');
  assert.equal(dom.querySelector('#adoptsurface').hidden, false);

  // And a name the car does NOT have must not be answered by the prototype.
  //
  // `constructor` and `__proto__`, because lookups are lowercased and those two
  // survive it — `toString` becomes `tostring` and misses the prototype by
  // accident, which is not a defence. The roles map crosses the wire as JSON, so
  // whatever prototype the server gave it is gone by the time the browser reads
  // it: the null-prototype on the server protects the server, and this protects
  // the browser.
  for (const file of ['constructor', '__proto__']) {
    mod.claimCarPointer({ u: 0.5, v: 0.5, group: { role: null, file } }, {});
    assert.equal(dom.querySelector('#adopt').hidden, true,
      `${file} is a key off the prototype, not a texture this car has`);
  }
});

test('the fitment panel leads with what it could not check', async () => {
  // The panel's whole value is that bad news reaches you. An empty findings
  // list from a run that skipped the geometry checks and an empty list from a
  // run that did all of them are the same sentence and opposite facts — the
  // first is how a team name ended up painted onto no part of the car.
  const { dom } = await runApp({ server: copyFixture() });
  const answer = {
    car: 'fixture', checked: ['overlap', 'outside-safe', 'unreadable', 'unmirrored'],
    notChecked: ['unseen', 'off-mesh'], notPlaced: [], findings: [],
    modelError: null,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) =>
    (path === '/api/fitment'
      ? { ok: true, status: 200, json: async () => answer }
      : realFetch(path, init));
  try {
    await dom.querySelector('#recheck').onclick();
  } finally {
    globalThis.fetch = realFetch;
  }

  const shown = dom.querySelector('#fitment').innerHTML;
  assert.match(shown, /not checked: unseen, off-mesh/, 'the skipped checks are named');
  assert.match(shown, /class="note"/, 'and said as a warning, not as a hint');
  assert.doesNotMatch(shown, /Nothing to report from[\s\S]*unseen/,
    'a partial run is never summarised as covering everything');
});

test('the fitment panel names regions worst-first', async () => {
  const { dom, calls } = await runApp({ server: copyFixture() });
  const answer = {
    car: 'fixture', checked: ['overlap', 'unseen', 'off-mesh'], notChecked: [], notPlaced: [],
    findings: [
      { kind: 'overlap', severity: 'low', ids: ['stripe'], why: 'stripe covers 40% of wash' },
      { kind: 'off-mesh', severity: 'high', ids: ['team-left'],
        why: 'team-left has only 11% of its area on the car' },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) =>
    (path === '/api/fitment'
      ? { ok: true, status: 200, json: async () => answer }
      : realFetch(path, init));
  try {
    await dom.querySelector('#recheck').onclick();
  } finally {
    globalThis.fetch = realFetch;
  }

  const shown = dom.querySelector('#fitment').innerHTML;
  assert.ok(shown.indexOf('team-left') < shown.indexOf('stripe'),
    'the high finding is above the low one, whatever order the server sent');
  assert.match(shown, /<code>team-left<\/code>/, 'named, so there is something to go and change');

  // The WORKING design and fit, not the files on disk — the same rule the
  // other-car panel follows, for the same reason.
  const asked = calls.find((c) => c.path === '/api/fitment');
  assert.ok(asked === undefined || (asked.body.design && asked.body.fit),
    'the edit in front of you is what gets checked');
});

// ---------------------------------------------------------------------------
// Why the whole car looked fuzzy.
//
// Every painted surface was rasterised at a flat 512 square, justified in a
// comment by "thirty-seven surfaces at full size is a hundred megabytes". But
// thirty-seven is how many textures the CAR has; seven is how many this design
// paints. The Honda's body sheet is 2048x2048, so the livery was shown at a
// quarter of its resolution — directly beside the car's own stock artwork,
// uploaded from the kn5 at full size. No filtering fixes that: the detail was
// gone before the GPU saw it.
// ---------------------------------------------------------------------------

test('a painted surface is rasterised at the size of the texture it replaces', async () => {
  const { textureSizes } = await import('../src/ui/view3d.js');

  // The real seven, at their real sizes.
  const honda = [
    { role: 'ext_skin_sponsors', width: 2048, height: 2048 },
    { role: 'rims', width: 1024, height: 1024 },
    { role: 'tyres', width: 2048, height: 512 },
    { role: 'interior', width: 1024, height: 1024 },
    { role: 'belts', width: 512, height: 512 },
    { role: 'steeringWheel', width: 512, height: 512 },
    { role: 'ext_banner_colour', width: 1024, height: 512 },
  ];
  const sizes = textureSizes(honda);
  assert.deepEqual(sizes[0], { w: 2048, h: 2048 }, 'the body sheet at full resolution');
  assert.deepEqual(sizes[2], { w: 2048, h: 512 },
    'and a non-square texture is not squashed into a square');

  // The budget the old flat 512 was defending. Seven real textures cost about
  // 33 MB, so there was never anything to defend against.
  const mb = sizes.reduce((n, s) => n + s.w * s.h * 4, 0) / (1024 * 1024);
  assert.ok(mb < 64, `seven surfaces at full size is ${mb.toFixed(0)} MB, not a hundred`);
});

test('the texture budget is shared out, not spent per surface', async () => {
  const { textureSizes, capped } = await import('../src/ui/view3d.js');

  // A design that really does paint forty surfaces gets halved rather than
  // exhausting the GPU — and halving is what keeps every texture a power of
  // two, which is what generateMipmap requires. Asking for a mip chain on a
  // non-power-of-two texture renders it black.
  const many = Array.from({ length: 40 }, () => ({ width: 2048, height: 2048 }));
  const sizes = textureSizes(many, { budget: 64 * 1024 * 1024 });
  const total = sizes.reduce((n, s) => n + s.w * s.h * 4, 0);
  assert.ok(total <= 64 * 1024 * 1024, `${(total / 1048576).toFixed(0)} MB is over budget`);
  for (const s of sizes) {
    assert.equal(s.w & (s.w - 1), 0, `${s.w} is not a power of two`);
    assert.equal(s.h & (s.h - 1), 0, `${s.h} is not a power of two`);
  }

  // And a card that will not accept 4096 gets something it will. Asking for a
  // texture larger than MAX_TEXTURE_SIZE is an error, not a slow path.
  assert.deepEqual(capped(4096, 4096, 2048), [2048, 2048]);
  assert.deepEqual(capped(2048, 512, 4096), [2048, 512], 'and nothing is shrunk needlessly');
});

test('the geometry the viewer receives carries the normals it lights with', async () => {
  // The car was drawn with `gl_FragColor = vec4(texture, 1.0)` — no lighting at
  // all — and the reason it could not be lit is here rather than in the shader:
  // both geometry builders read the surface normal off every vertex and threw
  // it away. An unlit slab cannot show how a stripe crosses a curve, which is
  // most of what the whole-car view exists to answer.
  const { wholeModelGeometry, modelGeometry, packModel } = await import('../src/ui/server.mjs');
  const { unpackModel } = await import('../src/ui/view3d.js');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const model = parseKn5Buffer(carKn5());
  for (const g of [wholeModelGeometry(model, [{ role: 'body', file: CAR.texture }]),
                   modelGeometry(model, CAR.texture)]) {
    assert.equal(g.normals.length, g.positions.length, 'one normal per position');
    // Unit length, because the shader divides by nothing and a zero normal
    // would come out as flat sky.
    for (let i = 0; i < g.normals.length; i += 3) {
      const n = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
      assert.ok(Math.abs(n - 1) < 1e-3, `normal ${i / 3} has length ${n}`);
    }
  }

  // And they survive the trip, at the right offset. Adding an array to a packed
  // format is exactly where an off-by-one buffer offset hides: everything still
  // parses, and the numbers are someone else's.
  const packed = wholeModelGeometry(model, [{ role: 'body', file: CAR.texture }]);
  const back = unpackModel(new Uint8Array(packModel(packed)).buffer);
  assert.deepEqual([...back.normals], [...packed.normals]);
  assert.deepEqual([...back.indices], [...packed.indices],
    'and the array after them is still where it should be');
});

test('packModel says what is missing instead of dying on undefined', async () => {
  const { packModel } = await import('../src/ui/server.mjs');
  assert.throws(() => packModel({
    positions: Float32Array.from([0, 0, 0]),
    uvs: Float32Array.from([0, 0]),
    indices: Uint32Array.from([0]),
    groups: [], bounds: { lo: [0, 0, 0], hi: [0, 0, 0] },
  }), /needs a typed array for "normals"/,
    'a builder that has not caught up is told so, at the call that did it');
});

test('an op the editor does not know is refused, not silently dropped', async () => {
  const { applyDesignOp, applyFitOp, opSetConstraint } = await import('../src/ui/ops.js');

  // The default case used to `break`, so an unknown op did nothing and said
  // nothing — which looks exactly like an accepted proposal that changed the
  // design. It is also how a `set-constraint` reaching an editor loaded before
  // constraints existed would behave: banner says accepted, design untouched.
  assert.throws(() => applyDesignOp({}, { op: 'set-constrait', id: 'a', key: 'minMm' }),
    /No design op called "set-constrait"/);
  assert.throws(() => applyFitOp({}, { op: 'nudge' }), /No fit op called "nudge"/);
  assert.throws(() => applyDesignOp({}, { op: 'x' }), /reload the editor/,
    'and it suggests the likely cause');

  // A misspelled CONSTRAINT is refused at the point of writing, rather than
  // written and reported later by fitment. A constraint is invisible until
  // something violates it, so a typo reads as a rule in force.
  const design = { surfaces: { body: { regions: [{ id: 'team', treatment: 'text' }] } } };
  assert.throws(() => opSetConstraint(design, { id: 'team', key: 'keepclear', value: true }),
    /No constraint called "keepclear"/);
  assert.throws(() => opSetConstraint(design, { id: 'team', key: 'minMm', value: 'big' }),
    /takes a number/);
  assert.throws(() => opSetConstraint(design, { id: 'team', key: 'minOnCar', value: 90 }),
    /fraction between 0 and 1/);
  assert.equal(design.surfaces.body.regions[0].constraints, undefined,
    'and nothing was written on the way to refusing');

  // The real thing round-trips, and removing the last one takes the object away
  // rather than leaving `constraints: {}` behind in a saved design.
  opSetConstraint(design, { id: 'team', key: 'keepClear', value: true });
  assert.deepEqual(design.surfaces.body.regions[0].constraints, { keepClear: true });
  opSetConstraint(design, { id: 'team', key: 'keepClear', value: null });
  assert.equal(design.surfaces.body.regions[0].constraints, undefined);
});

test('what blends is decided by the material, not by the texture', async () => {
  // My first attempt at this used the profile's `alpha` flag, which means
  // "this DDS carries an alpha channel" — true of a DXT5 body texture that is
  // entirely opaque. 62 of the Honda's 75 textures are flagged, so nearly every
  // panel went into the blended pass with depth write off, and a car whose
  // bodywork does not write depth cannot hide its own interior. It came back as
  // a screenshot of a see-through car.
  const { blends } = await import('../src/engine/kn5.mjs');

  assert.equal(blends('ksPerPixelAlpha'), true, 'the number plates');
  assert.equal(blends('ksWindscreen'), true);
  assert.equal(blends('ksPerPixelReflection'), true, 'side glass and mirrors');

  // The bodywork, which is what went wrong.
  assert.equal(blends('ksPerPixelMultiMap_damage_dirt'), false, 'the doors');
  assert.equal(blends('ksPerPixelNM'), false);
  assert.equal(blends('ksPerPixel'), false);

  // Alpha TEST is a hard cutout: it neither blends nor needs sorting, and
  // treating it as blended would put grilles and bolt heads in the sorted pass
  // for nothing.
  assert.equal(blends('ksPerPixelAT'), false, 'alpha test is not alpha blend');
  assert.equal(blends('ksPerPixelAT_NM'), false);

  assert.equal(blends(undefined), false, 'and an unknown shader is opaque');
  assert.equal(blends('ksSomethingNobodyHasWrittenYet'), false,
    'unknown means opaque: a wrongly opaque surface looks solid, a wrongly ' +
    'blended one can disappear');
});

test('a transparent surface with no artwork is skipped and counted, not drawn grey', async () => {
  // The shot has no stock car textures. Drawing glass or an emissive mask as
  // grey would be a lie — grey is opaque and the whole point of those surfaces
  // is that they are not — so they are left out and the count is reported.
  // Silence would let a missing third of the car read as a design that paints
  // nothing there.
  const { rasterise } = await import('../src/engine/shot.mjs');
  const quad = {
    positions: new Float32Array([0, -1, -1, 0, -1, 1, 0, 1, 1, 0, 1, -1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    normals: new Float32Array([-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const opaque = rasterise(quad, [{ role: 'body', start: 0, count: 6 }],
    new Map(), { width: 60, height: 60 });
  assert.equal(opaque.skipped, 0, 'an opaque group with no artwork is drawn grey');

  const glass = rasterise(quad, [{ role: 'glass', start: 0, count: 6, blend: true }],
    new Map(), { width: 60, height: 60 });
  assert.equal(glass.skipped, 1, 'a blended group with no artwork is not drawn');
  const at = (img) => [0, 1, 2].map((k) => img.data[(30 * img.width + 30) * 4 + k]);
  assert.deepEqual(at(glass), [0x10, 0x10, 0x16], 'and the background shows through');
  assert.notDeepEqual(at(opaque), at(glass));
});

test('the whole-car view never paints grey where a transparent surface belongs', async () => {
  // Asked whether my MCP render was the same thing as the editor's Whole car
  // view. It is not — it is a separate CPU rasteriser in Node that shares the
  // geometry and the artwork and nothing else. So a picture from it proves the
  // design paints the plate, and proves nothing about the browser.
  //
  // The browser had its own version of the bug. In the blended pass a group
  // with no texture fell through to `unpainted`, which is OPAQUE GREY. The
  // number plate's emissive twin has no painted role, so a failed stock fetch
  // put a grey slab in front of the plate — sorted against it and co-planar
  // with it, so roughly half the time.
  //
  // I had already applied this exact reasoning to the Node renderer and not to
  // the viewer, which is what the question exposed.
  const src = await readFile(new URL('../src/ui/view3d.js', import.meta.url), 'utf8');

  // Read out of the source because the alternative is a GPU. Crude, and it
  // holds the one invariant that matters: nothing opaque stands in for
  // something transparent.
  const paintBody = src.slice(src.indexOf('const paint = (g) =>'),
    src.indexOf('for (const g of groups) if (!g.blend) paint(g);'));
  assert.match(paintBody, /if \(!tex && g\.blend\) return;/,
    'a blended group with no texture is skipped, not drawn grey');
  assert.ok(paintBody.indexOf('if (!tex && g.blend) return;')
    < paintBody.indexOf('gl.bindTexture'),
    'and skipped BEFORE it binds the grey fallback');

  // The opaque path still falls back to grey, which is right: an unpainted
  // solid surface should read as unpainted rather than vanish.
  assert.match(paintBody, /tex \?\? unpainted/);
});

test('an emissive sheet adds light instead of covering what is behind it', async () => {
  // The black rectangle over the number plates, finally. Both the plate and its
  // twin are ksPerPixelAlpha, so both go into the blended pass — and the twin
  // is a 32x32 DXT5 glow map whose RGB is black. Composited with SRC_ALPHA an
  // opaque black texture is simply a black rectangle, drawn co-planar with the
  // plate and sorted against it.
  //
  // Assetto Corsa draws emissive sheets ADDITIVELY: black adds nothing, so the
  // plate shows through. That is the difference, and no amount of getting the
  // alpha pass right would have found it.
  const { additive } = await import('../src/engine/kn5.mjs');

  assert.equal(additive('IGT_Numberplate_Emissive.dds'), true);
  assert.equal(additive('honda_emissive.dds'), true);
  assert.equal(additive('EXT_Glass_Emissive_Headlights.dds'), true);

  // The plate itself is NOT additive — it is the thing being lit.
  assert.equal(additive('IGT_Numberplate_Colour.dds'), false);
  assert.equal(additive('EXT_Skin_Sponsors.dds'), false);
  assert.equal(additive(undefined), false);

  // Detected by name, which is weaker than reading a shader and is what the
  // model gives: the two meshes share a shader and differ only in what their
  // texture is called. If that ever stops holding, this is the line to doubt.
  assert.equal(additive('anything_EMISSIVE_uppercase.dds'), true, 'case-insensitive');

  // And the viewer has to pick the blend mode per group, not once for the pass.
  const src = await readFile(new URL('../src/ui/view3d.js', import.meta.url), 'utf8');
  const pass = src.slice(src.indexOf('for (const g of blended)'));
  assert.match(pass, /if \(g\.add\) gl\.blendFunc\(gl\.ONE, gl\.ONE\);/);
  assert.match(pass, /else gl\.blendFunc\(gl\.SRC_ALPHA, gl\.ONE_MINUS_SRC_ALPHA\);/);
});

test('a surface the browser cannot rasterise fails loudly and alone', async () => {
  // Three rounds of "I still cannot see the plate, no errors in console", and
  // this is why the console was clean. setWholeCar awaited each upload in
  // sequence, so one surface whose svg would not rasterise threw, abandoned the
  // remaining uploads AND the stock-texture pass, and returned before `groups`
  // was assigned — leaving the previous frame on screen. Indistinguishable from
  // "the new surface did not render", and silent, because the throw was
  // swallowed by the caller.
  const src = await readFile(new URL('../src/ui/view3d.js', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('const failed = [];'),
    src.indexOf('// The parts the design does NOT paint'));

  assert.match(loop, /try \{[\s\S]*await uploadSvg[\s\S]*\} catch/,
    'each upload is attempted on its own');
  assert.match(loop, /failed\.push/, 'and a failure is recorded rather than thrown');

  // The report has to reach the person, not a console they have no reason to
  // open. The viewer hands it back; the editor puts it in #viewnote.
  assert.match(src, /return \{\s*uploaded:/, 'setWholeCar reports what it managed');
  const app = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /const drew = await state\.viewer\.setWholeCar/);
  assert.match(app, /FAILED TO UPLOAD/, 'and says so on screen');
});

test('a design can name surfaces the car should not draw', async () => {
  // A GT3 car ships one set of number plate meshes per racing series and
  // renders ALL of them. The Honda has eight on the left flank alone — IGT,
  // IMSA and two Blancpain variants, each with an emissive twin — stacked in
  // one patch of door. In the game a skin makes the unused ones transparent;
  // here they wore their stock 32x32 black textures and were drawn over the
  // plate the design had just painted.
  //
  // This is a CHOICE and not something to infer. I tried inferring it twice:
  // "unpainted geometry inside painted geometry" hid half the car, because a
  // group is a whole texture and the body's box encloses the mirrors and the
  // radiator; adding a size-similarity test hid the hood lining and the nets.
  // Bounding boxes cannot tell an alternate from a part, which I had already
  // concluded once while building the fitment checker and then ignored.
  const { wholeModelGeometry } = await import('../src/ui/server.mjs');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const model = parseKn5Buffer(carKn5());

  // No painted files, so every mesh arrives as a roleless leftover — the same
  // shape the plate sets have on the real car.
  const shown = wholeModelGeometry(model, []);
  const other = shown.groups.find((g) => !g.role && g.file);
  assert.ok(other, `something unpainted to hide: ${JSON.stringify(shown.groups)}`);

  const profile = { textures: { spare: { file: other.file } } };
  const hidden = wholeModelGeometry(model, [], { livery: { hide: ['spare'] }, profile });

  assert.ok(!hidden.groups.some((g) => g.file === other.file),
    'the named surface is not emitted at all — not drawn, not fetched, not counted');
  assert.equal(hidden.groups.length, shown.groups.length - 1);

  // Painted surfaces are never hidden this way: `hide` names things the design
  // does not paint, and silently dropping its own artwork would be far worse
  // than leaving an unwanted plate on screen.
  const stillPainted = wholeModelGeometry(model, [{ role: 'body', file: CAR.texture }], {
    livery: { hide: ['body'] },
    profile: { textures: { body: { file: CAR.texture } } },
  });
  assert.ok(stillPainted.groups.some((g) => g.role === 'body'),
    'a surface the design paints survives being named');

  // An unknown role is ignored rather than throwing: a design travels between
  // cars, and naming a plate set this car does not have is not an error.
  assert.doesNotThrow(() => wholeModelGeometry(model, [], {
    livery: { hide: ['no_such_role_on_this_car'] }, profile: {},
  }));
});

test('a texture is clamped on both axes, and the budget measures what it returns', async () => {
  const { capped, textureSizes } = await import('../src/ui/view3d.js');

  // Halving stopped when EITHER side reached 1, so a very wide, very short
  // sheet bottomed out with the long side still over the limit — which is the
  // texImage2D error this exists to prevent.
  assert.deepEqual(capped(8192, 2, 4096), [4096, 1]);
  assert.deepEqual(capped(8192, 2, 1024), [1024, 1]);
  for (const [w, h] of [[8192, 2], [16384, 1], [4096, 4096], [5000, 3]]) {
    const [a, b] = capped(w, h, 2048);
    assert.ok(a <= 2048 && b <= 2048, `${w}x${h} -> ${a}x${b} is still over the limit`);
  }
  assert.deepEqual(capped(2048, 512, 4096), [2048, 512], 'and nothing shrinks needlessly');

  // The budget check divided without rounding while the result rounded up, so
  // a set could pass the check and then exceed the budget it passed.
  const many = Array.from({ length: 40 }, () => ({ width: 2048, height: 2048 }));
  for (const budget of [64, 32, 16].map((mb) => mb * 1024 * 1024)) {
    const sizes = textureSizes(many, { budget });
    const total = sizes.reduce((n, s) => n + s.w * s.h * 4, 0);
    assert.ok(total <= budget,
      `${(total / 1048576).toFixed(1)} MB returned against a ${budget / 1048576} MB budget`);
  }
});

test('hide is guarded, because a design is hand-edited', async () => {
  const { wholeModelGeometry } = await import('../src/ui/server.mjs');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const model = parseKn5Buffer(carKn5());
  const all = wholeModelGeometry(model, []).groups.length;

  // A string iterates as characters — five roles named i, m, s, a — so a
  // plausible typo would silently hide whatever single-letter role existed.
  assert.equal(wholeModelGeometry(model, [], {
    livery: { hide: 'imsa' }, profile: { textures: { i: { file: 'x.dds' } } },
  }).groups.length, all, 'a string hides nothing rather than hiding by letter');

  // And a profile entry whose file is not a string must not throw inside
  // toLowerCase halfway through building the car.
  assert.doesNotThrow(() => wholeModelGeometry(model, [], {
    livery: { hide: ['odd'] }, profile: { textures: { odd: { file: 42 } } },
  }));
  assert.doesNotThrow(() => wholeModelGeometry(model, [], {
    livery: { hide: null }, profile: {},
  }));
});

test('the single-surface payload carries normals too, at the right offset', async () => {
  // The whole-car format was covered and this one was not, though both changed.
  // Adding an array to a packed format is exactly where an off-by-one offset
  // hides: everything still parses and the numbers belong to someone else.
  const { modelGeometry, packGeometry } = await import('../src/ui/server.mjs');
  const { unpack } = await import('../src/ui/view3d.js');
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');

  const g = modelGeometry(parseKn5Buffer(carKn5()), CAR.texture);
  const back = unpack(new Uint8Array(packGeometry(g)).buffer);

  assert.deepEqual([...back.normals], [...g.normals]);
  assert.deepEqual([...back.uvs], [...g.uvs], 'and the array before them');
  assert.deepEqual([...back.indices], [...g.indices], 'and the one after');

  assert.throws(() => packGeometry({ ...g, normals: undefined }),
    /needs a typed array for "normals"/,
    'a builder that has not caught up is told so at the call that did it');
});
