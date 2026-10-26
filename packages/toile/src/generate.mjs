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
 */
export async function profileFromModel(path, {
  id = null, name = '', facing: facingAs = null, visibility = true,
  minPanelArea, minVertices, minCoverage, log = () => {},
} = {}) {
  const model = await loadModel(path, { keepTextureData: true });
  log(`  ${model.meshes.length} meshes, ${model.textures.length} textures, ${model.materials.length} materials`);
  const axes = facing(model, { stated: facingAs, log });
  sayFacing(model, axes, log);

  const images = new Map(model.textures.map((t) => [t.name.toLowerCase(), t]));
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
    };
  }
  const normals = new Set(model.meshes.map((m) => meshTraits(model, m).normalMap).filter(Boolean));
  for (const file of normals) {
    if (coverage.has(file.toLowerCase())) continue;
    doNotPaint.push({ file, reason: 'normal map — encodes surface direction, not color; painting corrupts lighting' });
  }

  const { panels, straddling } = measurePanels(model, roleOf, textures, {
    axes, visibility, minPanelArea, minVertices, minCoverage, log,
  });
  if (straddling.size) {
    log(`  ! ${[...straddling.values()].reduce((a, b) => a + b, 0)} island(s) straddle a sheet boundary; ` +
        'their panels stop at it, and one lying wholly off [0, 1] has none.');
  }

  const bytes = await readFile(path);
  const profile = {
    schemaVersion: PROFILE_SCHEMA,
    id: id ?? basename(String(path)).replace(/\.[^.]+$/, ''),
    name,
    calibration: {
      method: model.format?.name ?? 'kn5',
      source: basename(String(path)),
      model: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      date: new Date().toISOString().slice(0, 10),
      uvSet: 0,
      axes: recordFacing(axes),
    },
    textures,
    doNotPaint,
    panels,
  };
  const { tagged } = tagProfile(profile);
  log(`  tagged ${tagged} panel(s) with portable descriptors (side, section, level, visibility)`);
  return profile;
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
