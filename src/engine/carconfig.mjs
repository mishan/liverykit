// ---------------------------------------------------------------------------
// What the car's own Custom Shaders Patch config does to the model.
//
// A kn5 is not the whole car. `extension/ext_config.ini` beside it can hide
// meshes with a MODEL_REPLACEMENT section, and cars converted from ACC use it
// for exactly the thing this project kept tripping over: four sets of number
// plates modelled on one door, all hidden by default, one un-hidden by the
// skin that wears it. Read from the model alone, those plates are geometry
// like any other — the viewer drew them, the fitment check reported their
// emissive twins as unpainted, and a design shipped a texture for a mesh the
// game never draws.
//
// This reads that config so a profile can say which meshes the game hides.
// Only reads: it never decides anything, and it names what it could not match
// rather than dropping it, because a HIDE entry that matches nothing here may
// still match something in CSP and the difference is worth a line.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CAR_CONFIG = join('extension', 'ext_config.ini');

/**
 * The HIDE patterns that apply to `modelFile`, from the ini text.
 *
 * A MODEL_REPLACEMENT section names the kn5 files it applies to in FILE and
 * the meshes to hide in HIDE, both comma-separated. One without FILE is read
 * as applying to every model; that is CSP's default and also the safe reading,
 * since the failure the other way is a hidden mesh reported as visible.
 *
 * Case-insensitive throughout: the NSX writes `IGT_NUMBERPLATE_LEFT` in the
 * config and the mesh is called the same, but Windows never cared and neither
 * do the people writing these files.
 */
export function hidePatterns(iniText, modelFile) {
  const want = String(modelFile).toLowerCase();
  const patterns = [];
  let inReplacement = false;
  let files = null;
  let hides = [];

  const flush = () => {
    if (inReplacement && (files === null || files.includes(want))) patterns.push(...hides);
    inReplacement = false; files = null; hides = [];
  };

  for (const raw of String(iniText).split(/\r?\n/)) {
    // `;` and `//` both comment in CSP configs, and a value can carry one.
    const line = raw.replace(/\s*(;|\/\/).*$/, '').trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      flush();
      inReplacement = /^MODEL_REPLACEMENT(_|\.\.\.|$)/i.test(section[1].trim());
      continue;
    }
    if (!inReplacement) continue;
    const kv = line.match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toUpperCase();
    const values = kv[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (key === 'FILE') files = values.map((f) => f.toLowerCase());
    else if (key === 'HIDE') hides.push(...values);
  }
  flush();
  return patterns;
}

/**
 * Resolve HIDE patterns against a parsed model.
 *
 * A pattern is a mesh name, with `*` and `?` as wildcards the way CSP reads
 * them. A pattern ending in `.dds` is read as the diffuse texture of the
 * meshes to hide — the NSX config lists two plates that way, and there is no
 * mesh by that name to match. That reading is a judgement about the config's
 * intent rather than a fact about CSP's parser, so a mesh matched this way is
 * reported with `by: 'texture'` and the profile keeps the distinction.
 *
 * Returns every hidden mesh name, and every pattern that matched nothing —
 * which is not an error, only a thing worth knowing.
 */
export function hiddenMeshes(model, patterns) {
  const hidden = new Map();          // mesh name -> { by, pattern }
  const unmatched = [];
  for (const pattern of patterns) {
    let hit = 0;
    if (/\.dds$/i.test(pattern)) {
      const want = pattern.toLowerCase();
      for (const m of model.meshes ?? []) {
        const file = model.materials?.[m.materialId]?.slots?.txDiffuse ?? '';
        if (file.toLowerCase() !== want) continue;
        if (!hidden.has(m.name)) hidden.set(m.name, { by: 'texture', pattern });
        hit++;
      }
    } else {
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      for (const m of model.meshes ?? []) {
        if (!re.test(m.name)) continue;
        if (!hidden.has(m.name)) hidden.set(m.name, { by: 'name', pattern });
        hit++;
      }
    }
    if (!hit) unmatched.push(pattern);
  }
  return { hidden, unmatched };
}

/**
 * The car's config, read from beside the model. Absent is the common case and
 * is not an error: most cars have no extension folder at all.
 */
export async function carConfigBeside(kn5Path) {
  const at = join(dirname(kn5Path), CAR_CONFIG);
  const raw = await readFile(at).catch(() => null);
  if (raw === null) return null;
  // Same UTF-16 hazard as ui_car.json: some of these were saved by tools that
  // write a BOM, and a NUL between every character matches nothing.
  const text = raw[0] === 0xFF && raw[1] === 0xFE
    ? raw.subarray(2).toString('utf16le')
    : raw.toString('utf8').replace(/^﻿/, '');
  return { path: at, text };
}
