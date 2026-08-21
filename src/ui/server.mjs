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
import { texture, resolveTargets, expandRegions, panel as findPanel, panelName } from '../profile.mjs';
import { applyFit, regionIds, regionKey, unusedFitIds, validateFit, checkFitIdentity, fitLiveryId, toAbsolute, toPanelRelative } from '../fit.mjs';
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

/**
 * The WHOLE car, grouped by which texture paints each part.
 *
 * The per-role view is the right one while you are editing a surface — you are
 * looking at what you are painting. It is the wrong one for judging a design,
 * because a livery is not a texture, it is every texture at once, and a stripe
 * that meets the bodywork perfectly can still miss the sidepod beside it.
 *
 * Every mesh appears exactly once. A mesh whose texture the livery does not
 * paint goes into a group with no role, which the viewer renders in flat grey —
 * present, obviously unpainted, and not pretending to be stock artwork it does
 * not have. Leaving those out entirely would be worse: a car with holes in it
 * reads as a broken export rather than as an unpainted panel.
 */
export function wholeModelGeometry(model, files) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const groups = [];
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];

  const claimed = new Set();
  const emit = (meshes, group) => {
    const start = indices.length;
    for (const mesh of meshes) {
      const base = positions.length / 3;
      for (let i = 0; i < mesh.vertexCount; i++) {
        const v = vertex(model, mesh, i);
        positions.push(v.x, v.y, v.z);
        uvs.push(v.u, v.v);
        for (const [k, n] of [[0, v.x], [1, v.y], [2, v.z]]) {
          if (n < lo[k]) lo[k] = n;
          if (n > hi[k]) hi[k] = n;
        }
      }
      for (const [a, b, c] of triangles(model, mesh)) indices.push(base + a, base + b, base + c);
    }
    if (indices.length > start) groups.push({ ...group, start, count: indices.length - start });
  };

  for (const { role, file } of files) {
    const meshes = meshesUsingTexture(model, file).filter((m) => !claimed.has(m));
    for (const m of meshes) claimed.add(m);
    emit(meshes, { role, file });
  }
  // Whatever is left: glass, tyres on a livery that ignores them, the aerials.
  emit((model.meshes ?? []).filter((m) => !claimed.has(m)), { role: null, file: null });

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    groups,
    bounds: { lo, hi },
  };
}

/**
 * A JSON header of known length, then the arrays.
 *
 * The flat format below cannot describe groups, and encoding role names into a
 * binary header would mean inventing a string encoding for the sake of four
 * fields. A length-prefixed JSON header costs a few hundred bytes on a payload
 * of megabytes and stays readable when something goes wrong with it.
 */
export function packModel(g) {
  const json = Buffer.from(JSON.stringify({
    vertexCount: g.positions.length / 3,
    indexCount: g.indices.length,
    groups: g.groups,
    bounds: g.bounds,
  }), 'utf8');
  // PADDED TO FOUR BYTES. The browser takes Float32Array views straight over
  // this buffer, and a typed-array view must start on a multiple of its element
  // size — an unpadded header of arbitrary JSON length throws on three arrivals
  // out of four, which is a maddening way to find out about an alignment rule.
  const header = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const out = Buffer.alloc(4 + header.length + g.positions.byteLength
    + g.uvs.byteLength + g.indices.byteLength);
  out.writeUInt32LE(header.length, 0);
  let o = 4;
  const put = (b) => { b.copy(out, o); o += b.length; };
  put(header);
  for (const ta of [g.positions, g.uvs, g.indices]) {
    put(Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
  }
  return out;
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
/**
 * The id of a region's opposite number, if its own id names a side.
 *
 * A design says `driver-left` and `driver-right`, or `numberLeft` and
 * `numberRight`. That is the design stating its own symmetry, and it is a much
 * better signal than guessing from geometry — two regions can sit on mirrored
 * panels and still be deliberately different, which is most of what makes a
 * livery interesting.
 *
 * `_` counts as a boundary even though it is a word character to a regex, so
 * `driver_left` pairs. A capital after a lowercase letter counts too, so
 * `numberLeft` pairs. `flew` and `alright` do not, which is the point of
 * checking the boundaries at all.
 */
export function partnerId(id) {
  if (typeof id !== 'string') return null;
  const re = /(left|right)/gi;
  let m;
  while ((m = re.exec(id)) !== null) {
    const before = id[m.index - 1];
    const after = id[m.index + m[0].length];
    const startsWord = m.index === 0 || !/[A-Za-z]/.test(before)
      || (/[a-z]/.test(before) && /[A-Z]/.test(m[0][0]));
    const endsWord = after === undefined || !/[a-z]/.test(after);
    if (!startsWord || !endsWord) continue;

    const swapped = m[0].toLowerCase() === 'left'
      ? matchCase(m[0], 'right') : matchCase(m[0], 'left');
    return id.slice(0, m.index) + swapped + id.slice(m.index + m[0].length);
  }
  return null;
}

/** Keep LEFT/Left/left when swapping in the other side. */
function matchCase(sample, word) {
  if (sample === sample.toUpperCase()) return word.toUpperCase();
  if (sample[0] === sample[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/**
 * Regions that are two halves of one idea, and should move together.
 *
 * Both halves have to exist, and if both name a panel outright those panels have
 * to be each other's mirror. That second check is what stops a livery where
 * `badge-left` sits on the door and `badge-right` on the roof from being linked
 * into nonsense — and it costs nothing, because `mirrorOf` is measured from the
 * model rather than guessed from a name.
 *
 * Two things the check has to get right, and both come down to the same rule:
 * link only what can be VERIFIED as a mirror.
 *
 *   * A declared name may be an alias, so it is resolved through the profile
 *     exactly as the renderer resolves it. A name that resolves to nothing —
 *     the design names a panel this car does not have — cannot be shown to be
 *     anyone's mirror, so the halves are left unlinked. Linking on the grounds
 *     that the evidence is missing is how a badge ends up on a roof.
 *
 *   * Both halves may name the SAME panel, and that is valid: a panel with no
 *     mirror straddles the centreline, so it is its own, and a car with two
 *     numbers on its nose wears both of them there. `commit` already mirrors
 *     within such a panel; this must not refuse the pair before it gets there.
 */
export function mirrorPairs(livery, profile, role) {
  const byId = new Map();
  for (const spec of [...Object.values(livery.paint ?? {}), ...Object.values(livery.surfaces ?? {})]) {
    for (const r of spec.regions ?? []) if (r.id) byId.set(r.id, r);
  }

  const panels = profile.panels?.[role] ?? {};
  // The renderer's resolution, not a lookup: a livery is free to say `flankLeft`
  // and let the profile's aliases say which island that is.
  const resolve = (name) => {
    const real = profile.aliases?.[role]?.[name] ?? name;
    return panels[real] ? [real, panels[real]] : [null, null];
  };

  const out = new Map();
  for (const [id, r] of byId) {
    const other = partnerId(id);
    if (!other || !byId.has(other)) continue;
    const o = byId.get(other);
    if (r.panel && o.panel) {
      const [mineName, mine] = resolve(r.panel);
      const [theirsName, theirs] = resolve(o.panel);
      if (!mine || !theirs) continue;                       // unverifiable, so unlinked
      const mirrored = mineName === theirsName
        ? mine.mirrorOf === undefined                       // a centreline panel is its own
        : mine.mirrorOf === theirsName || theirs.mirrorOf === mineName;
      if (!mirrored) continue;
    }
    out.set(id, other);
  }
  return out;
}

export function editorState({ livery, profile, fit, liveryId = null }) {
  const ids = regionIds(livery);
  const { targets } = resolveTargets(profile, livery);

  // Only surfaces that resolved to a texture on THIS car can be edited. A term
  // the car does not have has nothing to drag.
  const surfaces = [];
  for (const t of targets) {
    if (!t.primary) continue;                       // one entry per term, not per texture
    const tex = texture(profile, t.role);
    const pairs = mirrorPairs(livery, profile, t.role);
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
        // Which way the sheet runs across this panel. The editor needs it to
        // mirror a placement onto the opposite flank; without it, copying `at`
        // across sends artwork to the wrong end of the twin.
        uAxis: p.uAxis,
        vAxis: p.vAxis,
        // Measured from the model. The editor follows it when a linked pair is
        // dragged: the twin goes to the mirror of wherever this one landed.
        mirrorOf: p.mirrorOf,
      })),
      regions: (t.spec.regions ?? []).map((r, i) => ({
        index: i,
        id: regionKey(t.from, r, i),
        // Named by the design, or addressed by position. Both are editable; the
        // editor says which, because a positional key moves if the livery gains
        // a region above it.
        derived: r.id === undefined,
        treatment: r.treatment,
        editable: true,
        // The design's own opposite number, if it declared one. Sent from here
        // rather than worked out in the browser: it needs the profile's
        // measured `mirrorOf`, and it is far easier to test in Node.
        mirror: pairs.get(regionKey(t.from, r, i)) ?? null,
        rotate: r.rotate ?? null,
        tags: r.tags,
        // Resolved through the aliases, the same as the placement is, so the
        // two can be compared. The editor asks "is this region still on the
        // panel the design named?" to decide whether an override is needed at
        // all, and that question is meaningless if one side says `flankLeft`
        // and the other `left_mid`.
        panel: r.panel ? panelName(profile, t.role, r.panel) : undefined,
        at: r.at ?? [0, 0, 1, 1],
      })),
    });
  }

  // `id` is what a fit calls this design, and it is NOT `folder`. A fit is found
  // at fits/<id>@<car>.json and repeats the pair inside itself, so a new fit
  // written with the skin folder name in it would disagree with every fit the
  // CLI looks up. Where nothing told the server the module name — a test calling
  // editorState directly — say so rather than guessing from the folder.
  const id = liveryId ?? null;

  return {
    livery: { id, name: livery.name, folder: livery.folder, identity: livery.identity ?? {} },
    car: { id: profile.id, name: profile.name ?? profile.id },
    // Which surface a region lives on, so the browser can jump to it by id.
    regionIds: Object.fromEntries(ids),
    fit: fit ?? { livery: id, car: profile.id, regions: {} },
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
  const surfaceKey = resolveTargets(profile, livery).targets.find((t) => t.role === role)?.from ?? '';
  const fitted = applyFit(spec.regions ?? [], fit, { profile, role, surfaceKey, used, notes }).regions;
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
    .filter((r) => r.__key)
    .map((r) => {
      const p = r.panel ? findPanel(profile, role, r.panel) : null;
      return {
        id: r.__key,
        // The PROFILE's name for the panel, not the livery's. A design is free
        // to say `flankLeft` where the profile calls the island `left_mid`, and
        // only the second is a key in `profile.panels` — which is what the panel
        // list, the overlay and every lookup in the browser are keyed by. Send
        // the livery's spelling and those lookups quietly find nothing, so a
        // drag falls back to absolute coordinates and writes them into a field
        // that means panel-relative. The artwork then moves somewhere nobody
        // asked for, from a fit that reads perfectly well.
        panel: r.panel ? panelName(profile, role, r.panel) : null,
        // Absolute texture fractions, which is what the overlay draws in.
        abs: p ? toAbsolute(p.rect, r.at) : (r.at ?? [0, 0, 1, 1]),
        anisotropy: p?.anisotropy ?? 1,
      };
    });

  return { svg: layers.base, emissive: layers.emissive, placed, notes };
}

export async function startUi({ livery, profile, fitPath, liveryId, modelPath = null, port = 7391, log = console.log }) {
  // What this editor is a fit FOR. Every fit that comes in or goes out has to
  // name this pair, or it is a fit for something else being edited by mistake.
  //
  // The design's id has to be passed in rather than read off the livery object:
  // it is the module basename, which only the caller that resolved the module
  // knows. Guessing it from `livery.folder` is exactly the bug this guards.
  if (!liveryId) throw new Error('startUi needs liveryId — the name a fit knows this design by (see fitLiveryId).');
  const identity = { livery: liveryId, car: profile.id };

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
  const started = new Date().toISOString().slice(11, 19);
  let fit = null;
  try {
    fit = validateFit(JSON.parse(await readFile(fitPath, 'utf8')), fitPath);
    // And it has to be a fit for THIS design on THIS car. `--fit` takes any
    // path, and the conventional one outlives the profile it was written for,
    // so the file being open is not by itself evidence that it belongs here.
    checkFitIdentity(fit, { ...identity, source: fitPath });
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

      // A fingerprint of the files actually on disk. Four rounds of this editor
      // were spent unable to tell whether the browser was running the code I had
      // just written, a cached copy, or a server started before the change. The
      // page shows this, so that question is answerable in one glance.
      if (req.method === 'GET' && url.pathname === '/api/build') {
        const { createHash } = await import('node:crypto');
        const h = createHash('sha256');
        for (const f of [...SERVABLE].sort()) h.update(await readFile(join(HERE, f)));
        return json(200, { build: h.digest('hex').slice(0, 8), started });
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(200, editorState({ livery, profile, fit, liveryId }));
      }

      if (req.method === 'POST' && url.pathname === '/api/render') {
        const { fit: working, role, seed } = await body();
        return json(200, renderSurface({ livery, profile, fit: working, role, seed }));
      }

      // Every painted surface at once, on the whole car. Rendered fresh because
      // the fit is the thing being judged; the geometry beside it is fetched
      // once and reused, which is why they are two calls rather than one.
      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const { fit: working, seed } = await body();
        const state = editorState({ livery, profile, fit: working });
        const surfaces = [];
        for (const s of state.surfaces) {
          const out = renderSurface({ livery, profile, fit: working, role: s.role, seed });
          surfaces.push({ role: s.role, from: s.from, file: s.file, svg: out.svg });
        }
        return json(200, { surfaces });
      }

      if (req.method === 'GET' && url.pathname === '/api/model' && url.searchParams.get('all')) {
        const m = await getModel();
        if (!m) return json(404, { error: modelError ?? 'no model' });
        const files = editorState({ livery, profile, fit })
          .surfaces.map((s) => ({ role: s.role, file: s.file }));
        const g = wholeModelGeometry(m, files);
        if (!g.indices.length) return json(404, { error: 'the model has no drawable geometry' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(packModel(g));
      }

      if (req.method === 'GET' && url.pathname === '/api/model') {
        // The query string is the one input here that a client can get wrong, so
        // it is answered as a client error. Letting `texture()` throw would turn
        // a missing or misspelt role into a 500 — a stack trace in the log and a
        // "the server crashed" in the browser, for a typo.
        const role = url.searchParams.get('role');
        if (!role) return json(400, { error: '/api/model needs a ?role=<texture role>' });
        if (!profile.textures?.[role]) {
          return json(404, {
            error: `car "${profile.id}" has no texture role "${role}". ` +
                   `Known roles: ${Object.keys(profile.textures ?? {}).join(', ')}`,
          });
        }
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
        // Save is a whole-file overwrite, so a client that has drifted — or a
        // request typed by hand — can replace this pair's fit with another
        // pair's. The file is named after the pair it is for; refuse to write
        // anything that contradicts the name. A 409, not a 500: the server is
        // fine, the submission is for something else.
        try {
          checkFitIdentity(next, { ...identity, source: fitPath });
        } catch (e) {
          return json(409, { error: e.message });
        }
        await mkdir(dirname(fitPath), { recursive: true });
        await writeFile(fitPath, JSON.stringify(next, null, 2) + '\n');
        fit = next;
        log(`  saved ${fitPath}`);
        return json(200, { saved: fitPath });
      }

      // A tiny transparent icon. Not cosmetic: a 404 here is the one line that
      // is always in the console, and it trains you to ignore the console.
      if (url.pathname === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'max-age=86400' });
        return res.end(Buffer.from(
          'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
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
