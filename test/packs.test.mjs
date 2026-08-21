// ---------------------------------------------------------------------------
// Treatments, and the descriptions of them.
//
// A treatment reads whatever it likes off `ctx.opts` — that is the whole of the
// pack contract and it is not going to change. The descriptions added alongside
// exist so a tool can offer a control instead of a JSON box, and they are a
// SECOND copy of a fact that already lives in the function body. Two copies of
// one fact drift, and this one would drift silently: a described option nobody
// reads is a control that does nothing, and a read option nobody described is a
// control that never appears.
//
// So neither is written down twice. The reads are MEASURED, by handing each
// treatment an `opts` that records what it looks at.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/index.mjs';
import { resolveTreatments, definePack, listPacks } from '../src/registry.mjs';
import { mulberry32 } from '../src/engine/rng.mjs';

const RECT = { x: 10, y: 20, w: 300, h: 150, anisotropy: 1.4 };

/**
 * Run a treatment and report which options it read.
 *
 * A Proxy rather than source parsing. Parsing would have to find each
 * treatment's own text inside a file that holds several, and would then be
 * fooled by a helper, a destructure or a comment; the Proxy answers the question
 * that actually matters — what did this function ask for when it ran.
 */
function optionsRead(fn, seed) {
  const read = new Set();
  const opts = new Proxy({ ...seed }, {
    get: (t, k) => { if (typeof k === 'string') read.add(k); return t[k]; },
    has: (t, k) => { read.add(k); return k in t; },
  });
  const palette = { cyan: '#0ff', pink: '#f0f', white: '#fff', violet: '#80f', black: '#000' };
  fn(RECT, {
    palette,
    color: (v) => palette[v] ?? v,
    rng: mulberry32(1),
    font: 'DejaVu Sans',
    opts,
    width: 2048,
    height: 2048,
    tokens: { driver: 'A. Driver', number: '7' },
  });
  return read;
}

/** A value of the right shape, so branches gated on an option actually run. */
function sampleFor(o) {
  switch (o.type) {
    case 'string': return 'SAMPLE';
    case 'number': return o.min !== undefined ? o.min + (o.step ?? 1) : 2;
    case 'boolean': return true;
    case 'color': return 'cyan';
    case 'colors': return ['cyan', 'pink'];
    case 'enum': return o.values[0];
    case 'rects': return [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    default: throw new Error(`no sample for ${o.type}`);
  }
}

test('every option a treatment reads is described, and every description is read', () => {
  const treatments = resolveTreatments(listPacks());
  let checked = 0;

  for (const [name, entry] of treatments) {
    if (!entry.describe) continue;              // undescribed packs are allowed
    checked++;
    const described = Object.entries(entry.describe.options ?? {});
    const names = new Set(described.map(([k]) => k));

    // Twice. Empty first, which catches everything read unconditionally; then
    // with a plausible value for each described option, which opens the
    // branches that only run when an option is set — `avoid`, `fit`, `glow`.
    const read = new Set([
      ...optionsRead(entry.fn, {}),
      ...optionsRead(entry.fn, Object.fromEntries(described.map(([k, o]) => [k, sampleFor(o)]))),
    ]);

    for (const key of read) {
      assert.ok(names.has(key),
        `${entry.pack}.${name} reads opts.${key}, which its description does not mention — ` +
        'the editor will never offer a control for it');
    }
    for (const key of names) {
      assert.ok(read.has(key),
        `${entry.pack}.${name} describes "${key}", which it never reads — ` +
        'the editor would offer a control that does nothing');
    }
  }

  assert.ok(checked >= 12, `expected the built-in packs to be described, checked ${checked}`);
});

test('a description is metadata, and cannot change what gets painted', async () => {
  // The point of keeping schemas out of the render path: a wrong description
  // costs you a bad slider, never a wrong texture.
  const { renderTexture } = await import('../src/render.mjs');
  const profile = {
    id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 1, 1] } } },
  };
  const args = {
    profile, role: 'body', background: 'ink',
    regions: [{ id: 'r', panel: 'L', treatment: 'fill', color: 'cyan' }],
    palette: { ink: '#000', cyan: '#0ff' }, rng: mulberry32(1), font: 'sans', tokens: {},
  };

  const honest = resolveTreatments(['core']);
  const before = renderTexture({ ...args, treatments: honest }).base;

  // Same functions, a deliberately absurd description.
  const lying = new Map(honest);
  lying.set('fill', { ...honest.get('fill'), describe: { options: { nonsense: { type: 'number' } } } });
  const after = renderTexture({ ...args, treatments: lying }).base;

  assert.equal(after, before);
});

test('describing is optional, and describing a typo is not', () => {
  const draw = () => ({ base: '', emissive: '' });

  // A pack that describes nothing still loads and still works. Nobody has to
  // rewrite a pack to keep using it.
  const bare = definePack('bare', { a: draw });
  assert.deepEqual(bare.describe, {});

  assert.throws(() => definePack('typo', { a: draw }, { b: { options: {} } }),
    /describes a treatment "b" it does not define/);
  assert.throws(() => definePack('bad', { a: draw }, { a: { options: { x: { type: 'wat' } } } }),
    /is not one of/);
  assert.throws(() => definePack('enum', { a: draw }, { a: { options: { x: { type: 'enum' } } } }),
    /an enum needs "values"/);
});
