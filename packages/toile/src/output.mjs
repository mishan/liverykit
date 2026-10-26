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
 * light missing without a word. Assetto Corsa's is in liverykit's
 * src/engine/skin.mjs.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Refuse a build with no output. There used to be a default, and changing
 * it changed what a build wrote with no error anywhere, which for a texture
 * whose filename the game no longer matches is a livery that silently does
 * not install.
 */
export function needOutput(output) {
  if (typeof output?.writeSurface !== 'function') {
    throw new Error('a build needs an output: acSkin from liverykit\'s src/engine/skin.mjs for an ' +
      'Assetto Corsa skin, or pngOutput from src/output.mjs for one PNG per surface');
  }
}

/**
 * One PNG per surface, named after its texture, and nothing else. Two textures
 * that differ only by extension would be one file, so the second is refused
 * rather than written over the first.
 */
export const pngOutput = {
  async writeSurface({ png, tex, width, height, outDir, pngDir = outDir, keep = false }) {
    const file = tex.file.replace(/\.[^.]+$/, '') + '.png';
    // Written into outDir and nowhere else, whatever a model named its image.
    if (/[\\/]/.test(file) || file.startsWith('..')) throw new Error(`${tex.file} is not a file name, so it is not written`);
    await writeFile(join(outDir, file), png, { flag: 'wx' }).catch((e) => {
      throw e.code === 'EEXIST' ? new Error(`${tex.file} would be written as ${file}, which another texture already is`) : e;
    });
    // The output is the intermediate, so asking to keep it is asking for a copy.
    if (keep && pngDir !== outDir) await writeFile(join(pngDir, file), png);
    return { file, width, height, format: 'PNG', bytes: png.length };
  },
};
