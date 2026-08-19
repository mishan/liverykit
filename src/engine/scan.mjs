import { readdir, stat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';

const DDPF_FOURCC = 0x4;
const DDPF_ALPHAPIXELS = 0x1;

async function readDdsHeader(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(128);
    const { bytesRead } = await fh.read(buf, 0, 128, 0);
    if (bytesRead < 128 || buf.toString('ascii', 0, 4) !== 'DDS ') return null;
    const pfFlags = buf.readUInt32LE(80);
    const fourCC = pfFlags & DDPF_FOURCC ? buf.toString('ascii', 84, 88).replace(/\0/g, '') : null;
    return {
      width: buf.readUInt32LE(16),
      height: buf.readUInt32LE(12),
      mips: buf.readUInt32LE(28),
      fourCC,
      // DXT3/DXT5 carry alpha; DXT1 may via 1-bit, but treat it as opaque.
      alpha: fourCC === 'DXT3' || fourCC === 'DXT5' || (!fourCC && (pfFlags & DDPF_ALPHAPIXELS) !== 0),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Walk a car's skins/ directory (or a single skin folder) and report every
 * texture found, so the config can be generated instead of hand-written.
 */
export async function scanSkins(dir) {
  let roots;
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && /\.dds$/i.test(e.name))) {
    roots = [dir]; // pointed straight at one skin folder
  } else {
    roots = entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  }

  const found = new Map(); // filename -> info (deduped across skins)

  for (const root of roots) {
    let files;
    try {
      files = await readdir(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.dds$/i.test(file)) continue;
      if (found.has(file)) continue;
      const full = join(root, file);
      const h = await readDdsHeader(full);
      if (!h) continue;
      found.set(file, { ...h, bytes: (await stat(full)).size, from: basename(root) });
    }
  }

  return [...found.entries()]
    .map(([file, info]) => ({ file, ...info }))
    .sort((a, b) => b.width * b.height - a.width * a.height || a.file.localeCompare(b.file));
}

/**
 * Count how many stock skins override each texture file.
 *
 * Distinct from `scanSkins`, which dedupes across skins to describe the textures
 * themselves. Here the COUNT is the point: a file that every skin replaces is
 * the author saying outright that this surface varies per livery, and that is
 * one of the signals that identifies bodywork without reference to a filename.
 *
 * Keys are lowercased, since NTFS does not distinguish case and neither should
 * this.
 */
export async function countSkinOverrides(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { skinCount: 0, counts: new Map() };
  }

  const TEXTURE = /\.(dds|png)$/i;
  const counts = new Map();
  const tally = (files) => {
    for (const f of files) {
      if (!TEXTURE.test(f)) continue;
      const k = f.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  };

  // Accept a skins/ directory OR a single skin folder, the same as scanSkins.
  // Without this, pointing --skins straight at one skin returned a count of
  // zero, which does not read as "no data" downstream — it reads as "no stock
  // skin overrides anything", and quietly costs the classifier a whole signal.
  if (entries.some((e) => e.isFile() && TEXTURE.test(e.name))) {
    tally(entries.filter((e) => e.isFile()).map((e) => e.name));
    return { skinCount: 1, counts };
  }

  let skinCount = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let files;
    try { files = await readdir(join(dir, e.name)); } catch { continue; }
    skinCount++;
    tally(files);
  }
  return { skinCount, counts };
}

/**
 * Classify a texture by filename and encoding. Painting over a normal map or a
 * shader map does not give you a recoloured car — it corrupts surface lighting.
 */
export function classify({ file, fourCC, width, height }) {
  if (/^placeholder/i.test(file)) return 'own-output';
  if (/(_NM|_norm|_normal)\b/i.test(file.replace(/\.dds$/i, ''))) return 'normal-map';
  if (/_map\b/i.test(file.replace(/\.dds$/i, ''))) return 'shader-map';
  // Big uncompressed textures are usually normal maps — DXT wrecks normals, so
  // authors leave them raw.
  if (!fourCC && width * height >= 1024 * 1024) return 'normal-map?';
  if (/glass|visor/i.test(file)) return 'glass';
  return 'diffuse';
}

const PAINTABLE = new Set(['diffuse', 'glass']);

export function formatScan(list) {
  const lines = [];
  const tagged = list.map((t) => ({ ...t, role: classify(t) }));

  lines.push(`Found ${list.length} texture(s):\n`);
  for (const t of tagged) {
    const warn = PAINTABLE.has(t.role) ? '' : `  <-- ${t.role}, DO NOT PAINT`;
    lines.push(
      `  ${t.file.padEnd(26)} ${String(t.width).padStart(5)}x${String(t.height).padEnd(5)} ` +
      `${(t.fourCC ?? 'RGB').padEnd(5)} mips=${String(t.mips).padStart(2)} ` +
      `alpha=${t.alpha ? 'yes' : 'no '}${warn}`
    );
  }

  // NTFS is case-insensitive; two files differing only in case collide on
  // Windows even though they coexist happily on ext4.
  const byLower = new Map();
  for (const t of tagged) {
    const k = t.file.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), t.file]);
  }
  const clashes = [...byLower.values()].filter((v) => v.length > 1);
  if (clashes.length) {
    lines.push('\n!! Case-insensitive filename collisions — Windows sees each pair as ONE');
    lines.push('   file. Ship only one spelling per pair or the second will overwrite the first:');
    for (const c of clashes) lines.push(`     ${c.join('  ==  ')}`);
  }

  const skipped = tagged.filter((t) => !PAINTABLE.has(t.role));
  if (skipped.length) {
    lines.push(`\nExcluded from the profile (${skipped.length}): ` +
      skipped.map((t) => `${t.file} (${t.role})`).join(', '));
  }

  lines.push('\n--- starting car profile — save as cars/<carId>.json ---\n');
  lines.push(formatProfile(list, { id: '<carId>' }));
  lines.push('\nPanels are empty because no scan can find them: which fraction of a texture');
  lines.push('lands on the sidepod is a property of the 3D model, not of the file. Build the');
  lines.push('calibration skin and read them off the car — see docs/calibration.md.');
  lines.push('\nAlso remember a scan only sees textures some stock skin chose to override.');
  lines.push('Absence here does NOT mean the model lacks it. Use --probe to test candidate');
  lines.push('names: a filename matching nothing overrides nothing, silently and harmlessly.');
  return lines.join('\n');
}

/**
 * Guess a semantic role from a filename, so a generated profile is readable
 * before anyone edits it. Only a starting point — rename freely. Liveries
 * address these names, so consistent naming across cars is exactly what lets
 * one design render on more than one model.
 */
export function guessRole(file) {
  const n = file.replace(/\.dds$/i, '').toLowerCase();
  if (/chassis|body|carrozzeria/.test(n)) return 'body';
  if (/tyre|tire/.test(n)) return 'tyres';

  // Cockpit parts come BEFORE the rim/wheel rule, which would otherwise swallow
  // anything with "wheel" in the name — a steering wheel is not a rim, and a
  // wheel-hub logo is neither.
  if (/logo/.test(n) && /wheel|steer|hub/.test(n)) return 'wheelLogo';
  if (/steer/.test(n)) return 'steeringWheel';
  if (/grip/.test(n)) return 'grips';
  if (/belt/.test(n)) return 'belts';
  if (/interior|cockpit|^int[_-]/.test(n)) return 'interior';
  if (/logo|emblem|badge/.test(n)) return 'logo';
  // Heat-shield foil: gold as shipped, and the only thing on the RSS4 that stayed
  // off-palette after everything else was painted.
  if (/foil|heatshield|heat_shield/.test(n)) return 'heatShield';

  if (/rim|wheel|brake/.test(n)) return 'rims';
  if (/helmet|casco/.test(n)) return 'helmet';
  if (/glove/.test(n)) return 'gloves';
  if (/suit|driver/.test(n)) return 'suit';
  if (/crew|pit/.test(n)) return 'crew';
  if (/glass|visor/.test(n)) return 'glass';
  return n.replace(/[^a-z0-9]+/g, '_');
}

const REASONS = {
  'normal-map': 'normal map — encodes surface direction, not colour; painting corrupts lighting',
  'normal-map?': 'large and uncompressed, almost certainly a normal map',
  'shader-map': 'AC shader map — gloss and reflectivity per texel, not colour',
  'own-output': 'generated by this tool',
  glass: 'alpha-blended glass; tintable in principle, easy to ruin',
};

/**
 * Emit a car profile skeleton: everything a scan can legitimately determine
 * (filenames, dimensions, alpha, what not to paint) and nothing it cannot
 * (panels, which have to be measured against the actual model).
 */
export function formatProfile(list, { id = '<carId>', name = '' } = {}) {
  const tagged = list.map((t) => ({ ...t, role: classify(t) }));
  const textures = {};
  const used = new Set();

  for (const t of tagged.filter((x) => PAINTABLE.has(x.role))) {
    let role = guessRole(t.file);
    while (used.has(role)) role += '_2';
    used.add(role);
    textures[role] = { file: t.file, width: t.width, height: t.height, alpha: t.alpha };
  }

  return JSON.stringify({
    id,
    name,
    game: 'assettocorsa',
    calibration: { method: 'uvgrid', date: null, notes: '' },
    textures,
    doNotPaint: tagged
      .filter((t) => !PAINTABLE.has(t.role))
      .map((t) => ({ file: t.file, reason: REASONS[t.role] ?? t.role })),
    panels: Object.fromEntries(Object.keys(textures).map((r) => [r, {}])),
  }, null, 2);
}
