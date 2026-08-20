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
  const boot = src.indexOf('await selectSurface(');
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

test('a selected region turns into a highlight the shader can use', async () => {
  const { highlightUniforms } = await import('../src/ui/view3d.js');

  // "Nothing selected" has to be expressible, because it is the state the
  // editor spends most of its time in.
  for (const empty of [null, undefined, [], [0.1, 0.1, 0, 0.4], [0.1, 0.1, 0.4, 0]]) {
    assert.deepEqual(highlightUniforms(empty).region, [0, 0, 0, 0], JSON.stringify(empty));
  }
  // NaN reaches here from a drag in progress. A NaN uniform does not throw; it
  // silently fails every comparison in the shader, so the highlight vanishes
  // and the car looks like the feature is broken.
  assert.deepEqual(highlightUniforms([NaN, 0, NaN, 0.2]).region, [0, 0, 0, 0]);

  const big = highlightUniforms([0.1, 0.2, 0.5, 0.4]);
  assert.deepEqual(big.region, [0.1, 0.2, 0.5, 0.4], 'passed through in texture space');
  assert.equal(big.border, 0.0025, 'an ordinary region gets the fixed thin edge');

  // A region a few texels across must not come out as a solid block of accent —
  // at that size a fixed border meets itself in the middle.
  const tiny = highlightUniforms([0.5, 0.5, 0.004, 0.006]);
  assert.ok(tiny.border < 0.004 / 2, `border ${tiny.border} would swallow a 0.004-wide region`);
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
      indices: Uint32Array.from([0]),
      groups: [{ role, file: `${role}.dds`, start: 0, count: 1 }],
      bounds: { lo: [0, 0, 0], hi: [1, 1, 1] },
    };
    const buf = new Uint8Array(packModel(g)).buffer;
    const back = unpackModel(buf);          // throws on a misaligned offset
    assert.equal(back.groups[0].role, role);
    assert.deepEqual([...back.positions], [0, 1, 2]);
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

test('the highlight carries the host panel as well as the region', async () => {
  const { highlightUniforms } = await import('../src/ui/view3d.js');

  const both = highlightUniforms([0.2, 0.2, 0.1, 0.1], [0.1, 0.1, 0.5, 0.5]);
  assert.deepEqual(both.region, [0.2, 0.2, 0.1, 0.1]);
  assert.deepEqual(both.panel, [0.1, 0.1, 0.5, 0.5]);

  // A region placed by absolute coordinates has no host panel, and claiming one
  // would draw a boundary that does not constrain anything.
  assert.deepEqual(highlightUniforms([0.2, 0.2, 0.1, 0.1]).panel, [0, 0, 0, 0]);
  assert.deepEqual(highlightUniforms([0.2, 0.2, 0.1, 0.1], [0, 0, 0, 0]).panel, [0, 0, 0, 0]);
  assert.deepEqual(highlightUniforms([0.2, 0.2, 0.1, 0.1], [0, 0, NaN, 1]).panel, [0, 0, 0, 0]);

  // Nothing selected means no panel either — a lone panel outline with no
  // artwork in it would say a region is there when none is.
  assert.deepEqual(highlightUniforms(null, [0.1, 0.1, 0.5, 0.5]).panel, [0, 0, 0, 0]);
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

test('the shipped example livery pairs all three of its sided regions', async () => {
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const state = editorState({ livery, profile, fit: null });
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
    state: editorState({ livery, profile, fit }),
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

  // Only V affects which way the artwork reads: reversing u moves it to the
  // other end of the panel without turning it over.
  assert.equal(mirrorRotation(90, { u: true, v: false }), 90);
  assert.equal(mirrorRotation(90, { u: false, v: true }), 270);
  assert.equal(mirrorRotation(0, { u: false, v: true }), 180);
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
