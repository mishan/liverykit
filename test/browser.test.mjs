// ---------------------------------------------------------------------------
// The editor, driven in a real browser.
//
// Everything else in this suite tests the editor through a fake DOM, and that
// fake has now hidden five separate bugs: it renders no CSS, so specificity does
// not exist in it; it invents an element for any selector, so a missing or
// duplicated id cannot be noticed; and it dispatches events onto nodes the test
// already found, which proves a handler works without proving a pointer could
// ever reach it.
//
// So this drives Firefox against the real server, and — the important part —
// interacts by HIT-TESTING. It asks `elementFromPoint` what is actually on top
// at a coordinate and dispatches there, exactly as a mouse would. Three of the
// bugs above were things sitting invisibly on top of what you were aiming at;
// none of them could survive this test.
//
// Skipped, not failed, when no browser is present, so a CI box without one still
// runs everything else.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { loadProfile } from '../src/profile.mjs';
import '../src/index.mjs';

function findBrowser() {
  for (const b of ['firefox', 'chromium', 'chromium-browser', 'google-chrome']) {
    try {
      execFileSync('command', ['-v', b], { shell: '/bin/bash', stdio: 'pipe' });
      return b;
    } catch { /* keep looking */ }
  }
  return null;
}
const BROWSER = findBrowser();

/**
 * Run a script inside the real editor page and get its findings back.
 *
 * A thin proxy sits in front of the real UI server and does two things: injects
 * the driver into the page, and catches its report. Everything else — the app,
 * the API, the renderer — is the genuine article rather than a stand-in.
 */
async function inBrowser(driver, { fitPath, livery: liveryName = 'neon-grid-any', car = 'abarth500' }) {
  const profile = await loadProfile(new URL(`../cars/${car}.json`, import.meta.url));
  const livery = (await import(`../liveries/${liveryName}.mjs`)).default;
  const real = await startUi({ livery, profile, fitPath, port: 0, log: () => {} });
  const realPort = real.server.address().port;

  let report = null;
  const proxy = createServer(async (req, res) => {
    if (req.url === '/report') {
      const c = []; for await (const x of req) c.push(x);
      report = JSON.parse(Buffer.concat(c).toString());
      return res.end('ok');
    }
    if (req.url === '/driver.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(driver);
    }
    const body = [];
    for await (const x of req) body.push(x);
    const upstream = await fetch(`http://127.0.0.1:${realPort}${req.url}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: body.length ? Buffer.concat(body) : undefined,
    });
    const type = upstream.headers.get('content-type') ?? 'text/plain';
    let out = Buffer.from(await upstream.arrayBuffer());
    if (req.url === '/') {
      out = Buffer.from(out.toString('utf8')
        .replace('</body>', '<script type="module" src="/driver.js"></script></body>'));
    }
    res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(out);
  });
  await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${proxy.address().port}/`;

  const args = BROWSER === 'firefox'
    ? ['--headless', '--window-size=1400,900', url]
    : ['--headless=new', '--disable-gpu', '--window-size=1400,900', url];
  const child = spawn(BROWSER, args, { stdio: 'ignore' });

  const deadline = Date.now() + 40000;
  while (!report && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  child.kill('SIGKILL');
  proxy.close();
  real.server.close();

  assert.ok(report, 'the browser never reported back — it may have failed to start');
  const failures = report.filter((l) => /^(ERROR|REJECT|THREW)/.test(l));
  assert.deepEqual(failures, [], `the page reported errors: ${failures.join(' | ')}`);
  return report;
}

/** Shared preamble: wait for the app, then interact by hit-testing. */
const PRELUDE = `
const out = []; const say = (m) => out.push(String(m));
addEventListener('error', (e) => say('ERROR ' + e.message));
addEventListener('unhandledrejection', (e) => say('REJECT ' + (e.reason?.stack || e.reason)));
const done = () => fetch('/report', { method: 'POST', body: JSON.stringify(out) });
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const centre = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; };
// What a MOUSE would hit at this point — not the node we happen to hold.
const topAt = (x, y) => document.elementFromPoint(x, y);
const clickAt = (x, y, type = 'pointerdown') => {
  const el = topAt(x, y);
  el?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
  if (type === 'pointerdown') el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return el;
};
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('#regions li').length) return true;
    await settle(200);
  }
  return false;
};
`;

test('a real pointer can select a region from the list', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The list is the first thing anyone touches. This checks not merely that the
  // handler works, but that nothing is sitting on top of the list intercepting
  // the pointer — the failure that made this editor look dead three times.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const li = [...document.querySelectorAll('#regions li')].find((l) => l.dataset.id);
      say('target: ' + li.dataset.id);
      const [x, y] = centre(li);
      const hit = topAt(x, y);
      say('topmost at list item: <' + hit.tagName.toLowerCase() + '> in #' + (hit.closest('[id]')?.id ?? 'nothing'));
      clickAt(x, y);
      await settle(600);
      say('selected: ' + document.querySelectorAll('#regions li.sel').length);
      say('inspector mentions it: ' + document.querySelector('#inspector').textContent.includes(li.dataset.id));
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.match(find('topmost at list item'), /#regions/,
    `something is covering the region list: ${find('topmost at list item')}`);
  assert.equal(find('selected: '), 'selected: 1', report.join(' | '));
  assert.equal(find('inspector mentions it: '), 'inspector mentions it: true');
});

test('a real pointer can select and drag a region on the canvas', { skip: BROWSER ? false : 'no browser' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lk-fit-'));
  const fitPath = join(dir, 'fit.json');
  await writeFile(fitPath, JSON.stringify({
    livery: 'neon-grid-any', car: 'abarth500',
    regions: { 'number-left': { panel: 'left_mid', at: [0.3, 0.3, 0.3, 0.3] } },
  }));

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const ghost = document.querySelector('#overlay .ghost');
      if (!ghost) { say('THREW no other region drawn on the canvas'); return done(); }
      const [gx, gy] = centre(ghost);
      say('topmost at ghost: ' + topAt(gx, gy).getAttribute('class'));
      clickAt(gx, gy);
      await settle(600);
      say('boxes: ' + document.querySelectorAll('#overlay .box').length);

      const box = document.querySelector('#overlay .box');
      const [bx, by] = centre(box);
      say('topmost at box: ' + topAt(bx, by).getAttribute('class'));
      const before = document.querySelector('#fitjson').textContent;
      clickAt(bx, by);
      for (const dx of [10, 25, 40]) {
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bx + dx, clientY: by + dx, pointerId: 1 }));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: bx + 40, clientY: by + 40, pointerId: 1 }));
      await settle(800);
      const after = document.querySelector('#fitjson').textContent;
      say('fit changed: ' + (after !== before));
      say('save enabled: ' + !document.querySelector('#save').disabled);
      try {
        const at = JSON.parse(after).regions['number-left'].at;
        say('at in range: ' + at.every((n) => n >= 0 && n <= 1) + ' ' + JSON.stringify(at));
      } catch (e) { say('THREW reading at: ' + e.message); }
      document.querySelector('#save').click();
      await settle(700);
      say('status: ' + document.querySelector('#status').textContent);
      done();
    })();
  `, { fitPath });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.equal(find('topmost at ghost: '), 'topmost at ghost: ghost',
    `the ghost must be the topmost thing at its own centre — ${report.join(' | ')}`);
  assert.equal(find('boxes: '), 'boxes: 1', 'clicking a ghost selects that region');
  assert.match(find('topmost at box: '), /box/, 'the drag box must be reachable by a pointer');
  assert.equal(find('fit changed: '), 'fit changed: true', 'the drag must reach the fit');
  assert.equal(find('save enabled: '), 'save enabled: true');
  assert.match(find('at in range: '), /^at in range: true/,
    `a drag must never write coordinates the renderer rejects — ${find('at in range: ')}`);

  // And the save actually reached disk through the real endpoint.
  const saved = JSON.parse(await readFile(fitPath, 'utf8'));
  assert.equal(saved.car, 'abarth500');
  assert.ok(saved.regions['number-left'].at.every((n) => n >= 0 && n <= 1));
});

test('switching to the car view never leaves a blank editor', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The canvas once stayed on top while marked hidden, because `hidden` is only
  // a UA rule and the stylesheet outranked it: the UV view went blank on the
  // first visit to the 3D tab and stayed blank on the way back.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const stageCentre = () => centre(document.querySelector('#stage'));
      say('uv topmost: ' + (topAt(...stageCentre())?.getAttribute('class') ?? topAt(...stageCentre())?.id));
      document.querySelector('#tab-3d').click();
      await settle(1500);
      document.querySelector('#tab-uv').click();
      await settle(800);
      const back = topAt(...stageCentre());
      say('after round trip topmost: ' + (back?.getAttribute('class') ?? back?.id));
      say('canvas hidden: ' + document.querySelector('#carview').hidden);
      say('texture present: ' + !!document.querySelector('#texture svg'));
      say('overlay rects: ' + document.querySelectorAll('#overlay rect').length);
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.equal(find('canvas hidden: '), 'canvas hidden: true', 'back in UV, the canvas must be gone');
  assert.equal(find('texture present: '), 'texture present: true');
  assert.notEqual(find('overlay rects: '), 'overlay rects: 0', 'the overlay must still be drawn');
  assert.doesNotMatch(find('after round trip topmost: '), /carview/,
    'the canvas must not still be covering the UV view');
});

test('a livery with no region ids at all is still editable', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The case that made the editor useless in practice. neon-grid — the original,
  // car-specific design — has 95 regions and not one `id`, so every row read
  // "no id" and nothing could be selected. The tool did exactly what it was told
  // and was of no use whatever, which is a flaw in the design and not the code.
  //
  // Regions without a name are addressed by POSITION now, which is weaker and
  // is labelled as such, but means an existing livery can be opened and worked
  // on rather than merely looked at.
  const dir = await mkdtemp(join(tmpdir(), 'lk-noid-'));
  const fitPath = join(dir, 'fit.json');

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const lis = [...document.querySelectorAll('#regions li')];
      say('rows: ' + lis.length);
      say('locked rows: ' + lis.filter((l) => l.classList.contains('locked')).length);
      say('derived rows: ' + lis.filter((l) => l.classList.contains('derived')).length);
      const [x, y] = centre(lis[0]);
      clickAt(x, y);
      await settle(700);
      say('selected: ' + document.querySelectorAll('#regions li.sel').length);
      say('warns about position: ' + document.querySelector('#inspector').textContent.includes('position'));
      say('boxes: ' + document.querySelectorAll('#overlay .box').length);
      done();
    })();
  `, { fitPath, livery: 'neon-grid', car: 'rss_formula_rss_4' });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.notEqual(find('rows: '), 'rows: 0');
  assert.equal(find('locked rows: '), 'locked rows: 0', 'nothing may be unselectable for want of a name');
  assert.notEqual(find('derived rows: '), 'derived rows: 0', 'and they are labelled as positional');
  assert.equal(find('selected: '), 'selected: 1', report.join(' | '));
  assert.equal(find('warns about position: '), 'warns about position: true',
    'the weakness of a positional key has to be said, not buried');
  assert.equal(find('boxes: '), 'boxes: 1', 'and it can actually be dragged');
});
