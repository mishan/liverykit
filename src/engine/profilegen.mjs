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

import { parseKn5, meshesUsingTexture, axisHints, axesFromWheels } from './kn5.mjs';
import { findIslands, nameIslands, findMirrorPairs, findAdjacency, carBounds } from './islands.mjs';
import { computeSafeAreas, computeCockpitVisibility, cockpitEye } from './visibility.mjs';
import { guessRole, scanSkins, countSkinOverrides } from './scan.mjs';
import { textureFeatures, propose, SCORABLE } from './classify.mjs';
import { tagProfile } from './tags.mjs';

/**
 * A texture the model does not really contain.
 *
 * Encrypted models substitute a 1x1 image for every texture. Anything this small
 * carries no artwork and no usable dimensions — a real car texture is never
 * smaller than about 8x8 even for a flat colour swatch.
 */
function isPlaceholder(h) {
  return h.width <= 4 && h.height <= 4;
}

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
  id = null, name = '', minPanelArea = 0.0015, minVertices = 40, minCoverage = 0.008,
  visibility = true, assumeSize = null,
  skinsDir = null, log = () => {},
} = {}) {
  if (assumeSize !== null && !Number.isInteger(Math.log2(assumeSize))) {
    throw new Error(`assumeSize must be a power of two, got ${assumeSize}`);
  }
  const model = await parseKn5(path, { keepTextureData: true });

  // Orientation comes from the wheels, which AC's physics requires every car to
  // name WHEEL_LF/RF/LR/RR — so it is a measurement, not a guess. Across 238
  // fleet cars it resolved all of them, agreed with the old name heuristic on
  // all 145 the heuristic was confident about, and corrected 2 it had wrong.
  // The heuristic stays as a fallback for a model somehow missing its wheels.
  const wheels = axesFromWheels(model);
  const hint = axisHints(model);
  const axes = wheels ?? hint;
  log(`  ${model.meshes.length} meshes, ${model.textures.length} textures, ${model.materials.length} materials`);
  if (wheels) {
    log(`  axes: ${axes.left === 1 ? '+X' : '-X'} = left, ${axes.front === 1 ? '+Z' : '-Z'} = front` +
        `  (from the wheels: track ${wheels.trackWidth.toFixed(2)}m, wheelbase ${wheels.wheelbase.toFixed(2)}m)`);
    // A disagreement is worth surfacing even though the wheels win: it usually
    // means a mesh is named for the side it is NOT on.
    if (hint.confident && (hint.left !== wheels.left || hint.front !== wheels.front)) {
      log('  ! mesh names disagree with the wheels about which way the car faces.');
      log('    The wheels are used. Check for parts named for the wrong side.');
    }
  } else {
    log(`  axes: ${axes.left === 1 ? '+X' : '-X'} = left, ${axes.front === 1 ? '+Z' : '-Z'} = front` +
        `  ! NO WHEEL NODES — falling back to mesh names` +
        `${axes.confident ? '' : ', which are inconclusive here'}`);
  }

  // `front` matters: cockpitEye sits BACK from the steering wheel, and on a
  // model where +Z is rearward that offset has to flip or the eye ends up out
  // in front of the car.
  const eye = visibility ? cockpitEye(model, { front: axes.front }) : null;
  if (eye) log(`  driver's eye estimated at (${eye.x.toFixed(2)}, ${eye.y.toFixed(2)}, ${eye.z.toFixed(2)}) from ${eye.from}`);
  // Say so. Silently omitting visibleFromCockpit from every panel looks
  // identical to a car that genuinely has no interior.
  else if (visibility) log('  ! no steering wheel mesh found — visibleFromCockpit will be omitted.\n' +
    '    Pass an eye position, or rename the mesh, if this car has a cockpit worth painting.');

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

  // An encrypted model keeps its geometry readable and replaces every texture
  // with a 1x1 placeholder. Everything this tool needs from a model — the node
  // tree, materials, UV islands, which texture binds to which slot — survives
  // that. Only the DIMENSIONS are lost, and those come from skin folders anyway.
  const placeholder = Boolean(model.encrypted);
  if (placeholder) {
    log(`  ! this model is encrypted (${model.encrypted.scheme}, ` +
        `${(model.encrypted.bytes / 1e6).toFixed(1)} MB protected).`);
    log('    Geometry, materials and UV layout are all readable and are used normally.');
    log('    Textures are 1x1 placeholders, so every size must come from a skin folder:');
    log(`    pass --skins, or the profile will list nothing paintable.${skinsDir ? '  (given)' : '  (NOT GIVEN)'}`);
    if (assumeSize) {
      log(`    --assume-size ${assumeSize}: textures no skin overrides will be listed at ` +
          `${assumeSize}x${assumeSize}, which is a choice rather than a measurement.`);
    }
    if (assumeSize) {
      log(`    --assume-size ${assumeSize}: textures no skin overrides will be listed at ` +
          `${assumeSize}x${assumeSize}, which is a choice rather than a measurement.`);
    }
  }

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

    // On an encrypted model every embedded texture is a 1x1 placeholder, so the
    // model's own dimensions are not merely low-resolution — they are fiction.
    // A skin is then the ONLY source of truth, and without one there is nothing
    // honest to write down.
    if (placeholder && isPlaceholder(h)) {
      if (!skin && !assumeSize) {
        doNotPaint.push({
          file: tex.name,
          reason: 'the model is encrypted and ships a 1x1 placeholder for this texture, ' +
                  'so its real size is unknown — no stock skin overrides it either. ' +
                  'Pass --assume-size to paint it at a size of your choosing',
          encrypted: true,
        });
        usedRoles.delete(r);
        roleOf.delete(tex.name);
        continue;
      }
      if (skin) {
        entry.width = skin.width;
        entry.height = skin.height;
        entry.alpha = skin.alpha;
        entry.sizeFrom = 'skin';
        entry.notes = 'The model is encrypted; this size comes from a stock skin, not the model.';
      } else {
        // A CHOICE, not a measurement, and labelled as one. It is a safe choice:
        // AC does not require a skin texture to match the size the model shipped,
        // because UVs are fractions. The only cost of getting it wrong is disk
        // space or lost detail, not a broken skin.
        entry.width = assumeSize;
        entry.height = assumeSize;
        entry.sizeFrom = 'assumed';
        entry.notes = `The model is encrypted and no stock skin overrides this texture. ` +
                      `${assumeSize}x${assumeSize} was assumed, not measured.`;
      }
      textures[r] = entry;
      continue;
    }

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
  // Measured once, from the whole car, and handed to every role. Naming is a
  // claim about where something sits on the CAR; deriving the extent per texture
  // makes it a claim about where it sits on that sheet, which is very nearly
  // no claim at all. See nameIslands.
  const bounds = carBounds(model);
  for (const [texName, role] of roleOf) {
    const share = (coverage.get(texName) ?? 0) / totalCoverage;
    if (share < minCoverage) { panels[role] = {}; continue; }

    const meshes = meshesUsingTexture(model, texName);
    if (!meshes.length) { panels[role] = {}; continue; }

    const islands = findIslands(model, meshes, { minVertices });
    const total = islands.reduce((s, i) => s + i.uvArea, 0) || 1;
    const keep = islands.filter((i) => i.uvArea / total >= minPanelArea);
    nameIslands(keep, axes, bounds);
    findMirrorPairs(keep, axes);
    const adj = findAdjacency(model, keep);
    // Every mesh occludes, not just the painted ones — a wheel hides bodywork
    // as effectively as bodywork does.
    if (visibility) {
      computeSafeAreas(model, keep, { occluders: model.meshes, log });
      // Visibility isn't a property of a surface, it's a property of a surface
      // and a place to stand. A cockpit-view driver stares at the tub and the
      // steering wheel all race — surfaces the trackside pass scores near zero.
      if (eye) computeCockpitVisibility(model, keep, { eye, occluders: model.meshes, log });
    }

    log(`  ${role.padEnd(8)} ${texName.padEnd(26)} ${islands.length} islands, ${keep.length} above threshold`);

    panels[role] = {};
    for (const i of keep) {
      const p = {
        rect: i.rect,
        anisotropy: Math.round(i.anisotropy * 100) / 100,
        // How big one UV unit is on the car, in metres, along each axis. The
        // ratio above un-stretches a glyph; this says whether the glyph lands
        // 40 mm tall or 400, which is the question somebody placing artwork is
        // actually asking and the one thing a flat sheet can never answer.
        //
        // Millimetres, because a profile is read by people and the sixth
        // decimal of a figure measured off a game model would be pretending.
        metresPerUv: i.metresPerUv ? i.metresPerUv.map(r3) : undefined,
        confidence: 'measured',
        source: { mesh: i.mesh, vertices: i.vertexCount },
        centroid3d: [r3(i.centroid.x), r3(i.centroid.y), r3(i.centroid.z)],
        // Which way +u and +v travel across the car. Needed to mirror a
        // placement onto the opposite flank: `mirrorOf` is measured from
        // geometry and says nothing about how each island was laid out, and
        // two panels that are mirror images in 3D are very often unwrapped the
        // same way round in UV — or very often not.
        uAxis: i.uAxis ?? undefined,
        vAxis: i.vAxis ?? undefined,
      };
      // How far this island is rotated from upright, so artwork can read level
      // on a panel the unwrapper laid sideways. Omitted for near-horizontal
      // panels, where "up" has no meaning on the surface and any answer would be
      // rounding error.
      if (i.textRotation !== null && i.textRotation !== undefined) p.textRotation = i.textRotation;
      if (i.safe) p.safe = i.safe;
      if (i.visibleFraction !== undefined) p.visible = i.visibleFraction;
      if (i.cockpitFraction !== undefined) p.visibleFromCockpit = i.cockpitFraction;
      if (i.hidden) p.hidden = true;
      if (i.tiled) { p.tiled = true; p.uvBounds = i.uvBounds; }
      if (i.mirrorOf) p.mirrorOf = i.mirrorOf;
      const touching = [...(adj.get(i.name) ?? [])].sort();
      if (touching.length) p.adjacent = touching;
      panels[role][i.name] = p;
    }
    adjacencyOut[role] = Object.fromEntries([...adj].map(([k, v]) => [k, [...v].sort()]));
  }

  // --- proposed bindings ----------------------------------------------------
  //
  // Which of this car's roles each vocabulary term refers to, proposed by
  // measurement. Everything here is marked `auto`: a proposal is not a
  // confirmation, and 98% accurate is not the same as trustworthy without
  // looking. `mergeBindings` protects anything a human has confirmed, so
  // regenerating a profile never costs hand-checked work.
  const { skinCount, counts: skinCounts } = skinsDir
    ? await countSkinOverrides(skinsDir).catch(() => ({ skinCount: 0, counts: new Map() }))
    : { skinCount: 0, counts: new Map() };

  const visibleByFile = new Map();
  for (const [role, ps] of Object.entries(panels)) {
    const vals = Object.values(ps).map((p) => p.visible).filter((v) => typeof v === 'number');
    if (vals.length) visibleByFile.set(textures[role].file, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  const features = textureFeatures(model, { roles: textures, skinCounts, skinCount, visibleByFile });
  const bind = {};
  for (const term of SCORABLE) {
    const p = propose(features, term);
    // A term with no candidate is left OUT rather than bound to an empty array.
    // An empty array means "this car has no such surface", which is a claim, and
    // the classifier is not entitled to make it — only a person is.
    if (p) bind[term] = { roles: [p.role], confidence: p.confidence, source: 'auto' };
  }
  if (!visibility) {
    log('  ! bindings were proposed without visibility, which is the signal that separates');
    log('    bodywork from engine bays and interior occlusion maps. 90% accurate, not 98%.');
  }

  const profile = {
    bind,
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
        from: wheels ? 'wheels' : 'mesh names',
        // Checkable against a spec sheet, which is the point of recording it.
        ...(wheels ? {
          trackWidth: Math.round(wheels.trackWidth * 100) / 100,
          wheelbase: Math.round(wheels.wheelbase * 100) / 100,
        } : {}),
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

  // Tags come last, because they are computed from the finished profile rather
  // than from the model. One implementation then serves both generation and
  // retagging an existing hand-tuned profile, which is the only way to add them
  // without discarding its aliases, renames and notes.
  const { tagged, shared } = tagProfile(profile);
  log(`  tagged ${tagged} panel(s) with portable descriptors (side, section, level, visibility)`);
  if (shared) {
    // Worth saying out loud. It is the difference between "this car has 242
    // paintable regions" and "this car has 242 panels over 162 regions, and 80
    // of them cannot be painted independently however much you would like to".
    const pct = Math.round((100 * shared) / (tagged || 1));
    log(`  ${shared} of them (${pct}%) share their rectangle with another panel — instanced`);
    log('    geometry such as four wheels on one rim texture, or mirrored bodywork.');
    log('    They are drawn from the same texels, so they cannot carry different artwork,');
    log('    and they no longer claim a side or section their twin contradicts.');
  }

  return profile;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const basename = (p) => p.split(/[\\/]/).pop();
const basenameNoExt = (p) => basename(p).replace(/\.kn5$/i, '');
