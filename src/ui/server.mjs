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
//   GET  /api/model        the geometry a texture is painted on, packed binary
//   POST /api/fit          write the fit file
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseKn5, meshesUsingTexture, vertex, triangles } from '../engine/kn5.mjs';
import { renderTexture } from '../render.mjs';
import { texture, resolveTargets, expandRegions, panel as findPanel } from '../profile.mjs';
import { applyFit, regionIds, unusedFitIds, validateFit, toAbsolute, toPanelRelative } from '../fit.mjs';
import { resolveTreatments } from '../registry.mjs';
import { mulberry32, seedFrom } from '../engine/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The geometry a texture is painted on, in world space, ready for WebGL.
 *
 * A UV view answers "where on the sheet", which is the question you can already
 * see. It cannot answer the one that actually matters — is that spot flat, does
 * it face the camera, does the number wrap over a wheel arch — and no amount of
 * rectangle-dragging will make it.
 *
 * Packed binary rather than JSON: the Abarth's body is 17k vertices and 72k
 * indices, which is 0.6 MB of floats and several megabytes of decimal text. The
 * layout is deliberately dull — two counts, then positions, then UVs, then
 * indices — so the browser can take typed-array views straight over the buffer.
 */
export function modelGeometry(model, file) {
  const meshes = meshesUsingTexture(model, file);
  const positions = [];
  const uvs = [];
  const indices = [];
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];

  for (const mesh of meshes) {
    const base = positions.length / 3;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vertex(model, mesh, i);
      positions.push(v.x, v.y, v.z);
      // Texture space, the same convention the renderer uses: AC stores V
      // negative and image y is 1 + v, which `vertex` has already applied.
      uvs.push(v.u, v.v);
      for (const [k, n] of [[0, v.x], [1, v.y], [2, v.z]]) {
        if (n < lo[k]) lo[k] = n;
        if (n > hi[k]) hi[k] = n;
      }
    }
    for (const [a, b, c] of triangles(model, mesh)) {
      indices.push(base + a, base + b, base + c);
    }
  }

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    bounds: { lo, hi },
    meshes: meshes.length,
  };
}

/** Two counts, then positions, UVs and indices back to back. */
export function packGeometry(g) {
  const head = new Uint32Array([g.positions.length / 3, g.indices.length]);
  const out = Buffer.alloc(8 + g.positions.byteLength + g.uvs.byteLength + g.indices.byteLength);
  let o = 0;
  const put = (ta) => { Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).copy(out, o); o += ta.byteLength; };
  put(head); put(g.positions); put(g.uvs); put(g.indices);
  return out;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const SERVABLE = new Set(['index.html', 'app.js', 'view3d.js', 'style.css']);

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

export async function startUi({ livery, profile, fitPath, modelPath = null, port = 7391, log = console.log }) {
  // Parsed on first request rather than at startup: a 45 MB kn5 takes a second
  // or two, and the UV editor is useful without it. A missing model is not an
  // error — it means no 3D view, which is exactly the situation for anyone who
  // has a profile but not the car.
  let model = null;
  let modelError = null;
  const getModel = async () => {
    if (model || modelError) return model;
    if (!modelPath) { modelError = 'no model path given'; return null; }
    try {
      model = await parseKn5(modelPath, { keepTextureData: false });
      log(`  model loaded: ${modelPath}`);
    } catch (e) {
      modelError = e.message;
      log(`  ! could not read ${modelPath}: ${e.message}`);
    }
    return model;
  };
  // A missing fit is the normal case — most cars have never been tuned. A fit
  // that exists and is wrong is not, and starting anyway would give an editor
  // that looks fine and fails only when you press Save, by which point you have
  // done the work twice. Validated on the way in, same as the save path.
  let fit = null;
  try {
    fit = validateFit(JSON.parse(await readFile(fitPath, 'utf8')), fitPath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new Error(`Could not load ${fitPath}: ${e.message}`);
    }
  }

  const server = createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
    // Even on loopback, an unbounded read is an unbounded read: a stray upload
    // or a runaway client would grow the process until it died. A fit is a few
    // kilobytes of JSON and the largest thing posted here is a working copy of
    // one, so the ceiling can be low enough to be obviously safe.
    const MAX_BODY = 2 * 1024 * 1024;
    const body = async () => {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw new Error(`Request body over ${MAX_BODY} bytes; a fit is nothing like that big.`);
        chunks.push(c);
      }
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

      if (req.method === 'GET' && url.pathname === '/api/model') {
        const role = url.searchParams.get('role');
        const m = await getModel();
        if (!m) return json(404, { error: modelError ?? 'no model' });
        const tex = texture(profile, role);
        const g = modelGeometry(m, tex.file);
        if (!g.indices.length) return json(404, { error: `no geometry uses ${tex.file}` });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(packGeometry(g));
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
      if (!SERVABLE.has(file)) return send(404, 'text/plain', 'not found');
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
