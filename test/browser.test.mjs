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
import { accessSync, statSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { loadProfile } from '../src/profile.mjs';
import '../src/index.mjs';

/**
 * Is this executable on PATH?
 *
 * PATH is walked directly rather than asked of a shell, because these probes
 * decide whether the suite runs or silently skips. `command -v` needs a shell to
 * run in, and the obvious one to name is bash — which a minimal container may
 * well not have, so every probe throws, every browser looks absent, and the
 * tests that exist to catch "the editor looks fine and is unusable" quietly stop
 * running. A skip that is wrong is worse than a failure: nothing reports it.
 */
function onPath(name) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  // On Windows the executable is firefox.exe; elsewhere the name is the name.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const p = join(dir, name + ext);
        // A DIRECTORY passes X_OK — that is what the execute bit means on a
        // directory — so the access check alone will happily report a folder
        // called `chromium` as a browser. spawn then fails with EACCES and the
        // suite reports that the browser would not start, which is a maddening
        // thing to debug from a CI log. statSync follows symlinks, so
        // /usr/bin/firefox -> ../lib/firefox/firefox still resolves.
        if (!statSync(p).isFile()) continue;
        accessSync(p, constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

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

function findBrowser() {
  return ['firefox', 'chromium', 'chromium-browser', 'google-chrome'].find(onPath) ?? null;
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
  // Every request the proxy is part-way through, so teardown can wait for them.
  // A forward that rejects after the test has ended is reported by Node as
  // "asynchronous activity after the test ended" and pinned on whichever test
  // was running, which is why this looked like three different flaky tests.
  const inFlight = new Set();
  const proxy = createServer(async (req, res) => {
    const finished = new Promise((done) => res.on('close', done));
    inFlight.add(finished);
    finished.then(() => inFlight.delete(finished));
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
    // Tolerated, not thrown. Once the real server is closing, a forward in
    // flight fails — and that is teardown happening, not the page misbehaving.
    let upstream;
    try {
      upstream = await fetch(`http://127.0.0.1:${realPort}${req.url}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: body.length ? Buffer.concat(body) : undefined,
      });
    } catch {
      if (!res.writableEnded) res.writeHead(503).end('closing');
      return;
    }
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
  const hasDisplay = displayWorks();
  const useXvfb = !hasDisplay && onPath('xvfb-run');
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

    // --- and nothing off this machine -------------------------------------
    //
    // These tests talk to 127.0.0.1 and nowhere else, but a stock Firefox on a
    // COLD PROFILE does not know that. On every launch it resolves and calls
    // out to safebrowsing lists, telemetry, remote settings, the addon
    // blocklist, update servers, the captive-portal probe and the DoH canary —
    // and this harness starts a fresh profile per test, several tests per run,
    // and SIGKILLs the browser so nothing is ever cached or cleanly closed.
    //
    // Measured with strace: 114 DNS lookups PER LAUNCH before these prefs, 6
    // after. At several launches per run and many runs an afternoon, that is
    // enough to trip a filtering resolver's rate limit and get the whole
    // machine blocked — which is exactly what it did. None of it was buying
    // anything: a test of a local editor has no business making a single
    // external request.
    'user_pref("network.dns.disablePrefetch", true);',
    'user_pref("network.prefetch-next", false);',
    'user_pref("network.predictor.enabled", false);',
    'user_pref("network.captive-portal-service.enabled", false);',
    'user_pref("network.connectivity-service.enabled", false);',
    // 5 = DoH off and the canary lookup skipped with it.
    'user_pref("network.trr.mode", 5);',
    'user_pref("browser.safebrowsing.malware.enabled", false);',
    'user_pref("browser.safebrowsing.phishing.enabled", false);',
    'user_pref("browser.safebrowsing.downloads.enabled", false);',
    'user_pref("browser.safebrowsing.provider.google4.updateURL", "");',
    'user_pref("browser.safebrowsing.provider.mozilla.updateURL", "");',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("toolkit.telemetry.unified", false);',
    'user_pref("toolkit.telemetry.server", "");',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("extensions.blocklist.enabled", false);',
    'user_pref("extensions.systemAddon.update.enabled", false);',
    'user_pref("services.settings.server", "");',
    'user_pref("browser.region.network.url", "");',
    'user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);',
    'user_pref("browser.discovery.enabled", false);',
    'user_pref("browser.ping-centre.telemetry", false);',
    'user_pref("dom.push.connection.enabled", false);',
    'user_pref("network.http.speculative-parallel-limit", 0);',
    // The backstop: everything except loopback goes through a proxy that is not
    // there. A request that slips past the prefs above fails immediately and
    // locally instead of becoming a DNS lookup.
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    'user_pref("network.proxy.http_port", 1);',
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    'user_pref("network.proxy.ssl_port", 1);',
    'user_pref("network.proxy.allow_hijacking_localhost", false);',
    'user_pref("network.proxy.no_proxies_on", "127.0.0.1,localhost");',
  ].join('\n'));

  // The isolation above is written into a Firefox PROFILE, so it applies to
  // Firefox and to nothing else. A Chromium here would have taken none of it and
  // the suite would still have claimed to be offline, so it gets the equivalent
  // switches rather than an assurance that does not cover it: no first-run
  // network calls, no variations fetch, and a proxy pointing nowhere with
  // loopback exempted.
  const args = BROWSER === 'firefox'
    ? ['--headless', '--window-size=1400,900', '--profile', profileDir, url]
    : [
      '--headless=new', '--disable-gpu', '--window-size=1400,900',
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-domain-reliability', '--disable-sync',
      '--metrics-recording-only', '--disable-client-side-phishing-detection',
      '--variations-server-url=', '--disable-features=OptimizationHints',
      '--proxy-server=http://127.0.0.1:1',
      '--proxy-bypass-list=127.0.0.1;localhost',
      url,
    ];
  // Force the software rasteriser. A headless box has no GPU, and Firefox
  // otherwise reports "Exhausted GL driver options" on some runs and works on
  // others — which made the GL-dependent tests pass by taking their own skip
  // branch, green for no reason at all.
  //
  // MOZ_X11_EGL only where there is an X server to talk to. Exported without
  // one it asks for an X11 EGL path that cannot exist, so on a box with no X at
  // all the settings meant to GIVE these tests a GL stack become the reason the
  // browser never starts — and the failure arrives as silence.
  const child = await launch(
    useXvfb ? 'xvfb-run' : BROWSER,
    useXvfb ? ['-a', '-s', '-screen 0 1400x900x24', BROWSER, ...args] : args,
    {
      LIBGL_ALWAYS_SOFTWARE: '1',
      MOZ_WEBRENDER: '0',
      MOZ_ACCELERATED: '0',
      ...(hasDisplay || useXvfb ? { MOZ_X11_EGL: '1' } : {}),
    },
  );

  // Longer than a dev box needs, because a CI runner is not a dev box: a cold
  // browser start on two shared cores is several times slower than here, and a
  // timeout that only fails on the slow machine is the worst kind. Overridable
  // for anyone whose box is slower still.
  // 40s, down from 90. The page carries a 25s watchdog that reports whatever
  // it managed, so anything still silent at 40 is a browser that never ran the
  // script at all — and waiting another fifty seconds to learn that costs a
  // minute per run and tells you nothing extra.
  const limit = Number(process.env.LIVERYKIT_BROWSER_TIMEOUT_MS) || 40000;
  const deadline = Date.now() + limit;
  // `child.done` too, so a browser that exits without loading the page fails in
  // a second with its own error message rather than after the full timeout with
  // none.
  while (!report && !child.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const waited = Date.now() - (deadline - limit);
  // ORDER AND AWAIT. The browser goes first so nothing new arrives, then the
  // forwards already running are allowed to finish, then both servers are
  // closed and WAITED for. Firing all three and returning left rejected fetches
  // landing after the test had ended.
  child.kill();
  await Promise.allSettled([...inFlight]);
  await new Promise((ok) => proxy.close(ok));
  if (typeof real.server.closeAllConnections === 'function') real.server.closeAllConnections();
  await new Promise((ok) => real.server.close(ok));

  assert.ok(report, 'the browser never reported back. ' + child.why(waited));
  const failures = report.filter((l) => /^(ERROR|REJECT|THREW)/.test(l));
  assert.deepEqual(failures, [], `the page reported errors: ${failures.join(' | ')}`);
  return report;
}

/**
 * Did this run get a GL stack, and is it allowed not to have?
 *
 * A headless box with no GL is a fact about the box rather than a failure of the
 * code, so locally these tests check what they can without it and stop. In CI it
 * IS a failure: arranging xvfb and a software rasteriser is the whole point, and
 * "absent" there means the arrangement broke and every renderer test went green
 * without touching a shader. Exactly the silence LIVERYKIT_REQUIRE_BROWSER
 * exists to break.
 */
function withoutGl(report) {
  if (!report.includes('webgl: absent')) return false;
  assert.ok(!REQUIRED,
    'WebGL was absent and LIVERYKIT_REQUIRE_BROWSER is set, so these tests would '
    + `have passed without exercising the renderer at all: ${report.join(' | ')}`);
  return true;
}

/** Shared preamble: wait for the app, then interact by hit-testing. */
const PRELUDE = `
const out = []; const say = (m) => out.push(String(m));
addEventListener('error', (e) => say('ERROR ' + e.message));
addEventListener('unhandledrejection', (e) => say('REJECT ' + (e.reason?.stack || e.reason)));
let reported = false;
let watchdog = 0;
const done = () => {
  if (reported) return;                 // a watchdog and a real finish can race
  reported = true;
  // CANCEL THE WATCHDOG. Left running it fires long after the page has
  // reported and the harness has torn its server down, and the late POST
  // becomes async activity after the test ended — which Node 22 fails the
  // whole file for, while Node 24 quietly tolerates it.
  clearTimeout(watchdog);
  // NOTHING IS RETURNED and nothing may reject.
  //
  // This used to hand back the fetch promise. Callers write return done()
  // inside an async IIFE, so a failed post — the harness closing the socket the
  // moment it has the report, most often — became an unhandled rejection, which
  // the listener above dutifully recorded as an error and failed the test on.
  // The report had already arrived; the test failed for having delivered it.
  //
  // NO BACKTICKS in here: this whole block lives inside a template literal, and
  // a stray one ends it. That has broken this file four times.
  fetch('/report', { method: 'POST', body: JSON.stringify(out) }).catch(() => {});
};
// A REPORT ALWAYS COMES BACK.
//
// A test that hangs costs ninety seconds and tells you nothing; the same test
// failing at twenty-five tells you what it managed first. CI has no GPU and its
// compositor sometimes never maps a framebuffer, so a page can sit in a state
// where nothing throws and nothing finishes — and every path to done() runs
// after the thing that stalled.
//
// This one does not. Whatever the page got to is what comes back.
watchdog = watchdog = setTimeout(() => { say('WATCHDOG fired — the page never finished'); done(); }, 25000);
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
  if (withoutGl(report)) {
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

      // What the whole-car view actually ASKS FOR. Two bugs lived here: the
      // preview was requested with the fit alone, so the server answered about
      // the livery on disk and every unsaved edit was invisible; and the group
      // roles were taken from the cached geometry, which is only as fresh as the
      // fetch. Both are in the wiring, which is why neither showed up in a test
      // of either piece on its own.
      const sentDesign = [];
      const realFetch = window.fetch;
      window.fetch = async (u, i) => {
        if (String(u).includes('/api/preview') && i?.body) {
          sentDesign.push(!!JSON.parse(i.body).design);
        }
        return realFetch(u, i);
      };

      document.querySelector('#tab-all').click();
      await settle(4000);
      window.fetch = realFetch;
      say('preview asked with a design: ' + (sentDesign.length ? sentDesign.every(Boolean) : 'never asked'));
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

  if (withoutGl(report)) {
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
  // The working design has to travel with the request, or this view shows the
  // file on disk and an unsaved surface can never appear on it.
  assert.equal(find('preview asked with a design: '), 'preview asked with a design: true',
    `the whole-car preview must be of what is being edited: ${report.join(' | ')}`);
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
  if (withoutGl(report)) {
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

test('a hostile palette value paints a swatch and nothing else', { skip: BROWSER ? false : 'no browser' }, async () => {
  // A livery is a file people share, and its palette values used to be pasted
  // into a `style` attribute. `esc` escapes HTML; a style attribute is not HTML
  // but a list of declarations, so `red;position:fixed;inset:0` went through it
  // untouched and became a page-sized invisible sheet over the editor. This
  // project has already had that exact bug once — from a duplicate id — and the
  // fake DOM could not see it either time, because it renders no CSS.
  //
  // So: a real browser, real layout, and the question a person would ask, which
  // is whether anything is lying on top of the editor.
  const base = (await import('../liveries/neon-grid-any.mjs')).default;
  const livery = structuredClone({ ...base });
  livery.palette = { ...livery.palette, trap: 'red;position:fixed;inset:0;z-index:9999' };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('the editor never came up'); return done(); }
      await settle(400);
      const swatch = (n) => document.querySelector('[data-swatch="' + n + '"]');
      say('real swatch: ' + getComputedStyle(swatch('ink')).backgroundColor);
      say('trap swatch: ' + getComputedStyle(swatch('trap')).backgroundColor);
      say('trap position: ' + getComputedStyle(swatch('trap')).position);

      // The measurement that matters: how big is it. An inset:0 sheet is the
      // size of the viewport; a swatch is the size of a swatch.
      const box = swatch('trap').getBoundingClientRect();
      say('trap size: ' + Math.round(box.width) + 'x' + Math.round(box.height));
      say('viewport: ' + innerWidth + 'x' + innerHeight);

      // And nothing from the palette is what a click in the middle of the
      // editor lands on. The overlay legitimately covers the texture, so the
      // question is not "what is on top" but "is a SWATCH on top".
      const tex = document.querySelector('#texture');
      const r = tex.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      say('hit is a swatch: ' + !!hit?.closest?.('[data-swatch]'));
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname, liveryObject: livery });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.match(find('real swatch: '), /rgb\(18, 32, 58\)|rgb\(\d+, \d+, \d+\)/,
    `an ordinary palette colour must still show: ${report.join(' | ')}`);
  assert.equal(find('trap swatch: '), 'trap swatch: rgba(0, 0, 0, 0)',
    'the CSSOM parses one colour or none, so a value carrying declarations paints nothing');
  assert.equal(find('trap position: '), 'trap position: static',
    'and above all does not position itself');
  assert.equal(find('hit is a swatch: '), 'hit is a swatch: false',
    'nothing from the palette was laid over the editor');
  const [w, h] = find('trap size: ').slice('trap size: '.length).split('x').map(Number);
  const [vw, vh] = find('viewport: ').slice('viewport: '.length).split('x').map(Number);
  assert.ok(w < vw / 4 && h < vh / 4,
    `the swatch is ${w}x${h} in a ${vw}x${vh} viewport, which is a sheet over the page, not a swatch`);
});

test('an emissive-only treatment actually puts pixels on screen', { skip: BROWSER ? false : 'no browser' }, async () => {
  // `traces` draws nothing into the base layer, and the editor used to show the
  // base alone — so the element was painted correctly by the build and invisible
  // in the tool for looking at it. The fix flattens both layers for display,
  // which relies on `feGaussianBlur` and `mix-blend-mode`: things librsvg does
  // not have and a fake DOM cannot tell you about. Hence a real browser, and
  // hence reading PIXELS rather than markup — the markup was never the question.
  const profile = {
    id: 'fixture', name: 'Fixture',
    textures: { body: { file: 'b.dds', width: 256, height: 256 } },
    bind: { body: { roles: ['body'], source: 'human' } },
    panels: { body: { L: { rect: [0, 0, 1, 1], tags: ['left'], anisotropy: 1 } } },
  };
  const liveryObject = {
    name: 'Traces', folder: 'traces', car: 'fixture', packs: ['core', 'synthwave'],
    palette: { ink: '#000000', wire: '#00FF00' },
    surfaces: {
      body: {
        background: 'ink',
        regions: [{ id: 'wires', panel: 'L', at: [0, 0, 1, 1], treatment: 'traces', color: 'wire', lanes: 6 }],
      },
    },
  };

  const dir = await mkdtemp(join(tmpdir(), 'lk-emis-'));
  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('THREW no regions'); return done(); }
      await uvTab();
      const svg = document.querySelector('#texture svg');
      if (!svg) { say('THREW no svg in the texture layer'); return done(); }

      // Rasterise what the editor is actually displaying, and look at it.
      const markup = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      const done2 = new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('svg would not load')); });
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      await done2;

      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 256, 256);
      const px = g.getImageData(0, 0, 256, 256).data;

      let lit = 0, greenest = 0;
      for (let i = 0; i < px.length; i += 4) {
        // The background is pure black, so anything with green in it came from
        // the emissive layer — either the crisp strokes or the glow around them.
        if (px[i + 1] > 24) lit++;
        if (px[i + 1] > greenest) greenest = px[i + 1];
      }
      say('lit: ' + lit);
      say('greenest: ' + greenest);
      done();
    })();
  `, { liveryObject, profile, fitPath: join(dir, 'fit.json') });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  const lit = Number(find('lit: ').slice(5));
  const greenest = Number(find('greenest: ').slice(10));

  assert.ok(lit > 200, `the traces should cover a meaningful area, got ${lit} lit pixels: ${report.join(' | ')}`);
  assert.ok(greenest > 200, `and reach near full strength where the strokes are, got ${greenest}`);
});

test('the browser resolves colord through the import map, not a copy', { skip: BROWSER ? false : 'no browser' }, async () => {
  // `uses.js` writes `import { colord } from 'colord'`, which Node resolves from
  // node_modules and the browser resolves through the import map in index.html
  // to a file the server hands over from that same package. There is no bundler
  // and no vendored copy, so the two sides genuinely run the identical code —
  // but only if the map is right, the server serves it, and this Firefox
  // supports import maps at all. None of which Node can tell me.
  //
  // The editor booting is itself most of the assertion: a bare specifier that
  // fails to resolve is a module that never evaluates, so `app.js` never runs
  // and the region list stays empty.
  const base = (await import('../liveries/neon-grid-any.mjs')).default;
  const livery = structuredClone({ ...base });
  livery.palette = { ...livery.palette, plausible: 'rebeccapurple', broken: 'rebecapurple' };
  livery.surfaces.body.regions = [
    { id: 'a', panel: 'left_mid', at: [0.1, 0.1, 0.2, 0.2], treatment: 'fill', color: 'red' },
    { id: 'b', panel: 'left_mid', at: [0.4, 0.1, 0.2, 0.2], treatment: 'fill', color: 'rebecapurple' },
  ];

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('the editor never came up — colord probably did not resolve'); return done(); }
      await settle(600);
      const { isAColour } = await import('/uses.js');
      say('red: ' + isAColour('red'));
      say('typo: ' + isAColour('rebecapurple'));
      const dangling = document.querySelector('#dangling').innerHTML;
      say('warned about the typo: ' + /rebecapurple/.test(dangling));
      say('warned about red: ' + /<code>red<\\/code>/.test(dangling));
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname, liveryObject: livery });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.equal(find('red: '), 'red: true', `colord did not resolve in the browser: ${report.join(' | ')}`);
  assert.equal(find('typo: '), 'typo: false');
  assert.equal(find('warned about the typo: '), 'warned about the typo: true',
    'a misspelt colour name is exactly what this panel is for');
  assert.equal(find('warned about red: '), 'warned about red: false',
    'and a real one is not worth mentioning');
});

test('a livery cannot run code in the editor', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The one that made this branch urgent. Treatments build markup by
  // interpolation, so a palette value that closes the attribute becomes
  // STRUCTURE — and the editor sets the finished document as `innerHTML`, where
  // an inserted <script> is inert but an event handler on an inserted element
  // is not. This exact payload reported PWNED before the fix.
  //
  // Worth doing in a browser rather than by reading markup: whether an injected
  // handler fires is a fact about a browser's parser, and the markup assertions
  // in test/injection.test.mjs are only as good as my idea of what is dangerous.
  const base = (await import('../liveries/neon-grid-any.mjs')).default;
  const livery = structuredClone({ ...base });
  livery.palette = { ...livery.palette,
    base: 'x"/><image href="data:image/gif;base64,BROKEN" onerror="window.__PWNED = 1"/><rect fill="black' };

  const report = await inBrowser(PRELUDE + `
    (async () => {
      if (!await ready()) { say('the editor never came up'); return done(); }
      await uvTab();
      await settle(1200);
      const tex = document.querySelector('#texture').innerHTML;
      say('ran: ' + (window.__PWNED ? 'YES' : 'no'));
      say('injected an element: ' + /<image/i.test(tex));
      // The value is still THERE, as the text of an attribute, which is the
      // point: escaping changed what it can do and not what it says.
      say('value survived: ' + /onerror/.test(tex));
      say('still drew the car: ' + (document.querySelectorAll('#texture path, #texture rect').length > 10));
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname, liveryObject: livery });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.equal(find('ran: '), 'ran: no', `the payload executed: ${report.join(' | ')}`);
  assert.equal(find('injected an element: '), 'injected an element: false');
  assert.equal(find('value survived: '), 'value survived: true',
    'the escaping should neuter the value, not silently eat it');
  assert.equal(find('still drew the car: '), 'still drew the car: true',
    'and the rest of the livery still renders');
});

test('unpainted parts of the car stay grey, and do not wear the body design', { skip: BROWSER ? false : 'no browser' }, async () => {
  // Reported from a real car: on a Honda NSX GT3 the windows came out filled
  // with sponsor artwork in the whole-car view. Glass is on its own texture,
  // which the design does not paint, so those meshes belong to the group with
  // no role — and that group fell back to `texture`, the handle the PER-SURFACE
  // view uploads the design you are editing into. It starts grey, so the code
  // read as correct; the editor opens on the car view, so by the time anybody
  // presses Whole car it has held the body design for some time.
  //
  // Driven against the VIEWER rather than the whole editor, because the bundled
  // fixture car has one texture and therefore no unpainted group at all — the
  // condition cannot arise on it. Importing the module and handing it two
  // groups is the smallest thing that reproduces a real car.
  //
  // Only a real GL context can answer this, and only by reading pixels: the
  // markup is identical either way and so is every uniform.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      const { createViewer } = await import('/view3d.js');
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      document.body.appendChild(canvas);

      let viewer;
      try { viewer = createViewer(canvas); } catch (e) { say('webgl: absent'); return done(); }
      // True colour: this test counts pixels by threshold, and shading moves
      // them. What is under test is which texture reaches which geometry.
      viewer?.setLit(false);
      if (!viewer) { say('webgl: absent'); return done(); }
      say('webgl: present');

      // Two quads facing the camera, side by side: the left one painted, the
      // right one on no role at all — which is the glass.
      const quad = (x0, x1) => [x0, -1, 0, x1, -1, 0, x1, 1, 0, x0, 1, 0];
      const model = {
        positions: new Float32Array([...quad(-1.2, -0.1), ...quad(0.1, 1.2)]),
        uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
        groups: [
          { role: 'body', start: 0, count: 6 },
          { role: null, start: 6, count: 6 },
        ],
        bounds: { lo: [-1.2, -1, 0], hi: [1.2, 1, 0] },
      };

      const magenta = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
        + '<rect width="64" height="64" fill="#FF00E5"/></svg>';

      // No /api/stock for this model, so the roleless group keeps the grey —
      // which is the fallback under test here. The next test supplies one.
      const noStock = window.fetch;
      window.fetch = async (u, i) => (String(u).startsWith('/api/stock')
        ? { ok: false, status: 404 } : noStock(u, i));

      // THE ORDER IS THE TEST. Uploading the surface first is what the editor
      // does — it opens on the car view — and it is what turned the shared grey
      // into the body design. Going straight to the whole-car view would find
      // it still grey and pass for the wrong reason.
      viewer.setGeometry(model);
      await viewer.setTexture(magenta, 64);
      await viewer.setWholeCar(model, [{ role: 'body', svg: magenta, width: 64, height: 64 }]);

      // preserveDrawingBuffer is false, so the pixels are gone by the next
      // composite. Orbiting by one pixel redraws synchronously inside the
      // pointermove handler, and this reads in that same task.
      const box = canvas.getBoundingClientRect();
      const at = (t, dx) => canvas.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: Math.round(box.x + box.width / 2) + dx,
        clientY: Math.round(box.y + box.height / 2),
      }));
      at('pointerdown', 0);
      at('pointermove', 1);
      const gl = canvas.getContext('webgl');
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      at('pointerup', 1);
      window.fetch = noStock;

      let painted = 0, grey = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 140 && b > 140 && g < 90) painted++;
        else if (Math.abs(r - 60) < 26 && Math.abs(g - 66) < 26 && Math.abs(b - 78) < 26) grey++;
      }
      say('painted: ' + painted);
      say('grey: ' + grey);
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  if (withoutGl(report)) return;

  const painted = Number(find('painted: ').slice('painted: '.length));
  const grey = Number(find('grey: ').slice('grey: '.length));

  // BOTH, and that is the whole test. Asserting only the grey would pass on a
  // viewer that drew nothing at all.
  assert.ok(painted > 500, `the painted group should be painted: ${report.join(' | ')}`);
  assert.ok(grey > 500,
    `the group with no role must stay grey, not wear the surface being edited: ${report.join(' | ')}`);
});

test('the car supplies its own artwork for the parts a design does not paint', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The whole-car view exists to answer "does this design work on this car",
  // and a livery floating on a grey mannequin does not answer it. The car's own
  // textures come out of the kn5 the editor already has open.
  //
  // Straight to the GPU with no decoding step: a DDS is a 128-byte header and
  // then S3TC blocks, which is exactly what compressedTexImage2D takes. This
  // builds one by hand so the expected colour is known exactly rather than read
  // off whatever a real car happens to ship.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      const { createViewer } = await import('/view3d.js');
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      document.body.appendChild(canvas);

      let viewer;
      try { viewer = createViewer(canvas); } catch { say('webgl: absent'); return done(); }
      // True colour: this test counts pixels by threshold, and shading moves
      // them. What is under test is which texture reaches which geometry.
      viewer?.setLit(false);
      if (!viewer) { say('webgl: absent'); return done(); }
      const s3tc = canvas.getContext('webgl').getExtension('WEBGL_compressed_texture_s3tc');
      say('webgl: ' + (s3tc ? 'present' : 'absent'));
      if (!s3tc) return done();

      // A 4x4 DXT1 block of solid green. Two RGB565 endpoints, both the same,
      // then four bytes of indices — every texel takes endpoint 0.
      const dds = new ArrayBuffer(128 + 8);
      const v = new DataView(dds);
      v.setUint32(0, 0x20534444, true);          // 'DDS '
      v.setUint32(12, 4, true);                  // height
      v.setUint32(16, 4, true);                  // width
      v.setUint32(80, 0x4, true);                // DDPF_FOURCC
      v.setUint32(84, 0x31545844, true);         // 'DXT1'
      const green = (0 << 11) | (63 << 5) | 0;   // RGB565 pure green
      v.setUint16(128, green, true);
      v.setUint16(130, green, true);
      v.setUint32(132, 0, true);                 // all texels -> endpoint 0

      const realFetch = window.fetch;
      window.fetch = async (u, i) => (String(u).startsWith('/api/stock')
        ? { ok: true, status: 200, arrayBuffer: async () => dds }
        : realFetch(u, i));

      const quad = (x0, x1) => [x0, -1, 0, x1, -1, 0, x1, 1, 0, x0, 1, 0];
      const model = {
        positions: new Float32Array([...quad(-1.2, -0.1), ...quad(0.1, 1.2)]),
        uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
        groups: [
          { role: 'body', file: 'body.dds', start: 0, count: 6 },
          // No role: the design does not paint it. But it has a FILE, so the
          // car can say what belongs there.
          { role: null, file: 'INTERNAL_glass.dds', start: 6, count: 6 },
        ],
        bounds: { lo: [-1.2, -1, 0], hi: [1.2, 1, 0] },
      };
      const magenta = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
        + '<rect width="64" height="64" fill="#FF00E5"/></svg>';

      viewer.setGeometry(model);
      await viewer.setTexture(magenta, 64);
      await viewer.setWholeCar(model, [{ role: 'body', svg: magenta, width: 64, height: 64 }]);
      window.fetch = realFetch;

      const box = canvas.getBoundingClientRect();
      const at = (t, dx) => canvas.dispatchEvent(new PointerEvent(t, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: Math.round(box.x + box.width / 2) + dx,
        clientY: Math.round(box.y + box.height / 2),
      }));
      at('pointerdown', 0);
      at('pointermove', 1);
      const gl = canvas.getContext('webgl');
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      at('pointerup', 1);

      // WHICH surface is under the pointer. The fake DOM tests hand the group
      // to claimCarPointer ready-made, so nothing there checks that picking
      // reports it — and in the whole-car view it is the only way to know: the
      // geometry is one buffer, and a UV coordinate means something different on
      // every texture in it.
      //
      // Scanned across the middle rather than aimed, because where a quad lands
      // on screen depends on the camera framing, and the question is whether the
      // two groups are told apart at all.
      const seen = new Set();
      for (let x = 4; x < canvas.width; x += 4) {
        const g = viewer.pickUV(box.x + x, box.y + box.height / 2)?.group;
        if (g) seen.add(String(g.file));
      }
      say('picked: ' + [...seen].sort().join(','));

      let painted = 0, stock = 0, grey = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 140 && b > 140 && g < 90) painted++;
        else if (g > 140 && r < 90 && b < 90) stock++;
        else if (Math.abs(r - 60) < 26 && Math.abs(g - 66) < 26 && Math.abs(b - 78) < 26) grey++;
      }
      say('painted: ' + painted);
      say('stock: ' + stock);
      say('grey: ' + grey);
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  if (withoutGl(report) || find('webgl: ') === 'webgl: absent') return;

  const n = (p) => Number(find(p).slice(p.length));
  assert.ok(n('painted: ') > 500, `the design should still be on its own surface: ${report.join(' | ')}`);
  assert.ok(n('stock: ') > 500,
    `the unpainted part should wear the car's own texture: ${report.join(' | ')}`);
  assert.equal(n('grey: '), 0,
    `nothing should be left grey when the car supplied a texture: ${report.join(' | ')}`);
  assert.equal(find('picked: '), 'picked: INTERNAL_glass.dds,body.dds',
    `picking must say which surface is under the pointer: ${report.join(' | ')}`);
});

test('the fitment panel measures the real car, in a real browser', { skip: BROWSER ? false : 'no browser' }, async () => {
  // The fake DOM has hidden four bugs in this project, and the fitment panel is
  // exactly the shape that fools it: a fetch, a sort, and innerHTML built from
  // the answer.
  //
  // The first version of this test hung for ninety seconds in CI and reported
  // nothing, which is a worse outcome than a plain failure. `topAt` is
  // `elementFromPoint`, which returns NULL for a point outside the viewport —
  // and #recheck lives at the bottom of the right sidebar, below Palette,
  // Identity, Fit and Design, so it is off-screen at 1400x900. Calling
  // `.closest()` on that null threw, `done()` never ran, and the harness sat
  // waiting for a report nobody was going to send.
  //
  // Two lessons, both applied below: scroll to a thing before pointing at it,
  // and make `done()` unconditional. A test that cannot fail cleanly cannot be
  // trusted when it passes.
  const report = await inBrowser(PRELUDE + `
    (async () => {
      try {
        if (!await ready()) { say('THREW app never rendered any regions'); return done(); }
        const btn = document.querySelector('#recheck');
        if (!btn) { say('THREW no #recheck button'); return done(); }

        btn.scrollIntoView({ block: 'center' });
        await settle(200);
        const [x, y] = centre(btn);
        const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
        say('in view: ' + inView);
        const hit = inView ? topAt(x, y) : null;
        say('topmost at button: #' + (hit ? (hit.closest('[id]')?.id ?? 'nothing') : 'off-screen'));

        // A real event either way. The pointer path is the interesting one when
        // the button is reachable; when it is not, dispatching on the element
        // still exercises the handler, the fetch and the rendering, which is
        // what the fake DOM is untrustworthy about.
        if (inView) clickAt(x, y); else btn.click();
        await settle(3000);

        const el = document.querySelector('#fitment');
        say('panel filled: ' + (el.innerHTML.trim().length > 0));
        say('still measuring: ' + el.textContent.includes('measuring'));
        say('says what it skipped: ' + /not checked|not placed/.test(el.textContent));
      } catch (e) {
        say('THREW ' + (e && e.stack ? e.stack : e));
      }
      done();
    })();
  `, { fitPath: new URL('../fits/neon-grid-any@abarth500.json', import.meta.url).pathname });

  const find = (p) => report.find((l) => l.startsWith(p)) ?? '';
  assert.ok(!report.some((l) => l.startsWith('THREW')), report.join(' | '));
  assert.equal(find('panel filled: '), 'panel filled: true', report.join(' | '));
  assert.equal(find('still measuring: '), 'still measuring: false',
    `the request never came back: ${report.join(' | ')}`);
  // No model is loaded in this harness, so the geometry checks cannot run — and
  // the panel has to say so rather than showing a reassuring blank.
  assert.equal(find('says what it skipped: '), 'says what it skipped: true', report.join(' | '));
});

// The PRELUDE is a template literal, so a backtick anywhere inside it ends the
// literal and the whole file stops parsing. That has happened four times in
// this project, and every time it reached CI, because a syntax error in one
// test file is invisible until the file is loaded.
//
// Not skipped on a machine with no browser: this is about the source, and it
// costs nothing.
test('the browser preamble contains no stray backticks', async () => {
  const src = await readFile(new URL(import.meta.url), 'utf8');
  const open = src.indexOf('const PRELUDE = ') + 'const PRELUDE = '.length;
  const body = src.slice(open + 1, src.indexOf(String.fromCharCode(96) + ';', open));

  assert.ok(body.length > 200, 'found the preamble');
  assert.equal(body.indexOf(String.fromCharCode(96)), -1,
    'a backtick inside PRELUDE ends the template literal and breaks the file');
});
