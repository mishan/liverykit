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
import { spawn } from 'node:child_process';
import { accessSync, statSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { loadProfile } from '../src/profile.mjs';
import '../src/index.mjs';

/**
 * The first browser on PATH, or null.
 *
 * PATH is walked here rather than asking a shell, because this decides whether
 * the suite runs or silently skips. `command -v` needs a shell to run in, and
 * the obvious one to name is bash — which a minimal container may well not have,
 * so every probe throws, every browser looks absent, and the tests that exist to
 * catch "the editor looks fine and is unusable" quietly stop running. A skip
 * that is wrong is worse than a failure, because nothing reports it.
 */
function findBrowser() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  // On Windows the executable is firefox.exe; elsewhere the name is the name.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const b of ['firefox', 'chromium', 'chromium-browser', 'google-chrome']) {
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          const p = join(dir, b + ext);
          // A DIRECTORY passes X_OK — that is what the execute bit means on a
          // directory — so the access check alone will happily report a folder
          // called `chromium` as a browser. spawn then fails with EACCES and
          // the suite reports that the browser would not start, which is a
          // maddening thing to debug from a CI log. statSync follows symlinks,
          // so /usr/bin/firefox -> ../lib/firefox/firefox still resolves.
          if (!statSync(p).isFile()) continue;
          accessSync(p, constants.X_OK);
          return b;
        } catch { /* keep looking */ }
      }
    }
  }
  return null;
}
const BROWSER = findBrowser();

/**
 * Whether a missing browser is allowed to be a quiet skip.
 *
 * Locally it should be: not everyone has Firefox, and the rest of the suite is
 * worth running without it. In CI it must not be. A skip prints nothing anyone
 * reads, so an image that stops shipping a browser turns this whole file off and
 * the build stays green — reporting coverage it is no longer getting. The
 * workflow sets this, and then the absence is a failure with a name.
 */
const REQUIRED = !!process.env.LIVERYKIT_REQUIRE_BROWSER;

test('a browser is present, where the environment says one has to be', {
  skip: REQUIRED ? false : 'only asked where a browser is required',
}, () => {
  assert.ok(BROWSER,
    'LIVERYKIT_REQUIRE_BROWSER is set and no browser is on PATH, so every test '
    + 'in this file would have skipped and the run would have been green for nothing.');
});

test('the browser probe does not depend on a shell being installed', async () => {
  // This decides whether the rest of this file runs. `command -v` needs a shell
  // to run in, and the obvious one to name is bash — which a minimal container
  // may not have. Then every probe throws, every browser looks absent, and the
  // tests that catch "the editor looks fine and is unusable" quietly stop
  // running. A wrong skip is worse than a failure, because nothing reports it.
  const path = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.equal(findBrowser(), null, 'nothing on an empty PATH');
  } finally {
    process.env.PATH = path;
  }
  // And a directory that certainly holds no browser is not mistaken for one.
  const dir = process.env.PATH;
  try {
    process.env.PATH = join(tmpdir(), 'lk-definitely-not-a-bin-dir');
    assert.equal(findBrowser(), null);
  } finally {
    process.env.PATH = dir;
  }

  // The one an access check gets wrong on its own: a DIRECTORY has the execute
  // bit, so `access(X_OK)` says yes to a folder called `chromium`. spawn then
  // fails with EACCES and the suite reports a browser that would not start,
  // which from a CI log is indistinguishable from a real startup failure.
  const decoy = await mkdtemp(join(tmpdir(), 'lk-decoy-'));
  await mkdir(join(decoy, 'chromium'));
  const before = process.env.PATH;
  try {
    process.env.PATH = decoy;
    assert.equal(findBrowser(), null, 'a directory is not an executable');
  } finally {
    process.env.PATH = before;
  }
});

/**
 * Start a browser and keep hold of why it might not have worked.
 *
 * `stdio: 'ignore'` and no listeners was the original, and it made every
 * possible failure — the binary missing, the profile unreadable, a GL stack that
 * aborts on startup, a sandbox refusing to fork — arrive as the same sentence:
 * "the browser never reported back". On a machine you can log into that is
 * merely annoying. In CI it is the whole message, and there is nothing to go on.
 *
 * So: capture the output, notice the exit, and hold both for the assertion. Note
 * `spawn` emits `error` on ENOENT, and an EventEmitter with no `error` listener
 * THROWS — a missing binary would have surfaced as an uncaught exception from
 * somewhere unrelated rather than as this test failing.
 */
async function launch(command, args, env = {}) {
  // `detached` puts the child in its own process GROUP, which is the only way to
  // stop it cleanly. Under Xvfb the thing spawned is `xvfb-run`, a shell script:
  // signalling it leaves Xvfb and the browser running, and those survivors hold
  // the pipes below open — so the test passes, the run finishes, and node then
  // sits there forever with nothing left to do. Signalling the group reaches all
  // of them.
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: browserEnv(env),
    detached: true,
  });
  const state = { done: false, code: null, signal: null, error: null, output: '' };

  // Bounded: a browser that fails in a loop can produce megabytes, and the tail
  // is the part that says why.
  const keep = (chunk) => {
    state.output = (state.output + chunk).slice(-4000);
  };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', keep);
  child.stderr.setEncoding('utf8'); child.stderr.on('data', keep);
  child.on('error', (e) => { state.error = e; state.done = true; });
  child.on('exit', (code, signal) => { state.done = true; state.code = code; state.signal = signal; });

  return {
    get done() { return state.done; },
    kill: () => {
      // The group, then the pipes. Killing alone is not enough: a handle Node
      // still holds keeps the event loop alive whether or not anything is
      // writing to it.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
    why(waited) {
      const how = state.error ? `could not be started: ${state.error.message}`
        : state.done ? `exited after ${(waited / 1000).toFixed(1)}s `
          + `(code ${state.code}, signal ${state.signal})`
        : `was still running after ${(waited / 1000).toFixed(1)}s`;
      const tail = state.output.trim();
      const set = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
      return `\`${set ? set + ' ' : ''}${command} ${args.join(' ')}\` ${how}.`
        + (tail ? `\nIts output was:\n${tail}` : '\nIt printed nothing.');
    },
  };
}

/**
 * The environment a headless browser gets.
 *
 * Nothing forced here. An earlier version exported MOZ_X11_EGL and friends
 * unconditionally, which is right when a display exists and is a request for an
 * X11 EGL path that cannot exist when one does not — so on a machine with no X
 * server at all, the settings meant to GIVE the tests a GL stack were the reason
 * the browser never came up. The GL-specific overrides now live with the code
 * that arranges a display.
 */
function browserEnv(extra = {}) {
  return { ...process.env, ...extra };
}

/**
 * Run a script inside the real editor page and get its findings back.
 *
 * A thin proxy sits in front of the real UI server and does two things: injects
 * the driver into the page, and catches its report. Everything else — the app,
 * the API, the renderer — is the genuine article rather than a stand-in.
 */
async function inBrowser(driver, {
  fitPath, livery: liveryName = 'neon-grid-any', car = 'abarth500',
  profile: profileOverride = null, liveryObject = null, modelPath = null,
}) {
  const profile = profileOverride
    ?? await loadProfile(new URL(`../cars/${car}.json`, import.meta.url));
  const livery = liveryObject ?? (await import(`../liveries/${liveryName}.mjs`)).default;
  const real = await startUi({ livery, profile, fitPath, liveryId: liveryName, modelPath, port: 0, log: () => {} });
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
  const child = await launch(BROWSER, args);

  // Longer than a dev box needs, because a CI runner is not a dev box: a cold
  // browser start on two shared cores is several times slower than here, and a
  // timeout that only fails on the slow machine is the worst kind. Overridable
  // for anyone whose box is slower still.
  const limit = Number(process.env.LIVERYKIT_BROWSER_TIMEOUT_MS) || 90000;
  const deadline = Date.now() + limit;
  // `child.done` too, so a browser that exits without loading the page fails in
  // a second with its own error message rather than after the full timeout with
  // none.
  while (!report && !child.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const waited = Date.now() - (deadline - limit);
  child.kill();
  proxy.close();
  real.server.close();

  assert.ok(report, 'the browser never reported back. ' + child.why(waited));
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

test('the selected region reaches the car as a highlight', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The shader is the one part of this project a fake DOM cannot touch at all:
  // GLSL is compiled by the driver, and a typo in it throws from inside the tab
  // switch where the app catches it and writes a note nobody reads.
  //
  // Rather than read pixels back — the context is created without
  // preserveDrawingBuffer, so a readback after the frame is empty — this asks
  // the GPU program what it was actually told. `getUniform` returns the live
  // value of `region`, which can only be right if the shader compiled, the
  // program linked, the app found the selection and the viewer uploaded it. A
  // wrong rectangle here is a wrong rectangle on the car.
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'lk-car-'));
  const modelPath = join(dir, 'car.kn5');
  await writeFile(modelPath, carKn5());
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });

  // A rectangle chosen to be nobody's default: if the uniform comes back as
  // this, it came from the region and not from an initial value.
  const at = [0.25, 0.5, 0.5, 0.25];
  const livery = {
    name: 'fixture', car: 'fixture_car',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        role: 'body',
        regions: [
          { id: 'flank-mark', panel: 'left_mid', at, treatment: 'fill', color: 'accent' },
        ],
      },
    },
  };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const li = [...document.querySelectorAll('#regions li')].find((l) => l.dataset.id === 'flank-mark');
      const [x, y] = centre(li);
      clickAt(x, y);
      await settle(400);

      document.querySelector('#tab-3d').click();
      await settle(2500);
      say('note: ' + document.querySelector('#viewnote').textContent);

      const canvas = document.querySelector('#carview');
      // The same context the viewer holds — getContext returns the existing one.
      const gl = canvas.getContext('webgl');
      if (!gl) { say('webgl: absent'); return done(); }
      say('webgl: present');
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!prog) { say('program: none'); return done(); }
      const region = gl.getUniform(prog, gl.getUniformLocation(prog, 'region'));
      say('region: ' + Array.from(region).map((n) => n.toFixed(4)).join(','));
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath: join(dir, 'fit.json') });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  if (find('webgl: ') === 'webgl: absent') {
    // A headless box with no GL is a fact about the box, not a failure of the
    // code. Everything up to the upload was still exercised.
    assert.match(find('note: '), /triangles|no 3D view/, report.join(' | '));
    return;
  }
  assert.equal(find('webgl: '), 'webgl: present', report.join(' | '));
  assert.match(find('note: '), /triangles/, 'the fixture car should have loaded');

  // The panel is [0.02, 0.02, 0.29, 0.46] and `at` is panel-relative, so the
  // absolute rectangle is the panel's origin plus a quarter of its width, and
  // so on. Computed here rather than hardcoded, because the point is that the
  // two ends agree, not that a magic number survived.
  const p = CAR.faces.left;
  const want = [p[0] + at[0] * p[2], p[1] + at[1] * p[3], at[2] * p[2], at[3] * p[3]];
  const got = find('region: ').slice('region: '.length).split(',').map(Number);
  for (const [i, n] of want.entries()) {
    assert.ok(Math.abs(got[i] - n) < 0.002,
      `region[${i}] reached the GPU as ${got[i]}, expected ${n.toFixed(4)} — ${report.join(' | ')}`);
  }
});

test('the whole-car view puts every painted surface on the model at once', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The per-surface view answers "did this land where I meant". This one answers
  // "does the design work", which needs every texture on the car at once — and
  // it is the only view that exercises multi-texture drawing, grouped index
  // offsets and the padded binary header together.
  //
  // Headless browsers do not reliably have a GL driver; this one reports
  // "Exhausted GL driver options" on some runs and works on others. So the test
  // asserts BOTH outcomes rather than skipping, because the no-GL path is a real
  // path a real person hits on a real machine, and what matters there is that
  // the editor degrades to something usable instead of dying.
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'lk-all-'));
  const modelPath = join(dir, 'car.kn5');
  await writeFile(modelPath, carKn5());
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });

  const livery = {
    name: 'fixture', car: 'fixture_car',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        role: 'body',
        regions: [{ id: 'flank', panel: 'left_mid', treatment: 'fill', color: 'accent' }],
      },
    },
  };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }

      // Asked on a THROWAWAY canvas. Firefox caches the failure against the
      // element it was asked on, so probing #carview would break the very thing
      // under test.
      const probe = document.createElement('canvas');
      probe.width = probe.height = 64;
      say('webgl: ' + (probe.getContext('webgl') ? 'present' : 'absent'));

      document.querySelector('#tab-all').click();
      await settle(4000);
      say('note: ' + document.querySelector('#viewnote').textContent);
      say('canvas hidden: ' + document.querySelector('#carview').hidden);

      const stage = document.querySelector('#stage').getBoundingClientRect();
      const mid = [Math.round(stage.x + stage.width / 2), Math.round(stage.y + stage.height / 2)];
      say('topmost over stage: ' + (topAt(mid[0], mid[1])?.id ?? 'nothing'));

      const gl = document.querySelector('#carview').getContext('webgl');
      if (gl) {
        const prog = gl.getParameter(gl.CURRENT_PROGRAM);
        const region = prog ? gl.getUniform(prog, gl.getUniformLocation(prog, 'region')) : [];
        say('region: ' + Array.from(region).join(','));
      }
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath: join(dir, 'fit.json') });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';

  if (find('webgl: ') === 'webgl: absent') {
    // No driver. The editor must fall back to UV and stay WORKABLE — the canvas
    // out of the way and the overlay reachable again. A dead stage with a
    // hidden canvas still on top of it is this editor's oldest failure.
    assert.equal(find('canvas hidden: '), 'canvas hidden: true', report.join(' | '));
    assert.match(find('note: '), /no 3D view/, report.join(' | '));
    assert.equal(find('topmost over stage: '), 'topmost over stage: overlay',
      `without WebGL the UV editor must still be reachable: ${report.join(' | ')}`);
    return;
  }

  assert.equal(find('canvas hidden: '), 'canvas hidden: false', report.join(' | '));
  assert.equal(find('topmost over stage: '), 'topmost over stage: carview',
    `something is covering the car: ${report.join(' | ')}`);
  assert.match(find('note: '), /painted surface/, report.join(' | '));
  assert.doesNotMatch(find('note: '), /^note: 0 triangles/, report.join(' | '));
  // Grouped drawing must NOT dim the car: a UV rectangle means something
  // different on every texture, so a highlight read off one of them would dim
  // the others by an unrelated coincidence of coordinates.
  assert.equal(find('region: '), 'region: 0,0,0,0',
    'the whole-car view must not dim itself around one surface\'s rectangle');
});
