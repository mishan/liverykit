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

/**
 * Whether an X display is actually usable, as opposed to merely named.
 *
 * DISPLAY is set in plenty of environments where nothing will answer on it —
 * a container inheriting the variable, or a host Xwayland whose auth file this
 * process cannot read. Firefox then falls back to a path with no GL at all and
 * reports "Exhausted GL driver options", which reads as "this machine has no
 * WebGL" when in fact mesa's llvmpipe is installed and works.
 */
function displayWorks() {
  try {
    execFileSync('xdpyinfo', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

function has(cmd) {
  try { execFileSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'pipe' }); return true; }
  catch { return false; }
}

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
async function inBrowser(driver, {
  fitPath, livery: liveryName = 'neon-grid-any', car = 'abarth500',
  profile: profileOverride = null, liveryObject = null, modelPath = null,
}) {
  const profile = profileOverride
    ?? await loadProfile(new URL(`../cars/${car}.json`, import.meta.url));
  const livery = liveryObject ?? (await import(`../liveries/${liveryName}.mjs`)).default;
  const real = await startUi({ livery, profile, fitPath, modelPath, port: 0, log: () => {} });
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

  // --- getting a browser that actually has WebGL ---------------------------
  //
  // This took three rounds of "the tests pass but exercise nothing", so it is
  // worth writing down. Firefox reported "Exhausted GL driver options" and the
  // GL-dependent tests quietly took their own no-GL branch. Mesa was installed
  // and working the whole time — `EGL_PLATFORM=surfaceless eglinfo` reported
  // llvmpipe. Three separate things were in the way:
  //
  //   * DISPLAY was set to a compositor's X server this process cannot
  //     authorise against. Set, named, and unusable — so Firefox fell back to
  //     no GL rather than reporting a display problem. Xvfb gives a private one.
  //   * webgl.out-of-process defaults on, and the GPU process cannot start in a
  //     sandbox. WebGL then fails in the child, which the parent reports as no
  //     WebGL at all.
  //   * the prefs have to arrive in a PROFILE. `--setpref` did not take.
  //
  // Together with MOZ_X11_EGL and LIBGL_ALWAYS_SOFTWARE this gives a complete
  // software GL stack, and the renderer tests stop being decorative.
  const useXvfb = !displayWorks() && has('xvfb-run');
  const profileDir = await mkdtemp(join(tmpdir(), 'lk-ff-'));
  await writeFile(join(profileDir, 'user.js'), [
    'user_pref("webgl.force-enabled", true);',
    'user_pref("webgl.disabled", false);',
    'user_pref("webgl.forbid-software", false);',
    // The one that actually mattered: no GPU process in a sandbox.
    'user_pref("webgl.out-of-process", false);',
    'user_pref("layers.acceleration.disabled", true);',
    'user_pref("gfx.webrender.software", true);',
    'user_pref("gfx.x11-egl.force-enabled", true);',
  ].join('\n'));

  const args = BROWSER === 'firefox'
    ? ['--headless', '--window-size=1400,900', '--profile', profileDir, url]
    : ['--headless=new', '--disable-gpu', '--window-size=1400,900', url];

  const child = spawn(
    useXvfb ? 'xvfb-run' : BROWSER,
    useXvfb ? ['-a', '-s', '-screen 0 1400x900x24', BROWSER, ...args] : args,
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        MOZ_X11_EGL: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        MOZ_WEBRENDER: '0',
        MOZ_ACCELERATED: '0',
      },
    },
  );

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
// The editor opens on the CAR now, so a test about the UV sheet has to ask for
// it — the same as a person would. Without this the overlay is hidden and every
// hit test lands on the canvas covering it.
const uvTab = async () => {
  document.querySelector('#tab-uv').click();
  await settle(500);
};
`;

test('a real pointer can select a region from the list', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The list is the first thing anyone touches. This checks not merely that the
  // handler works, but that nothing is sitting on top of the list intercepting
  // the pointer — the failure that made this editor look dead three times.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      await uvTab();
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
      await uvTab();
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

test('the selected region reaches the car as a highlight', { skip: BROWSER ? false : 'no browser' }, async (t) => {
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
  t.diagnostic(`WebGL ${find('webgl: ').slice('webgl: '.length) || 'unknown'}`);
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

test('the whole-car view puts every painted surface on the model at once', { skip: BROWSER ? false : 'no browser' }, async (t) => {
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

      document.querySelector('#tab-all').click();
      await settle(4000);
      say('note: ' + document.querySelector('#viewnote').textContent);
      say('canvas hidden: ' + document.querySelector('#carview').hidden);

      const stage = document.querySelector('#stage').getBoundingClientRect();
      const mid = [Math.round(stage.x + stage.width / 2), Math.round(stage.y + stage.height / 2)];
      say('topmost over stage: ' + (topAt(mid[0], mid[1])?.id ?? 'nothing'));

      // Asked AFTER the tab has opened, on the real canvas. A detached probe
      // canvas reports no WebGL even when the page has it — which quietly sent
      // this test down its own skip branch and made it green for nothing.
      const gl = document.querySelector('#carview').getContext('webgl');
      say('webgl: ' + (gl ? 'present' : 'absent'));
      if (gl) {
        const prog = gl.getParameter(gl.CURRENT_PROGRAM);
        const region = prog ? gl.getUniform(prog, gl.getUniformLocation(prog, 'region')) : [];
        say('region: ' + Array.from(region).join(','));
      }
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath: join(dir, 'fit.json') });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  t.diagnostic(`WebGL ${find('webgl: ').slice('webgl: '.length) || 'unknown'}`);

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

test('a region can be dragged on the car itself', { skip: BROWSER ? false : 'no browser' }, async (t) => {
  // The gesture Misha asked for: adjust placement on the model instead of
  // guessing on the sheet and switching tabs to check. This drives it the way a
  // hand does — pointerdown on the car, move, up — and then reads the fit that
  // was written to disk, so nothing between the pointer and the file is assumed.
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'lk-drag3d-'));
  const modelPath = join(dir, 'car.kn5');
  const fitPath = join(dir, 'fit.json');
  await writeFile(modelPath, carKn5());
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });

  const livery = {
    name: 'fixture', car: 'fixture_car',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        role: 'body',
        // right_mid is the -x face, which is the one the default camera looks
        // at: yaw -0.9 puts the eye at negative x and positive z. Painting the
        // far side of the car and then hunting for it on screen would be a test
        // of the orbit controls.
        regions: [{
          id: 'mark', panel: 'right_mid', at: [0.15, 0.15, 0.7, 0.7],
          treatment: 'fill', color: 'accent',
        }],
      },
    },
  };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      const li = [...document.querySelectorAll('#regions li')].find((l) => l.dataset.id === 'mark');
      clickAt(...centre(li));
      await settle(400);

      document.querySelector('#tab-3d').click();
      await settle(2500);
      say('note: ' + document.querySelector('#viewnote').textContent.slice(0, 40));

      const cv = document.querySelector('#carview');
      // On the real canvas, after the tab opened it: a detached probe canvas
      // says "no WebGL" on a page that plainly has it.
      say('webgl: ' + (cv.getContext('webgl') ? 'present' : 'absent'));
      const r = cv.getBoundingClientRect();
      say('canvas: ' + Math.round(r.width) + 'x' + Math.round(r.height));

      const send = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0,
      }));
      // pointermove/up go to the window, which is where the drag listens.
      const sendWin = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0,
      }));

      // Hunt for a pixel where the REGION is, not merely where the canvas is.
      // Which way the car faces and where its artwork sits depend on the
      // camera's framing, so the honest way to find the region is to press and
      // see whether a drag began. A press that lands on bare bodywork orbits
      // instead, which is harmless and undone by releasing.
      let from = null;
      for (let fy = 0.25; fy <= 0.75 && !from; fy += 0.08) {
        for (let fx = 0.2; fx <= 0.8 && !from; fx += 0.06) {
          const x = Math.round(r.x + r.width * fx);
          const y = Math.round(r.y + r.height * fy);
          if (topAt(x, y) !== cv) continue;
          send('pointerdown', x, y);
          await settle(60);
          if (/moving|resizing/.test(document.querySelector('#status').textContent)) from = [x, y];
          else { sendWin('pointerup', x, y); await settle(30); }
        }
      }
      if (!from) { say('never found the region on screen'); return done(); }
      say('grab at: ' + from.join(','));
      await settle(120);
      for (let i = 1; i <= 5; i++) sendWin('pointermove', from[0] + i * 8, from[1] + i * 5);
      await settle(200);
      sendWin('pointerup', from[0] + 40, from[1] + 25);
      await settle(1200);

      say('status: ' + document.querySelector('#status').textContent);
      say('fit: ' + document.querySelector('#fitjson').textContent.replace(/\\s+/g, ' '));
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath });

  // Said out loud, because a test that quietly takes the no-GL branch is green
  // for the wrong reason and nobody would know.
  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  t.diagnostic(`WebGL ${find('webgl: ').slice('webgl: '.length) || 'unknown'}`);
  if (find('webgl: ') === 'webgl: absent') {
    // No GL driver in this browser. Everything up to the pick was still run,
    // and the editor must not have died on the way.
    assert.match(find('note: '), /no 3D view/, report.join(' | '));
    return;
  }

  const raw = find('fit: ').slice('fit: '.length);
  assert.ok(raw, `the drag never got as far as reporting a fit: ${report.join(' | ')}`);
  const fit = JSON.parse(raw);
  const at = fit.regions?.mark?.at;
  assert.ok(Array.isArray(at), `the drag never reached the fit: ${report.join(' | ')}`);
  assert.ok(at.every((n) => Number.isFinite(n)), `at must stay numeric, got ${at}`);
  assert.notDeepEqual(at, [0.3, 0.3, 0.3, 0.3], 'the region should have moved');
  // Panel-relative and in range, which is the invariant the whole fit format
  // rests on — a value outside 0..1 is one the renderer refuses.
  assert.ok(at.every((n) => n >= 0 && n <= 1), `at must stay panel-relative: ${at}`);
});

test('the editor opens on the car, and a linked drag moves both sides', { skip: BROWSER ? false : 'no browser' }, async (t) => {
  // Two claims at once, because they share a page load and the second needs the
  // first: the Car tab is where the work happens now, so it is what opens, and a
  // design that named `mark-left` and `mark-right` has said they are one idea.
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'lk-pair-'));
  const modelPath = join(dir, 'car.kn5');
  const fitPath = join(dir, 'fit.json');
  await writeFile(modelPath, carKn5());
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });

  // right_mid is the -x face the default camera looks at; left_mid is its
  // measured mirror, so the pair is exactly the case this feature is for.
  const livery = {
    name: 'fixture', car: 'fixture_car',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        role: 'body',
        regions: [
          { id: 'mark-right', panel: 'right_mid', at: [0.15, 0.15, 0.7, 0.7], treatment: 'fill', color: 'accent' },
          { id: 'mark-left', panel: 'left_mid', at: [0.15, 0.15, 0.7, 0.7], treatment: 'fill', color: 'accent' },
        ],
      },
    },
  };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      await settle(2500);
      // Whatever the app chose on its own — no tab was clicked.
      say('opening tab: ' + [...document.querySelectorAll('.tab')].find((b) => b.className.includes('on'))?.id);
      say('canvas hidden: ' + document.querySelector('#carview').hidden);

      const cv = document.querySelector('#carview');
      say('webgl: ' + (cv.getContext('webgl') ? 'present' : 'absent'));
      const r = cv.getBoundingClientRect();

      const li = [...document.querySelectorAll('#regions li')].find((l) => l.dataset.id === 'mark-right');
      clickAt(...centre(li));
      await settle(400);
      say('inspector mentions the pair: ' + document.querySelector('#inspector').textContent.includes('mark-left'));

      const send = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
      const sendWin = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));

      let from = null;
      for (let fy = 0.25; fy <= 0.75 && !from; fy += 0.08) {
        for (let fx = 0.2; fx <= 0.8 && !from; fx += 0.06) {
          const x = Math.round(r.x + r.width * fx), y = Math.round(r.y + r.height * fy);
          if (topAt(x, y) !== cv) continue;
          send('pointerdown', x, y);
          await settle(50);
          if (/moving|resizing/.test(document.querySelector('#status').textContent)) from = [x, y];
          else { sendWin('pointerup', x, y); await settle(20); }
        }
      }
      if (!from) { say('never found the region on screen'); return done(); }

      for (let i = 1; i <= 5; i++) sendWin('pointermove', from[0] + i * 6, from[1] + i * 4);
      await settle(200);
      sendWin('pointerup', from[0] + 30, from[1] + 20);
      await settle(1200);
      say('fit: ' + document.querySelector('#fitjson').textContent.replace(/\\s+/g, ' '));
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  t.diagnostic(`WebGL ${find('webgl: ').slice('webgl: '.length) || 'unknown'}`);

  // The tab choice does not depend on GL: without it the app falls back, which
  // is its own correct answer and worth asserting either way.
  if (find('webgl: ') === 'webgl: present') {
    assert.equal(find('opening tab: '), 'opening tab: tab-3d', report.join(' | '));
    assert.equal(find('canvas hidden: '), 'canvas hidden: false');
  } else {
    assert.equal(find('opening tab: '), 'opening tab: tab-uv',
      'with no WebGL it must fall back to a view that works');
    return;
  }

  assert.equal(find('inspector mentions the pair: '), 'inspector mentions the pair: true',
    'the inspector should name the opposite number');

  const raw = find('fit: ').slice('fit: '.length);
  assert.ok(raw, `the drag never reported a fit: ${report.join(' | ')}`);
  const regions = JSON.parse(raw).regions ?? {};
  assert.ok(regions['mark-right']?.at, `the drag never reached the fit: ${raw}`);
  assert.ok(regions['mark-left']?.at, `the opposite number was not moved: ${raw}`);
  // MIRRORED, not copied. Whether that means the same numbers depends on how
  // the two islands were unwrapped, so the expectation is computed from the
  // profile's own measured axes rather than written down here — writing it down
  // would just be asserting the fixture's unwrap, not the behaviour.
  const { mirrorFlips, mirrorAt } = await import('../src/fit.mjs');
  const panels = profile.panels.body;
  const flips = mirrorFlips(panels[regions['mark-right'].panel ?? 'right_mid'],
    panels[regions['mark-left'].panel ?? 'left_mid']);
  assert.deepEqual(regions['mark-left'].at, mirrorAt(regions['mark-right'].at, flips),
    `a linked pair mirrors: flips ${JSON.stringify(flips)}`);
  // And each half stays on its OWN panel. Copying the panel across would stack
  // both halves on one flank, which renders perfectly and looks like the mirror
  // simply stopped working.
  //
  // A fit records `panel` only when a region has LEFT the one its design named,
  // so the usual outcome here is that neither carries one — the sides are kept
  // apart by the design and there is nothing to write down. What must never
  // happen is both halves naming the same panel.
  const named = [regions['mark-left'].panel, regions['mark-right'].panel].filter(Boolean);
  assert.notEqual(named[0] !== undefined && named[0] === named[1], true,
    `both halves ended up on ${named[0]}, which is the mirror collapsing`);
});

test('the artwork follows the pointer, without waiting for the release', { skip: BROWSER ? false : 'no browser' }, async (t) => {
  // The claim is specifically about what happens BEFORE mouseup. Watching a
  // rectangle move and finding out on release whether the number actually fits
  // is the guessing the car view exists to remove, so the test holds the button
  // down and reads the fit while the gesture is still in progress.
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'lk-live-'));
  const modelPath = join(dir, 'car.kn5');
  await writeFile(modelPath, carKn5());
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });

  const livery = {
    name: 'fixture', car: 'fixture_car',
    palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: {
      body: {
        role: 'body',
        regions: [{ id: 'mark', panel: 'right_mid', at: [0.15, 0.15, 0.6, 0.6], treatment: 'fill', color: 'accent' }],
      },
    },
  };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
      await settle(2500);
      const cv = document.querySelector('#carview');
      say('webgl: ' + (cv.getContext('webgl') ? 'present' : 'absent'));
      const r = cv.getBoundingClientRect();

      const li = [...document.querySelectorAll('#regions li')].find((l) => l.dataset.id === 'mark');
      clickAt(...centre(li));
      await settle(400);
      const at = () => JSON.parse(document.querySelector('#fitjson').textContent).regions?.mark?.at;
      say('before: ' + JSON.stringify(at() ?? null));

      const send = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
      const sendWin = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));

      let from = null;
      for (let fy = 0.25; fy <= 0.75 && !from; fy += 0.08) {
        for (let fx = 0.2; fx <= 0.8 && !from; fx += 0.06) {
          const x = Math.round(r.x + r.width * fx), y = Math.round(r.y + r.height * fy);
          if (topAt(x, y) !== cv) continue;
          send('pointerdown', x, y);
          await settle(50);
          if (/moving|resizing/.test(document.querySelector('#status').textContent)) from = [x, y];
          else { sendWin('pointerup', x, y); await settle(20); }
        }
      }
      if (!from) { say('never found the region on screen'); return done(); }

      // Move, and read WITHOUT releasing.
      for (let i = 1; i <= 5; i++) sendWin('pointermove', from[0] + i * 6, from[1] + i * 4);
      await settle(600);
      say('mid-drag: ' + JSON.stringify(at() ?? null));
      say('button still down: ' + /moving|resizing/.test(document.querySelector('#status').textContent));

      sendWin('pointerup', from[0] + 30, from[1] + 20);
      await settle(900);
      say('after: ' + JSON.stringify(at() ?? null));
      done();
    })();
  `, { liveryObject: livery, profile, modelPath, fitPath: join(dir, 'fit.json') });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  t.diagnostic(`WebGL ${find('webgl: ').slice('webgl: '.length) || 'unknown'}`);
  if (find('webgl: ') !== 'webgl: present') return;

  const val = (p) => JSON.parse(find(p).slice(p.length));
  const before = val('before: ');
  const mid = val('mid-drag: ');
  assert.ok(Array.isArray(mid), `no placement mid-drag: ${report.join(' | ')}`);
  assert.equal(find('button still down: '), 'button still down: true',
    'the gesture must not have ended before the reading was taken');
  assert.notDeepEqual(mid, before,
    'the fit should already reflect the drag while the button is still down');
  assert.ok(mid.every((n) => n >= 0 && n <= 1), `at must stay panel-relative mid-drag: ${mid}`);
});
