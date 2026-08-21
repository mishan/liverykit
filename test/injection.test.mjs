// ---------------------------------------------------------------------------
// A livery may not change the STRUCTURE of the document it describes.
//
// Treatments build markup by interpolation — `fill="${color}"` — which is what
// makes the pack API pleasant to write against and what makes every value a
// livery supplies one quotation mark away from being structure rather than
// content. A palette entry of
//
//   x"/><image href="q" onerror="…"/><rect fill="x
//
// closed the attribute, closed the element, and added two of its own. Measured
// before the fix: 40 fields across the 12 shipped treatments would take it, and
// in the editor — which sets the finished document as `innerHTML` — the handler
// ran. A livery is a file people download from each other and the editor is
// served by a local server that writes files, so that was a real way to lose.
//
// This is the test that keeps it fixed. It does not check that `renderTexture`
// calls `safe()`, because that would only prove today's implementation matches
// itself. It pushes markup through EVERY option of EVERY registered treatment —
// discovered from the packs' own descriptions, so a new option is covered
// without anyone remembering to come here — and checks the shape of what comes
// out.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/index.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { renderTexture, safe } from '../src/render.mjs';
import { mulberry32 } from '../src/engine/rng.mjs';

const PROFILE = {
  id: 'c',
  textures: { body: { file: 'b.dds', width: 128, height: 128 } },
  panels: { body: { L: { rect: [0, 0, 1, 1] } } },
};

/**
 * Payloads, one per way out of an attribute.
 *
 * The first leaves the attribute and the element and starts new ones; the
 * second stays inside the tag and adds an attribute to the element already
 * there. They fail differently and a fix could plausibly stop one and not the
 * other.
 */
const PAYLOADS = [
  'A"/><image href="q" onerror="X()"/><rect fill="A',
  'A" onerror="X()" x="A',
];
const BENIGN = 'AAAAAA';

/**
 * What the document is, with what it SAYS taken out.
 *
 * Text content has to go before anything is asserted about the markup, because
 * escaped text legitimately contains the payload's own characters: `esc` turns
 * `<image` into `&lt;image` and leaves ` onerror="X()"` alone, which is
 * perfectly safe between two tags and looks exactly like an attack anywhere
 * else. Reading the structure with the words removed is the difference between
 * measuring this and pattern-matching it.
 */
const structure = (svg) => svg.replace(/>[^<]*</g, '><');

/** Element names, deduplicated: what the document is made OF. */
const elements = (svg) =>
  [...new Set([...structure(svg).matchAll(/<\s*([a-zA-Z][\w:-]*)/g)].map((m) => m[1]))].sort();

/**
 * The tags with their attribute VALUES emptied, leaving the attribute names.
 *
 * Needed because a payload that has been escaped still reads like an attack —
 * `fill="A&quot; onerror=&quot;X()&quot;"` contains the characters ` onerror=`
 * and is one attribute called `fill`. Grepping the raw document would call that
 * a hit, which is the difference between a test that measures whether the
 * escaping worked and one that measures whether the payload was scary.
 *
 * Emptying `"…"` spans is sound precisely BECAUSE of the fix: with quotes
 * escaped, the only quotes left are delimiters. If an injection got through,
 * its quotes are delimiters too and its attributes are left exposed — which is
 * how `A" onerror="X()" x="A` gets caught here despite adding no element.
 */
const attributeNames = (svg) => structure(svg).replace(/"[^"]*"/g, '""');

function draw({ region, palette = {}, background = 'black', tokens = {} }) {
  const out = renderTexture({
    profile: PROFILE,
    role: 'body',
    regions: [region],
    background,
    treatments: resolveTreatments(['core', 'synthwave']),
    palette,
    rng: mulberry32(1),
    font: 'sans',
    tokens,
  });
  return out.base + out.emissive;
}

/**
 * One field, one verdict.
 *
 * Compared against the same render with a harmless string of the same shape
 * rather than against a fixed expectation, so a treatment is free to emit
 * whatever it likes as long as the VALUE cannot change it. That matters for
 * `radialText`, which emits one `<g>` per character: counting elements would
 * call a longer string an injection, and comparing what the elements ARE does
 * not.
 */
function attempts(label, render, failures) {
  let expected;
  try {
    expected = elements(render(BENIGN));
  } catch {
    return; // this treatment will not take this field at all; nothing to test
  }
  for (const payload of PAYLOADS) {
    let got;
    try {
      got = render(payload);
    } catch {
      continue; // refusing outright is a fine answer
    }
    const found = elements(got);
    if (String(found) !== String(expected)) {
      failures.add(`${label}: added an element — ${found.filter((e) => !expected.includes(e)).join(', ')}`);
    }
    if (/\son\w+\s*=/.test(attributeNames(got))) {
      failures.add(`${label}: put an event handler on an element`);
    }
  }
}

test('no value a livery supplies can become markup', () => {
  const treatments = resolveTreatments(['core', 'synthwave']);
  const failures = new Set();
  let checked = 0;

  for (const [name, entry] of treatments) {
    const region = (extra) => ({ id: 'r', panel: 'L', treatment: name, text: 'hi', ...extra });

    // The background and a palette colour reach markup through `ctx.color`,
    // which every treatment uses and which passes an unknown name straight
    // through — so the livery's own text arrives either way.
    attempts(`${name}: background`, (v) =>
      draw({ region: region({}), palette: { bg: v }, background: 'bg' }), failures);
    attempts(`${name}: a palette colour`, (v) =>
      draw({ region: region({ color: 'p', colors: ['p'] }), palette: { p: v } }), failures);
    checked += 2;

    // And every option the pack says it takes, whatever it is called. Read from
    // the description rather than from a list here, so an option added to a
    // treatment tomorrow is covered by this test tonight.
    for (const [field, o] of Object.entries(entry.describe?.options ?? {})) {
      if (!['string', 'color', 'colors', 'enum'].includes(o.type)) continue;
      attempts(`${name}.${field}`, (v) =>
        draw({ region: region({ [field]: o.type === 'colors' ? [v] : v }) }), failures);
      checked += 1;
    }
  }

  // Identity tokens are the same problem arriving by another road: `{driver}`
  // is substituted into `text` from a block the same file supplies.
  for (const t of ['text', 'radialText']) {
    attempts(`${t}: an identity token`, (v) =>
      draw({ region: { id: 'r', panel: 'L', treatment: t, text: '{who}' }, tokens: { who: v } }), failures);
    checked += 1;
  }

  assert.deepEqual([...failures], [],
    `${failures.size} of ${checked} fields took markup from the livery`);
  // A guard on the guard. If `describe` were ever renamed, every loop above
  // would quietly iterate nothing and this test would pass having checked the
  // background and nothing else.
  assert.ok(checked > 40, `only ${checked} fields were probed, so this test has stopped looking`);
});

test('escaping changes what a value can do, not what it means', () => {
  // The five entities are resolved by any XML parser back to the characters
  // they stand for, so this is not a filter that quietly eats input.
  assert.equal(safe('#00F0FF'), '#00F0FF', 'an ordinary colour is untouched');
  assert.equal(safe('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(safe('a"b'), 'a&quot;b');
  assert.equal(safe(`a'b`), 'a&apos;b');
  assert.equal(safe('a&b'), 'a&amp;b', 'the ampersand first, or the others would be double-escaped');
  assert.equal(safe('<>'), '&lt;&gt;');
  assert.equal(safe(7), '7', 'a number is not a special case for a caller to remember');
});

test('a treatment still gets numbers as numbers', () => {
  // Escaping strings is safe; escaping everything is not. `cell` is divided by,
  // and a treatment multiplying by "12" would be a strange way to discover a
  // security fix went in.
  const svg = draw({
    region: { id: 'r', panel: 'L', treatment: 'halftone', cell: 12, dot: 0.3, angle: 45 },
    palette: { black: '#000' },
  });
  assert.doesNotMatch(svg, /NaN/, 'arithmetic on the options still works');
  assert.match(svg, /<circle/, 'and it drew something');
});

test('text keeps its own characters, because it is content and not a parameter', () => {
  // `text` is deliberately the one option NOT escaped on the way in: its two
  // emitters escape it for the text node they put it in. The reason is
  // `radialText`, which renders a character at a time — a pre-escaped string
  // would spell `&quot;` out in five glyphs around the circle.
  const svg = draw({
    region: { id: 'r', panel: 'L', treatment: 'text', text: 'Renault & Co' },
    palette: { white: '#fff' },
  });
  assert.match(svg, />Renault &amp; Co</, 'escaped exactly once, so the car reads "Renault & Co"');
  assert.doesNotMatch(svg, /&amp;amp;/, 'and not twice');

  const round = draw({
    region: { id: 'r', panel: 'L', treatment: 'radialText', text: 'A"B', radius: 0.4 },
    palette: { white: '#fff' },
  });
  assert.equal((round.match(/<text/g) ?? []).length, 3, 'three characters, three glyphs — not seven');
});
