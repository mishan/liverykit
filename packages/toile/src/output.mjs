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
 * Why `file` cannot be written under its own name in an output's folder, or
 * null. A texture's name comes from a model or a shared profile, both
 * somebody else's: a path is written where it points, and on Windows, where
 * skins are built, a colon makes a stream and a device name opens the device.
 */
export function fileNameProblem(file) {
  const name = String(file ?? '');
  if (!name || /[\\/:]/.test(name) || name === '.' || name === '..') return 'it is not a plain file name';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return 'it is a device name on Windows';
  return null;
}

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
    const problem = fileNameProblem(file);
    if (problem) throw new Error(`${tex.file} cannot be written: ${problem}`);
    await writeFile(join(outDir, file), png, { flag: 'wx' }).catch((e) => {
      throw e.code === 'EEXIST' ? new Error(`${tex.file} would be written as ${file}, which another texture already is`) : e;
    });
    // The output is the intermediate, so asking to keep it is asking for a copy.
    if (keep && pngDir !== outDir) await writeFile(join(pngDir, file), png);
    return { file, width, height, format: 'PNG', bytes: png.length };
  },
};
