// ---------------------------------------------------------------------------
// liverykit — public API.
//
// Generate Assetto Corsa livery textures from code instead of painting them.
//
// Three layers, deliberately separable:
//
//   car profile  what a CAR is        — textures, UV panels, safe areas.
//                                       Expensive to measure, identical for
//                                       everyone who owns the car, shareable.
//   livery       what a DESIGN is     — palette, identity, which treatment goes
//                                       on which named panel. Cheap to write.
//   pack         what a STYLE is      — the treatments themselves. Bring your
//                                       own without forking.
//
// Because liveries address panels by name rather than by coordinate, the same
// design renders on any car whose profile uses matching panel names.
// ---------------------------------------------------------------------------

export { buildSkin, buildCalibration, packSkin } from './build.mjs';
export { loadProfile, validateProfile, texture, panel, resolveRect, doNotPaint } from './profile.mjs';
export { definePack, registerPack, unregisterPack, getPack, listPacks, resolveTreatments } from './registry.mjs';
export { renderTexture, makeColorResolver } from './render.mjs';

// Engine internals — useful when building tooling on top, not needed to make a
// livery.
export { scanSkins, classify, formatScan, formatProfile, guessRole } from './engine/scan.mjs';

// Reading the car's 3D model — the authoritative source for everything a car
// profile describes.
export { parseKn5, parseKn5Buffer, vertex, triangles, meshesUsingTexture, axisHints } from './engine/kn5.mjs';
export { findIslands, nameIslands, findMirrorPairs, findAdjacency, carBounds } from './engine/islands.mjs';
export { preserveHandwork, describeHandwork } from './engine/preserve.mjs';
export { profileFromKn5 } from './engine/profilegen.mjs';
export { uvGridSvg, probeSvg, makeProbes, gridShape } from './engine/uvgrid.mjs';
export { mulberry32, seedFrom, lerp, clamp, r2 } from './engine/rng.mjs';
export { makeZip } from './engine/zip.mjs';
export { mipCount, toDDS, rasterize, composeLayers } from './engine/pipeline.mjs';

// Motif geometry, for writing your own treatments.
export * as motifs from './motifs.mjs';

// Built-in packs, both registered on import of this module.
//
// "Opt-in" happens at the livery level, not the import level: a livery lists the
// packs it wants and only those treatments resolve, so `packs: ['core']` never
// sees a synthwave treatment even though the pack is loaded. Registering both
// here keeps the CLI from having to guess what to import, at the cost of a few
// KB of unused code.
//
// Note the subpath exports (`liverykit/packs/core`) only hand you the pack
// OBJECT — they do not register it. Import `liverykit` itself, or call
// `registerPack` yourself.
import { registerPack } from './registry.mjs';
import corePack from './packs/core.mjs';
import synthwavePack from './packs/synthwave.mjs';

registerPack(corePack);
registerPack(synthwavePack);

export { corePack, synthwavePack };
