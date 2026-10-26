/**
 * What a build's rendered surfaces become.
 *
 * The build renders a design onto an object's textures; an output decides what
 * each finished image is written as, and what else goes beside it. It has
 * one job it must do and three it may:
 *
 *   writeSurface({ png, tex, width, height, outDir, pngDir, keep })
 *     write one rendered texture; returns { file, width, height, format, bytes }
 *   hideSurface({ file, outDir, pngDir })   a surface the design hides
 *   writeLights({ livery, modelPath, outDir, notes, log })   the design's lights
 *   finish({ outDir, livery, firstPng, ... })   anything that goes beside them
 *
 * An output without one of the optional three cannot do that thing, and the
 * build says so in its notes rather than leaving a hidden surface drawn or a
 * light missing without a word. Assetto Corsa's is in src/engine/skin.mjs.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One PNG per surface, named after its texture, and nothing else. */
export const pngOutput = {
  async writeSurface({ png, tex, width, height, outDir }) {
    const file = tex.file.replace(/\.[^.]+$/, '') + '.png';
    await writeFile(join(outDir, file), png);
    return { file, width, height, format: 'PNG', bytes: png.length };
  },
};
