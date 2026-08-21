// ---------------------------------------------------------------------------
// Liveries: loading a design, from code or from data.
//
// A livery has always been an ES module whose default export is plain data —
// palette, identity, and regions naming a treatment by string. The module is
// worth keeping: `neon-grid.mjs` is commented as a tutorial, and a design is
// allowed to compute things.
//
// But the data really is plain, and a tool that can only READ it is stuck at
// half a job. Generating a module back out would destroy the comments, which
// are the part of it worth having. So a livery may instead BE data:
//
//   liveries/my-livery.json      the whole design, editable and round-trippable
//   liveries/my-livery.mjs       code, which may read its regions from JSON
//
// The editor writes only the first. See docs/authoring.md.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Load a design from either form.
 *
 * The extension decides, because nothing else can: a `.json` file is not a
 * module and importing one needs an attribute this project's Node floor
 * predates, while a `.mjs` cannot be parsed as data.
 */
export async function loadLivery(path) {
  const design = path.endsWith('.json')
    ? JSON.parse(await readFile(path, 'utf8'))
    : (await import(pathToFileURL(path).href)).default;

  if (!design) throw new Error(`Livery ${path} has no design in it (a .mjs needs a default export).`);
  return validateDesign(design, path);
}

/**
 * Check the shape a design has to have, and say what is wrong in its own terms.
 *
 * Deliberately shallow. It checks the things that would otherwise fail somewhere
 * far away — a `regions` that is not an array, a treatment named with a number —
 * and leaves everything else to the renderer, which knows more. A validator that
 * tried to know every treatment's options would be the second source of truth
 * this project keeps refusing to create.
 */
export function validateDesign(design, source = '<inline>') {
  const err = (m) => { throw new Error(`Livery ${source}: ${m}`); };

  if (typeof design !== 'object' || Array.isArray(design)) err('must be an object');
  if (design.name !== undefined && typeof design.name !== 'string') err('"name" must be a string');
  if (design.folder !== undefined && typeof design.folder !== 'string') err('"folder" must be a string');
  if (design.packs !== undefined && !Array.isArray(design.packs)) {
    err('"packs" must be an array of pack names');
  }
  for (const key of ['palette', 'identity', 'render']) {
    const v = design[key];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      err(`"${key}" must be an object`);
    }
  }

  for (const block of ['paint', 'surfaces']) {
    const v = design[block];
    if (v === undefined) continue;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      err(`"${block}" must be an object keyed by ${block === 'paint' ? 'texture role' : 'vocabulary term'}`);
    }
    for (const [where, spec] of Object.entries(v)) {
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        err(`"${block}.${where}" must be an object like { background, regions }`);
      }
      if (spec.regions !== undefined && !Array.isArray(spec.regions)) {
        err(`"${block}.${where}.regions" must be an array`);
      }
      for (const [i, r] of (spec.regions ?? []).entries()) {
        const at = `${block}.${where}.regions[${i}]`;
        if (typeof r !== 'object' || r === null || Array.isArray(r)) err(`${at} must be an object`);
        if (r.id !== undefined && (typeof r.id !== 'string' || !r.id)) {
          err(`${at}.id must be a non-empty string`);
        }
        if (r.treatment !== undefined && typeof r.treatment !== 'string') {
          err(`${at}.treatment must be the name of a treatment`);
        }
        if (r.at !== undefined && (!Array.isArray(r.at) || r.at.length !== 4
            || r.at.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) {
          err(`${at}.at must be four numbers [x, y, w, h], panel-relative`);
        }
        if (r.panel !== undefined && r.tags !== undefined) {
          err(`${at} has both "panel" and "tags". Use one: a panel names an island on ` +
              `this car, tags select whichever islands match on any car.`);
        }
      }
    }
  }
  return design;
}

/**
 * The design as data, and an honest account of anything that could not come.
 *
 * Both shipped designs round-trip through JSON unchanged. A PROCEDURAL one does
 * not: regions built in a loop survive, because they are ordinary objects by the
 * time anyone sees them, but a function anywhere in the object does not, and
 * JSON.stringify drops one without a word.
 *
 * That is the exact shape of failure this project exists to refuse, so the paths
 * are collected and reported. A caller finding `lossy` non-empty must not offer
 * to edit or save, because what it would show is not what the build would paint.
 */
export function serialisableDesign(design) {
  const lossy = [];
  const walk = (v, path) => {
    if (typeof v === 'function') { lossy.push(path); return undefined; }
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
  };
  return { design: walk(design, ''), lossy };
}
