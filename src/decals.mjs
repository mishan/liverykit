// ---------------------------------------------------------------------------
// A livery's own images: logos, flags, sponsor marks — the artwork a design
// carries rather than draws.
//
// Everything else in a livery is CODE that emits vectors, which is what makes a
// design portable across cars and readable as a diff. A sponsor's logo is not
// like that: it is somebody else's artwork, it arrives as a file, and the only
// honest thing to do with it is put its pixels on the car.
//
// So a livery may be a FOLDER rather than a file — `liveries/<name>/` holding
// the design and a `decals/` directory beside it — and the images in that
// directory are addressed by name, which is the file's stem. A single-file
// livery has no folder of its own and therefore no decals; the error a design
// gets when it asks for one says so, because "your decal is missing" and "this
// design cannot have decals" are different problems.
//
// What comes out is a data URI per decal, and that is deliberate rather than
// incidental: see `decal` in the core pack. The pixels travel inside the
// document, so the build and the editor draw the same bytes and neither one
// resolves a path at draw time.
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import sharp from 'sharp';

/**
 * The biggest a decal may be, as it arrives.
 *
 * Generous, because a 4K sponsor sheet is a reasonable thing to hand this, and
 * bounded because every decal is inlined into every document that draws it —
 * including the whole-car preview the editor re-renders on every frame of a
 * drag. A refusal that names the file and its size is a better answer than an
 * editor that mysteriously crawls.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The longest side an SVG is rasterised to.
 *
 * An SVG has no pixels until somebody chooses some. 2048 is the largest a car
 * texture usually is, so a logo across a whole sheet is still sampling down
 * rather than up, and a logo on a door is far past what it needs.
 */
const SVG_LONGEST_SIDE = 2048;

/** What a file is, read from its first bytes rather than from its name. */
function sniff(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // An SVG is text, and the tag may sit behind a declaration, a comment or a
  // byte-order mark. Only the head is inspected: a megabyte of path data has
  // nothing to say about what the file is.
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--')) {
    return /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8')) ? 'svg' : null;
  }
  return null;
}

/**
 * Load every image in a livery's `decals/` directory.
 *
 * `dir` is the livery's OWN folder, or null for a single-file livery — see
 * `resolveLivery`, which is the one place that decides which a design is.
 *
 * Nothing here throws for a file it cannot use. An unreadable image, a format
 * this does not know, a stray `.DS_Store`: each is reported and skipped, and
 * the design that wanted it says so again at draw time with the region's own
 * name attached. What DOES throw is a collision — see below.
 */
export async function loadDecals(dir, { log = () => {} } = {}) {
  const decals = new Map();
  if (!dir) return decals;

  const from = join(dir, 'decals');
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    return decals;                       // a livery folder with no decals is fine
  }

  // Sorted, so two files that collide are reported the same way round on every
  // machine — and so the log reads in an order somebody can scan.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(from, entry.name);
    if (!entry.isFile()) {
      log(`  ! ${entry.name} is not a file; decals/ is flat, so it was skipped`);
      continue;
    }

    const name = basename(entry.name, extname(entry.name));
    // TWO FILES, ONE NAME. `logo.png` and `logo.svg` are addressed identically
    // by a design, and picking one of them by sort order would make which
    // artwork lands on the car depend on a rule nobody wrote down. This is the
    // same failure as a case collision in a skin folder, and it is refused for
    // the same reason.
    if (decals.has(name)) {
      throw new Error(
        `Two decals in ${from} are both called "${name}" — ${decals.get(name).file} and ` +
        `${entry.name}. A design addresses a decal by its name without the extension, ` +
        'so one of them could never be reached. Rename one.'
      );
    }

    const { size } = await stat(path);
    if (size > MAX_BYTES) {
      log(`  ! ${entry.name} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${MAX_BYTES / 1024 / 1024} MB a decal may be, and was skipped`);
      continue;
    }

    const raw = await readFile(path);
    const kind = sniff(raw);
    if (!kind) {
      log(`  ! ${entry.name} is not a PNG, JPEG or SVG — skipped`);
      continue;
    }

    let bytes = raw;
    let type = kind === 'jpeg' ? 'image/jpeg' : 'image/png';
    let width = null;
    let height = null;
    try {
      if (kind === 'svg') {
        // RASTERISED HERE, and never carried as SVG.
        //
        // A design is a file people download from each other and the editor
        // renders the finished document as innerHTML — so foreign markup
        // inside the sheet is a way to lose, which this project has already
        // lost once (see `safe` in render.mjs). An SVG asset is turned into
        // pixels at the door: its markup reaches librsvg here and nothing
        // downstream.
        const meta = await sharp(raw).metadata();
        const w = meta.width || SVG_LONGEST_SIDE;
        const h = meta.height || SVG_LONGEST_SIDE;
        // RENDERED AT THE CAP, up or down. An SVG has no pixels until somebody
        // chooses some, and its nominal size is whatever the author's editor
        // happened to write — a 100x50 logo is not a request for 100x50 texels
        // on a 2048 sheet, it is a shape. Density is how sharp asks librsvg for
        // a different scale: 72 dpi is 1:1, so 72 * scale renders the shape at
        // the size wanted rather than rendering it small and enlarging it.
        const scale = SVG_LONGEST_SIDE / Math.max(w, h);
        bytes = await sharp(raw, { density: Math.max(1, Math.round(72 * scale)) })
          // Density gets librsvg to the right scale; the resize lands it on the
          // exact size, since a rounded dpi is a pixel or two out and "the
          // longest side is 2048" should be true rather than nearly true.
          .resize({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), fit: 'inside' })
          .png().toBuffer();
        type = 'image/png';
      }
      const meta = await sharp(bytes).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      if (!width || !height) throw new Error('no dimensions');
    } catch (e) {
      log(`  ! ${entry.name} could not be read as an image (${e.message}) — skipped`);
      continue;
    }

    decals.set(name, {
      name,
      file: entry.name,
      type,
      width,
      height,
      // The pixels, ready to go into a document. Built once per run rather than
      // per region: a sponsor mark on eight panels is one string, eight times
      // referenced.
      uri: `data:${type};base64,${bytes.toString('base64')}`,
      bytes: bytes.length,
    });
  }

  if (decals.size) {
    log(`  ${decals.size} decal(s):`);
    for (const a of decals.values()) {
      log(`    ${a.name.padEnd(20)} ${a.width}x${a.height}  ${kb(a.bytes)}` +
          (a.file.toLowerCase().endsWith('.svg') ? '  (rasterised from SVG)' : ''));
    }
  }
  return decals;
}

/** Sizes a person can compare at a glance, which "0 KB" is not. */
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 100 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n / 1024)} KB`);
