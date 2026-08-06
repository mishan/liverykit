// ---------------------------------------------------------------------------
// Car profile generation from a kn5.
//
// This replaces the screenshot calibration workflow with a measurement. A kn5
// contains everything a profile needs and more than a scan of skin folders can
// ever provide:
//
//   * every texture the model references, with its dimensions read from the
//     embedded blob — including textures no stock skin bothers to override,
//     which is the gap that made tyres look unpaintable
//   * exact UV island rectangles, instead of rectangles read off a render
//   * true anisotropy per island, from the UV->3D Jacobian
//   * which islands physically touch on the car
//
// Screenshot calibration remains useful for cars whose kn5 you don't have, and
// as a sanity check that the profile matches what the game actually draws.
// ---------------------------------------------------------------------------

import { parseKn5, meshesUsingTexture, axisHints } from './kn5.mjs';
import { findIslands, nameIslands, findMirrorPairs, findAdjacency } from './islands.mjs';
import { computeSafeAreas } from './visibility.mjs';
import { guessRole, scanSkins } from './scan.mjs';

/** DDS/PNG header straight from the blob embedded in the model. */
function imageHeader(name, data) {
  if (!data || data.length < 32) return null;
  if (data.toString('ascii', 0, 4) === 'DDS ') {
    const pfFlags = data.readUInt32LE(80);
    const fourCC = pfFlags & 0x4 ? data.toString('ascii', 84, 88).replace(/\0/g, '') : null;
    return {
      width: data.readUInt32LE(16),
      height: data.readUInt32LE(12),
      mips: data.readUInt32LE(28),
      fourCC,
      alpha: fourCC === 'DXT3' || fourCC === 'DXT5' || (!fourCC && (pfFlags & 0x1) !== 0),
    };
  }
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), fourCC: 'PNG', alpha: true, mips: 1 };
  }
  return null;
}

/**
 * What each material texture slot means.
 *
 * This supersedes the filename heuristics in scan.mjs whenever a model is
 * available, and it is strictly better: the model states outright which slot a
 * texture is bound to, so there is nothing to infer. The heuristic version had
 * to guess from names and sizes, and it guessed wrong on exactly the texture
 * that started this whole line of work — a tyre diffuse that happened to be
 * large and uncompressed got written off as a normal map.
 *
 * Authoritative data beats a good guess. That is the entire lesson of this
 * project, and it applies to its own code.
 */
const SLOT_MEANING = {
  txDiffuse: null,                    // colour — the paintable one
  txNormal: 'normal map — encodes surface direction, not colour; painting corrupts lighting',
  txNormalDetail: 'detail normal map',
  txNormalBlur: 'normal map for the motion-blurred variant',
  txMaps: 'AC shader map — gloss and reflectivity per texel, not colour',
  txDetail: 'tiled detail overlay, shared across parts; not a per-car surface',
  txBlur: 'motion-blurred variant, swapped in at speed',
  txGlow: 'emissive mask',
  txDirty: 'dirt buildup mask',
  txDust: 'dust buildup mask',
  txDamage: 'damage deformation map',
  txDamageMask: 'damage mask',
};

/**
 * Build a complete car profile.
 *
 * `minPanelArea` drops islands below that fraction of the texture. Bolt heads
 * and trim slivers are real islands but nobody paints them, and a profile
 * listing three hundred of them is unreadable.
 */
export async function profileFromKn5(path, {
  id = null, name = '', minPanelArea = 0.0015, minVertices = 40, minCoverage = 0.02,
  visibility = true,
  skinsDir = null, log = () => {},
} = {}) {
  const model = await parseKn5(path, { keepTextureData: true });
  const axes = axisHints(model);
  log(`  ${model.meshes.length} meshes, ${model.textures.length} textures, ${model.materials.length} materials`);
  log(`  axes: ${axes.left === 1 ? '+X' : '-X'} = left, ${axes.front === 1 ? '+Z' : '-Z'} = front` +
      `${axes.confident ? '' : '  (LOW CONFIDENCE — few directional mesh names to check against)'}`);

  const headers = new Map(model.textures.map((t) => [t.name, imageHeader(t.name, t.data)]));

  // Which slot each texture is bound to, across every material. A texture the
  // model ships but never binds is not paintable in any useful sense.
  const boundAs = new Map();
  for (const mesh of model.meshes) {
    const mat = model.materials[mesh.materialId];
    if (!mat) continue;
    for (const [slot, tex] of Object.entries(mat.slots)) {
      if (!boundAs.has(tex)) boundAs.set(tex, new Set());
      boundAs.get(tex).add(slot);
    }
  }
  const diffuseUsed = new Set([...boundAs].filter(([, s]) => s.has('txDiffuse')).map(([t]) => t));

  // How much geometry each texture actually covers. Two textures can both look
  // like "body" by name — a chassis diffuse and some chassis foil detail — and
  // the one carrying the bodywork should get the plain role name rather than
  // whichever happened to appear first in the file.
  const coverage = new Map();
  for (const mesh of model.meshes) {
    const t = model.materials[mesh.materialId]?.slots?.txDiffuse;
    if (t) coverage.set(t, (coverage.get(t) ?? 0) + mesh.vertexCount);
  }

  const textures = {};
  const doNotPaint = [];
  const usedRoles = new Set();
  const roleOf = new Map();

  const paintable = [];
  for (const tex of model.textures) {
    const h = headers.get(tex.name);
    if (!h) continue;
    const slots = boundAs.get(tex.name);

    if (!slots) continue;                                  // shipped but never bound
    if (!slots.has('txDiffuse')) {
      // Report the first slot that carries a meaning, so the reason is specific.
      const why = [...slots].map((s) => SLOT_MEANING[s]).find(Boolean)
        ?? `bound only as ${[...slots].join(', ')}`;
      doNotPaint.push({ file: tex.name, reason: why, slots: [...slots].sort() });
      continue;
    }
    paintable.push({ tex, h });
  }
  paintable.sort((a, b) => (coverage.get(b.tex.name) ?? 0) - (coverage.get(a.tex.name) ?? 0));

  // The textures embedded in a kn5 are the model's own defaults, and they are
  // routinely far smaller than what skins actually ship — 512x512 in the model
  // against 2048x2048 in every stock skin, on the car this was built against.
  //
  // The model is authoritative about UV LAYOUT and about which slot a texture
  // binds to. It is NOT authoritative about working resolution. Taking its word
  // would quietly render every livery at a quarter of the intended size, so a
  // skin folder is cross-referenced where one is available.
  const realSize = new Map();
  if (skinsDir) {
    const scanned = await scanSkins(skinsDir).catch(() => []);
    for (const s of scanned) realSize.set(s.file.toLowerCase(), s);
  }

  for (const { tex, h } of paintable) {
    let r = guessRole(tex.name);
    if (usedRoles.has(r)) {
      let n = 2;
      while (usedRoles.has(`${r}_${n}`)) n++;
      r = `${r}_${n}`;
    }
    usedRoles.add(r);
    roleOf.set(tex.name, r);

    const skin = realSize.get(tex.name.toLowerCase());
    const entry = { file: tex.name, width: h.width, height: h.height, alpha: h.alpha };
    if (skin && (skin.width !== h.width || skin.height !== h.height)) {
      log(`  ! ${tex.name}: model embeds ${h.width}x${h.height}, skins ship ` +
          `${skin.width}x${skin.height} — using the skin size`);
      entry.width = skin.width;
      entry.height = skin.height;
      entry.alpha = skin.alpha;
      entry.modelSize = [h.width, h.height];
    } else if (!skin) {
      entry.sizeFrom = 'model';       // unverified against a real skin
    }
    textures[r] = entry;
  }

  // A skin folder legitimately contains textures this model has never heard of.
  // The driver — helmet, suit, gloves — is a SEPARATE kn5 under content/driver/,
  // and the pit crew is another one again, but a car skin overrides all of them.
  // Dropping those would silently stop painting the driver.
  const known = new Set([...roleOf.keys()].map((t) => t.toLowerCase()));
  for (const [lower, s] of realSize) {
    if (known.has(lower)) continue;
    if (/(_nm|_norm|_normal|_map)\.dds$/i.test(s.file)) continue;   // still not paintable
    let r = guessRole(s.file);
    if (usedRoles.has(r)) { let n = 2; while (usedRoles.has(`${r}_${n}`)) n++; r = `${r}_${n}`; }
    usedRoles.add(r);
    textures[r] = {
      file: s.file, width: s.width, height: s.height, alpha: s.alpha,
      sizeFrom: 'skin',
      notes: 'Not referenced by this model — most likely belongs to the driver or ' +
             'crew model, which is a separate kn5. Panels cannot be measured from ' +
             'here; point --from-kn5 at that model to map them.',
    };
  }

  // Case collisions among everything the model references.
  const byLower = new Map();
  for (const t of model.textures) {
    const k = t.name.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), t.name]);
  }
  const caseCollisions = [...byLower.values()].filter((v) => v.length > 1);

  // --- panels, per paintable texture ---
  // Decomposing every texture produces hundreds of panels for springs, bolts
  // and cable trim — all real, none paintable in any meaningful sense, and
  // collectively they bury the panels somebody actually wants. Only textures
  // carrying a real share of the car's geometry get decomposed.
  const totalCoverage = [...roleOf.keys()].reduce((s, t) => s + (coverage.get(t) ?? 0), 0) || 1;

  const panels = {};
  const adjacencyOut = {};
  for (const [texName, role] of roleOf) {
    const share = (coverage.get(texName) ?? 0) / totalCoverage;
    if (share < minCoverage) { panels[role] = {}; continue; }

    const meshes = meshesUsingTexture(model, texName);
    if (!meshes.length) { panels[role] = {}; continue; }

    const islands = findIslands(model, meshes, { minVertices });
    const total = islands.reduce((s, i) => s + i.uvArea, 0) || 1;
    const keep = islands.filter((i) => i.uvArea / total >= minPanelArea);
    nameIslands(keep, axes);
    findMirrorPairs(keep, axes);
    const adj = findAdjacency(model, keep);
    // Every mesh occludes, not just the painted ones — a wheel hides bodywork
    // as effectively as bodywork does.
    if (visibility) computeSafeAreas(model, keep, { occluders: model.meshes, log });

    log(`  ${role.padEnd(8)} ${texName.padEnd(26)} ${islands.length} islands, ${keep.length} above threshold`);

    panels[role] = {};
    for (const i of keep) {
      const p = {
        rect: i.rect,
        anisotropy: Math.round(i.anisotropy * 100) / 100,
        confidence: 'measured',
        source: { mesh: i.mesh, vertices: i.vertexCount },
        centroid3d: [r3(i.centroid.x), r3(i.centroid.y), r3(i.centroid.z)],
      };
      if (i.safe) p.safe = i.safe;
      if (i.visibleFraction !== undefined) p.visible = i.visibleFraction;
      if (i.hidden) p.hidden = true;
      if (i.mirrorOf) p.mirrorOf = i.mirrorOf;
      const touching = [...(adj.get(i.name) ?? [])].sort();
      if (touching.length) p.adjacent = touching;
      panels[role][i.name] = p;
    }
    adjacencyOut[role] = Object.fromEntries([...adj].map(([k, v]) => [k, [...v].sort()]));
  }

  return {
    id: id ?? basenameNoExt(path),
    name,
    game: 'assettocorsa',
    calibration: {
      method: 'kn5',
      source: basename(path),
      date: new Date().toISOString().slice(0, 10),
      axes: {
        left: axes.left === 1 ? '+X' : '-X',
        front: axes.front === 1 ? '+Z' : '-Z',
        confident: axes.confident,
      },
      notes:
        'Generated from the model. Panel rects are exact UV island bounds, and ' +
        'anisotropy comes from the UV-to-3D Jacobian rather than from eyeballing ' +
        'a render. "adjacent" lists islands that physically touch on the car, ' +
        'which is what lets artwork continue across a UV seam. "visible" is the ' +
        'fraction of a panel readable from trackside viewpoints, computed by ray ' +
        'casting against the whole car; "safe" bounds that readable part. Those ' +
        'two are a heuristic, unlike the rest.',
    },
    textures,
    doNotPaint,
    ...(caseCollisions.length ? { caseCollisions } : {}),
    panels,
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const basename = (p) => p.split(/[\\/]/).pop();
const basenameNoExt = (p) => basename(p).replace(/\.kn5$/i, '');
