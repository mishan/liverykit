// ---------------------------------------------------------------------------
// The fitting UI's server.
//
// LOCAL ONLY, and deliberately so. It reads the car models and stock skins on
// this machine, which this project never ships and never uploads, so it binds to
// 127.0.0.1 and there is no hosted version. If that ever changes, it changes on
// purpose and not by accident.
//
// The whole design rests on one measurement: `renderTexture` is pure JavaScript
// and produces a 2048-square body texture in about 2 ms as a self-contained SVG,
// which a browser renders natively. So the edit loop is a POST, 2 ms of work and
// a document swap — no ImageMagick, no DDS encode, no file watching. A fitting
// tool that re-encoded a texture per nudge would be too slow to be worth using.
//
// Four endpoints, no framework, no build step, no dependencies:
//
//   GET  /                 the app
//   GET  /api/state        livery, panels, tags, current fit, resolved regions
//   POST /api/render       a working fit -> SVG + where each region landed
//   POST /api/fit          write the fit file
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTexture } from '../render.mjs';
import { texture, resolveTargets, expandRegions, panel as findPanel } from '../profile.mjs';
import { applyFit, regionIds, unusedFitIds, validateFit, toAbsolute, toPanelRelative } from '../fit.mjs';
import { resolveTreatments } from '../registry.mjs';
import { mulberry32, seedFrom } from '../engine/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * Everything the browser needs to draw the editor, computed once per request.
 *
 * Exported separately from the server because it is the only part with any
 * judgement in it, and a test should be able to reach it without opening a
 * socket.
 */
export function editorState({ livery, profile, fit }) {
  const ids = regionIds(livery);
  const { targets } = resolveTargets(profile, livery);

  // Only surfaces that resolved to a texture on THIS car can be edited. A term
  // the car does not have has nothing to drag.
  const surfaces = [];
  for (const t of targets) {
    if (!t.primary) continue;                       // one entry per term, not per texture
    const tex = texture(profile, t.role);
    surfaces.push({
      from: t.from,
      role: t.role,
      file: tex.file,
      width: tex.width,
      height: tex.height,
      panels: Object.entries(profile.panels?.[t.role] ?? {}).map(([name, p]) => ({
        name,
        rect: p.rect,
        tags: p.tags ?? [],
        instances: p.instances,
        anisotropy: p.anisotropy ?? 1,
      })),
      regions: (t.spec.regions ?? []).map((r, i) => ({
        index: i,
        id: r.id,
        treatment: r.treatment,
        editable: r.id !== undefined,
        tags: r.tags,
        panel: r.panel,
        at: r.at ?? [0, 0, 1, 1],
      })),
    });
  }

  return {
    livery: { name: livery.name, folder: livery.folder, identity: livery.identity ?? {} },
    car: { id: profile.id, name: profile.name ?? profile.id },
    // Which surface a region lives on, so the browser can jump to it by id.
    regionIds: Object.fromEntries(ids),
    fit: fit ?? { livery: null, car: profile.id, regions: {} },
    surfaces,
  };
}

/**
 * Render one surface under a working fit, and report where every region landed.
 *
 * The second half is what makes the editor honest: it returns the ABSOLUTE
 * rectangle each region resolved to, so the overlay draws what was actually
 * painted rather than the editor's own idea of it. If the two ever disagree, the
 * overlay is wrong and you can see that it is.
 */
export function renderSurface({ livery, profile, fit, role, seed }) {
  const spec = resolveTargets(profile, livery).targets.find((t) => t.role === role)?.spec;
  if (!spec) throw new Error(`No surface resolves to texture role "${role}" on this car.`);

  const notes = [];
  const used = new Set();
  const fitted = applyFit(spec.regions ?? [], fit, { profile, role, used, notes }).regions;
  for (const id of unusedFitIds(fit, used)) {
    notes.push({ term: id, status: 'fit-stale', text: `"${id}" matches no region in this livery` });
  }

  // renderTexture expands tag selectors itself, so it is handed the FITTED
  // regions, not expanded ones. Expanding first and passing the result would
  // expand twice, and the second pass sees a region carrying both `panel` and
  // `tags` — which is rightly an error.
  //
  // The overlay still needs to know where everything landed, so the expansion is
  // done separately, purely to report positions. Its notes are dropped because
  // renderTexture reports the same ones through regionNotes.
  const expanded = expandRegions(profile, role, fitted);

  const tex = texture(profile, role);
  const layers = renderTexture({
    profile,
    role,
    regions: fitted,
    regionNotes: notes,
    background: spec.background,
    treatments: resolveTreatments(livery.packs ?? ['core']),
    palette: livery.palette ?? {},
    rng: mulberry32(seedFrom((seed ?? livery.render?.seed ?? 'default') + tex.file)),
    font: livery.render?.font ?? 'sans-serif',
    tokens: livery.identity ?? {},
  });

  const placed = expanded.regions
    .filter((r) => r.id !== undefined)
    .map((r) => {
      const p = r.panel ? findPanel(profile, role, r.panel) : null;
      return {
        id: r.id,
        panel: r.panel ?? null,
        // Absolute texture fractions, which is what the overlay draws in.
        abs: p ? toAbsolute(p.rect, r.at) : (r.at ?? [0, 0, 1, 1]),
        anisotropy: p?.anisotropy ?? 1,
      };
    });

  return { svg: layers.base, emissive: layers.emissive, placed, notes };
}

export async function startUi({ livery, profile, fitPath, port = 7391, log = console.log }) {
  let fit = await readFile(fitPath, 'utf8').then(JSON.parse).catch(() => null);

  const server = createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
    const body = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    };

    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(200, editorState({ livery, profile, fit }));
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { fit: working, role, seed } = await body();
        return json(200, renderSurface({ livery, profile, fit: working, role, seed }));
      }

      if (req.method === 'POST' && url.pathname === '/api/fit') {
        const next = validateFit(await body(), fitPath);
        await mkdir(dirname(fitPath), { recursive: true });
        await writeFile(fitPath, JSON.stringify(next, null, 2) + '\n');
        fit = next;
        log(`  saved ${fitPath}`);
        return json(200, { saved: fitPath });
      }

      // Static. The path is taken from a fixed allowlist rather than joined
      // with user input, because a fitting tool has no business serving
      // anything outside its own directory.
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[a-z0-9.-]+$/i.test(file) || !MIME[extname(file)]) return send(404, 'text/plain', 'not found');
      const data = await readFile(join(HERE, file)).catch(() => null);
      if (!data) return send(404, 'text/plain', 'not found');
      return send(200, MIME[extname(file)], data);
    } catch (e) {
      return json(500, { error: e.message });
    }
  });

  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${port}/`, fitPath };
}

export { toAbsolute, toPanelRelative };
