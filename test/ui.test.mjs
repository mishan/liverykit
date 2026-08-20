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
  const saved = {
    document: g.document, fetch: g.fetch,
    performance: g.performance, structuredClone: g.structuredClone,
  };

  g.document = dom;
  g.performance ??= { now: () => 0 };
  g.structuredClone ??= (o) => JSON.parse(JSON.stringify(o));
  g.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    const body = path === '/api/state' ? state : render;
    return { ok: true, status: 200, json: async () => body };
  };

  try {
    // Cache-busted so each test gets a fresh evaluation; a module that throws
    // on first import would otherwise be cached as failed.
    await import(`../src/ui/app.js?t=${Date.now()}${Math.random()}`);
  } finally {
    Object.assign(g, saved);
  }
  return { dom, calls };
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
  const boot = src.lastIndexOf('await selectSurface(');
  assert.ok(boot > 0, 'the module still boots by selecting a surface');
  const after = src.slice(boot).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.equal(after.length, 1, `nothing may follow the boot await, found: ${after.slice(1)}`);
});
