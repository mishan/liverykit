// ---------------------------------------------------------------------------
// An Assetto Corsa skin: what the build's rendered surfaces become in the game.
//
// The build renders a design onto a car's textures and hands each finished
// image to an output. This is the output Assetto Corsa needs, and every one of
// its hazards lives here rather than in the build: DDS with its whole mip
// chain, sizes rounded up to powers of two, a clear sheet where a design hides
// a surface, CSP's lights config, ui_skin.json with its badge and preview, and
// the ZIP Content Manager installs without asking.
// ---------------------------------------------------------------------------

import { writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import { toDDS, toPNG, isPngTexture, makeBadge } from './pipeline.mjs';
import { packageZip, makePreview, makeShowroomPreview, previewFrame, PREVIEW_FRAME } from './package.mjs';
import { designLights, extConfigIni } from './lights.mjs';
import { wholeModelGeometry } from './geometry.mjs';
import { carSheets } from './shot.mjs';
import { texture } from '../profile.mjs';
import { loadModel } from '../model.mjs';
import * as build from '../build.mjs';
// Assetto Corsa's vocabulary, so a design can paint `body` rather than a file.
import './classify.mjs';

/**
 * The size a hidden surface's clear sheet is shipped at. A texture with no
 * texels worth seeing needs no texels: the game stretches whatever it is given
 * over the mesh, and nothing-times-1024 is the same nothing as nothing-times-4.
 * At the original size the NSX's two IGT plates came to 2.8 MB of transparent
 * DXT5; at 4x4, the smallest a DXT block allows, they are a few hundred bytes.
 */
const CLEAR_SHEET = 4;

// The file CSP reads beside a skin's textures for that skin's own config.
const CAR_CONFIG_NAME = 'ext_config.ini';

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/** What a written texture is, for the build's log. */
async function written(outPath, file, [width, height], alpha) {
  return { file, width, height, format: isPngTexture(file) ? 'PNG' : alpha ? 'DXT5' : 'DXT1', bytes: (await stat(outPath)).size };
}

export const acSkin = {
  /**
   * Write one texture, as the PNG or DDS its filename says. A DDS at a size
   * that is not a power of two would lose its mip chain in the game, so it goes
   * out at the next powers of two up; UVs are fractions of the sheet, so the
   * art lands where it was drawn.
   */
  async writeSurface({ png, tex, width, height, outDir, pngDir = outDir, keep = false }) {
    const asPng = isPngTexture(tex.file);
    const [w, h] = asPng ? [width, height] : [nextPow2(width), nextPow2(height)];
    const outPath = join(outDir, tex.file);
    const pngPath = join(pngDir, tex.file.replace(/\.(dds|png)$/i, '.png'));
    await writeFile(pngPath, w === width && h === height ? png
      : await sharp(png).resize(w, h, { fit: 'fill' }).png().toBuffer());
    if (asPng) await toPNG(pngPath, outPath);
    else await toDDS(pngPath, outPath, { width: w, height: h, alpha: tex.alpha ?? false });
    if (!keep && pngPath !== outPath) await rm(pngPath);
    return written(outPath, tex.file, [w, h], tex.alpha);
  },

  /** A surface the design hides, as a fully transparent sheet the game draws as nothing. */
  async hideSurface({ file, outDir, pngDir = outDir, keep = false }) {
    const outPath = join(outDir, file);
    const png = await sharp({ create: { width: CLEAR_SHEET, height: CLEAR_SHEET, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer();
    if (isPngTexture(file)) {
      await writeFile(outPath, png);
    } else {
      const pngPath = join(pngDir, file.replace(/\.dds$/i, '.png'));
      await writeFile(pngPath, png);
      await toDDS(pngPath, outPath, { width: CLEAR_SHEET, height: CLEAR_SHEET, alpha: true });
      if (!keep) await rm(pngPath);
    }
    return written(outPath, file, [CLEAR_SHEET, CLEAR_SHEET], true);
  },

  /**
   * Lights the design adds, as the Custom Shaders Patch config CSP reads from
   * a skin's own folder. The underglow is placed from the model, so it needs
   * one; lights stated in metres do not. The file written, or null.
   */
  async writeLights({ livery, modelPath, outDir, notes, log }) {
    const model = livery.underglow && modelPath
      ? await loadModel(modelPath).catch((e) => { log(`  ! could not read ${modelPath} for the lights: ${e.message}`); return null; })
      : null;
    if (livery.underglow && !model) {
      notes.push({ term: 'underglow', status: 'light', text: 'underglow: placed from the car\'s model, and there is none to read; pass --model' });
    }
    const { lights, notes: lightNotes } = designLights(model ?? {}, model ? livery : { ...livery, underglow: undefined });
    notes.push(...lightNotes);
    if (!lights.length) return null;
    await writeFile(join(outDir, CAR_CONFIG_NAME), extConfigIni(lights));
    log(`  ${CAR_CONFIG_NAME.padEnd(24)} ${lights.length} light(s)`.padEnd(46) + 'CSP');
    return CAR_CONFIG_NAME;
  },

  /**
   * ui_skin.json, the livery.png badge and preview.jpg. The preview is a real
   * render of the car where there is a model and painted surfaces to render
   * it with, and the placeholder otherwise, labelled with `previewLabel` or
   * the design's number.
   */
  async finish({ outDir, livery, firstPng, previewLabel = null, profile = null, targets = [], pngByRole = new Map(), modelPath = null, log = console.log }) {
    // Asked once and used by both the real render and the placeholder, so a
    // build that falls back still lands the conventional size for this car.
    const frame = (await previewFrame(modelPath, { log })) ?? PREVIEW_FRAME;
    const preview = await renderShowroomPreview({ profile, livery, targets, pngByRole, modelPath, frame, log });
    const id = livery.identity ?? {};
    await writeFile(
      join(outDir, 'ui_skin.json'),
      JSON.stringify({
        skinname: livery.name,
        drivername: id.driver ?? '',
        team: id.team ?? '',
        number: id.number ?? '',
        country: id.country ?? '',
      }, null, 2)
    );
    if (firstPng) {
      await makeBadge(firstPng, join(outDir, 'livery.png'));
      if (preview) await writeFile(join(outDir, 'preview.jpg'), preview);
      else await makePreview(firstPng, join(outDir, 'preview.jpg'), { ...frame, label: previewLabel ?? id.number ?? '' });
    }
  },
};

/** buildSkin, writing an Assetto Corsa skin unless told otherwise. */
export const buildSkin = (opts) => build.buildSkin({ ...opts, output: opts.output ?? acSkin });

/** buildCalibration, writing an Assetto Corsa skin unless told otherwise. */
export const buildCalibration = (opts) => build.buildCalibration({ ...opts, output: opts.output ?? acSkin });

/** ZIP of the skin, laid out for Content Manager or as the bare folder — see packageZip. */
export async function packSkin({ skinDir, zipPath, carId, folder, layout = 'cm' }) {
  return packageZip({ skinDir, zipPath, carId, skinFolder: folder, layout });
}

/**
 * A real render of the car wearing the finished skin, for preview.jpg — the
 * same picture `render_car` would take, rather than the blurred-texture
 * placeholder. `null` when there is no model to render it from, which is not
 * an error: plenty of people hold a profile for a car they have not unpacked,
 * and `finish` falls back to the placeholder when this comes back empty.
 *
 * Parity with the editor's Whole Car view is the goal, not a coincidence:
 * both wear the design's own artwork on what it paints and the CAR'S OWN
 * texture on what it does not — glass, wheels, interior trim — rather than
 * leaving those parts flat gray. The editor gets that from the browser
 * uploading the kn5's compressed textures straight to the GPU; this has no
 * GPU, so `carSheets` does in a temp file what the browser does in VRAM.
 */
async function renderShowroomPreview({ profile, livery, targets, pngByRole, modelPath, frame, log }) {
  if (!modelPath || !targets.length) return null;

  let model;
  try {
    // TRUE here, unlike every other model read in this project: the whole
    // point of this pass is the texture bytes, not just the geometry they are
    // wrapped around.
    model = await loadModel(modelPath, { keepTextureData: true });
  } catch (e) {
    log(`  ! could not read ${modelPath} for preview.jpg: ${e.message}`);
    return null;
  }

  const files = targets.map((t) => ({ role: t.role, file: texture(profile, t.role).file }));
  const g = wholeModelGeometry(model, files, { livery, profile });

  // FULL RESOLUTION, and it used to be 512.
  //
  // That downsize was reasoned from a 900x560 shot: a few hundred pixels
  // across, so a 2048 sheet is more detail than can survive. The reasoning was
  // right and the numbers stopped being true. This frame is 1555x835, rendered
  // two samples over at 3110x1670, and a door that spans six hundred of those
  // pixels was reading a couple of hundred texels — every texel four pixels
  // wide, sampled nearest, which is what put the staircase on the number and
  // the sponsor text. That is not edge aliasing and no amount of supersampling
  // touches it.
  //
  // It is also nearly free: decoding one of these PNGs straight to raw is
  // ~13 ms, where resizing it to 512 on the way was ~35. The resize was the
  // expensive half.
  const sheets = new Map();
  for (const [role, png] of pngByRole) {
    const { data, info } = await sharp(png)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    sheets.set(role, { data, w: info.width, h: info.height });
  }

  // The car's own artwork for whatever the design leaves unpainted — filed
  // under FILE rather than role, which is how `rasterize`'s `sheetKey` tells
  // "this is the car's" from "this is the design's". Only the files a group
  // actually claims, which `wholeModelGeometry` has already narrowed to what
  // is drawn AND trusted (see `trustworthyDiffuse` — a MultiMap atlas is
  // excluded there, before this ever sees it).
  //
  // Shared with the MCP renderer rather than done here, which is where it used
  // to live: `shoot` had none of this and drew every unpainted part gray, so
  // the picture an agent takes without a browser and the picture that ships in
  // the skin disagreed about the same car.
  const byName = new Map((model.textures ?? []).map((t) => [t.name.toLowerCase(), t]));
  const stock = await carSheets(g.groups, (file) => byName.get(String(file).toLowerCase())?.data ?? null);
  for (const [file, art] of stock.sheets) sheets.set(file, art);
  if (stock.absent.length) {
    log(`  preview: ${stock.absent.length} texture(s) the model does not carry: ${stock.absent.join(', ')}`);
  }

  try {
    return await makeShowroomPreview(g, g.groups, sheets, frame);
  } catch (e) {
    log(`  ! could not render preview.jpg from the model: ${e.message}`);
    return null;
  }
}
