// ---------------------------------------------------------------------------
// A profile from a model and nothing else.
//
// What a game knows about its models — Assetto Corsa's skin folders, its car
// data, the classifier that binds its vocabulary — is the game's generator's
// to add (liverykit's profileFromKn5). This is what is left when there is
// none of it: the model's own images, measured.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { loadModel, meshesWearing, meshTraits } from './model.mjs';
import { facing, sayFacing, recordFacing } from './frame.mjs';
import { imageHeader } from './images.mjs';
import { measurePanels, coverageOf } from './engine/measure.mjs';
import { PROFILE_SCHEMA } from './profile.mjs';
import { tagProfile } from './engine/tags.mjs';

/**
 * Build a profile for any model toile reads.
 *
 * Every image a mesh wears as its color becomes a texture, filed under a role
 * named after its file and measured into panels, its size read from the image
 * itself. One whose size cannot be read, and every normal map, is listed as
 * not to be painted, with the reason.
 *
 * `kind` names its sections: a `car`'s run nose to tail, an `object`'s front
 * to back. A model whose wheels say which way it faces is a car unless told
 * otherwise, and anything else an object.
 */
export async function profileFromModel(path, {
  id = null, name = '', facing: facingAs = null, kind = null, eye = null, visibility = true,
  minPanelArea, minVertices, minCoverage, log = () => {},
} = {}) {
  const model = await loadModel(path, { keepTextureData: true });
  if (model.encrypted) {
    throw new Error(`${path} is encrypted: every image in it is a stand-in, and its real sizes are in the car's ` +
      'skins, which liverykit --from-kn5 reads');
  }
  log(`  ${model.meshes.length} meshes, ${model.textures.length} textures, ${model.materials.length} materials`);
  const axes = facing(model, { stated: facingAs, log });
  sayFacing(model, axes, log);
  const is = kind ?? (axes.from === 'wheels' ? 'car' : 'object');
  if (is !== 'car') log(`  an ${is}: its sections run front, mid and back`);

  const images = new Map(model.textures.map((t) => [t.name.toLowerCase(), t]));
  // A skin is one folder, so two images one name apart only by where they
  // lived are one file there, and neither can be painted without the other.
  const named = new Map();
  for (const t of model.textures) named.set(t.name.toLowerCase(), (named.get(t.name.toLowerCase()) ?? 0) + 1);
  const spelling = new Map();
  for (const m of model.meshes) {
    const d = meshTraits(model, m).diffuse;
    if (d && !spelling.has(d.toLowerCase())) spelling.set(d.toLowerCase(), d);
  }
  const coverage = coverageOf(model);
  const textures = {};
  const doNotPaint = [];
  const roleOf = new Map();
  for (const key of [...coverage.keys()].sort((a, b) => coverage.get(b) - coverage.get(a))) {
    const image = images.get(key);
    const file = image?.name ?? spelling.get(key);
    if (named.get(key) > 1) {
      doNotPaint.push({ file, reason: `${named.get(key)} images are named ${file}, and they would be one file; rename one` });
      continue;
    }
    const h = imageHeader(file, image?.data);
    if (!h) {
      doNotPaint.push({
        file,
        reason: image?.missing ? 'the image is not beside the model, so its size is unknown'
          : 'its size could not be read from the image',
      });
      continue;
    }
    const role = unique(roleName(file), roleOf);
    roleOf.set(file, role);
    const wearers = meshesWearing(model, file);
    textures[role] = {
      file, width: h.width, height: h.height, alpha: h.alpha,
      alphaHides: wearers.length > 0 && wearers.every((m) => meshTraits(model, m).discardsClear),
      ...(wearers.some((m) => !meshTraits(model, m).trustworthy)
        ? { notes: 'The material multiplies this image by a color, so a design on it is seen tinted.' } : {}),
    };
  }
  const normals = new Set(model.meshes.map((m) => meshTraits(model, m).normalMap).filter(Boolean));
  for (const file of normals) {
    if (coverage.has(file.toLowerCase())) continue;
    doNotPaint.push({ file, reason: 'normal map — encodes surface direction, not color; painting corrupts lighting' });
  }

  // Without an eye there is no driver's seat to measure from, which is said,
  // since a panel without the figure looks like one nobody inside can see.
  if (visibility && !eye) log('  no eye was given, so visibleFromCockpit is not measured');
  const { panels, straddling } = measurePanels(model, roleOf, textures, {
    axes, kind: is, eye, visibility, minPanelArea, minVertices, minCoverage, log,
  });
  if (straddling.size) {
    log(`  ! ${[...straddling.values()].reduce((a, b) => a + b, 0)} island(s) straddle a sheet boundary; ` +
        'their panels stop at it, and one lying wholly off [0, 1] has none.');
  }

  const profile = {
    schemaVersion: PROFILE_SCHEMA,
    id: id ?? basename(String(path)).replace(/\.[^.]+$/, ''),
    name,
    calibration: {
      method: model.format?.name ?? 'kn5',
      source: basename(String(path)),
      model: await fingerprint(path),
      date: new Date().toISOString().slice(0, 10),
      uvSet: 0,
      // Where the driver's-seat visibility was measured from, so a cockpit
      // camera can stand there.
      ...(eye ? { eye: { at: [eye.x, eye.y, eye.z].map((v) => Math.round(v * 1000) / 1000), from: 'given' } } : {}),
      axes: recordFacing(axes),
      // Only where it is not a car, which every profile was before.
      ...(is !== 'car' ? { kind: is } : {}),
    },
    textures,
    doNotPaint,
    panels,
  };
  const { tagged } = tagProfile(profile);
  log(`  tagged ${tagged} panel(s) with portable descriptors (side, section, level, visibility)`);
  return profile;
}

/** What identifies the model a profile was measured from; see `staleModel`. */
export async function fingerprint(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A role from a file name: its stem, in lower case, with anything else as underscores. */
const roleName = (file) => basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'texture';

/** `role`, or `role_2` and onwards where it is taken. */
function unique(role, roleOf) {
  const taken = new Set(roleOf.values());
  if (!taken.has(role)) return role;
  let n = 2;
  while (taken.has(`${role}_${n}`)) n++;
  return `${role}_${n}`;
}
