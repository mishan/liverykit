// ---------------------------------------------------------------------------
// Who refers to what, inside a design.
//
// A palette entry and an identity token are both just names, and both fail the
// same quiet way when the name stops resolving:
//
//   * `ctx.color(name)` is `palette[name] ?? name`, so a colour the palette does
//     not have is handed to the renderer as though it were a literal colour.
//     `fill="ghost"` is not an error to librsvg, it is simply not the colour
//     anybody meant.
//   * a `{token}` in a `text` region interpolates through `tokens[k] ?? ''`, so
//     an identity block missing `number` renders "A. Driver #" and says nothing.
//
// Neither shows up as a failure anywhere. So before the editor lets anyone
// rename or remove one of those names, it has to be able to say who was relying
// on it — which means counting the references, which is all this file does.
//
// The browser loads this file beside `app.js` and Node imports it directly, so
// there is one answer to "who uses this" rather than two. Its one import is a
// BARE specifier on purpose: an import map in `index.html` points it at the same
// package Node resolves, and the server hands the browser that package's own
// `.mjs`. No bundler, no build step, and no second copy to drift.
// ---------------------------------------------------------------------------

import { colord, extend } from 'colord';
import namesPlugin from 'colord/plugins/names';

extend([namesPlugin]);

/**
 * Every region in a design, with the key a fit would address it by.
 *
 * The key convention is the same one `regionKey` uses — an explicit `id`, or the
 * surface and index — but that lives in `src/fit.mjs`, which reads the
 * filesystem and so cannot come to the browser. Rather than let the browser
 * carry a second copy of the rule inline, it is written once here.
 */
export function eachRegion(design) {
  const out = [];
  for (const block of ['paint', 'surfaces']) {
    for (const [where, spec] of Object.entries(design?.[block] ?? {})) {
      (spec?.regions ?? []).forEach((region, index) => {
        out.push({
          block,
          where,
          index,
          region,
          surface: `${block}.${where}`,
          key: region.id ?? `${block}.${where}#${index}`,
        });
      });
    }
  }
  return out;
}

/**
 * Which option of a treatment names a colour.
 *
 * Taken from the treatment's own description where there is one, which is what
 * descriptions are for. Where a pack described nothing, `color` and `colors` are
 * assumed — every treatment in both shipped packs uses those names, so the guess
 * is right far more often than nothing would be, and being wrong costs an
 * over-count in a usage list rather than anything that renders.
 */
function colourFields(region, treatments) {
  const described = treatments?.get?.(region.treatment)?.options;
  if (!described) return ['color', 'colors'].filter((k) => region[k] !== undefined);
  return Object.entries(described)
    .filter(([, o]) => o.type === 'color' || o.type === 'colors')
    .map(([k]) => k);
}

/**
 * Palette name -> the things referring to it.
 *
 * `background` counts. It names a palette colour exactly as a region's `color`
 * does, and a surface whose background stopped resolving is the largest possible
 * version of this mistake.
 */
export function paletteUses(design, treatments) {
  const uses = new Map();
  const add = (name, by) => {
    if (typeof name !== 'string') return;
    if (!uses.has(name)) uses.set(name, []);
    // Once per thing that depends on the name, not once per mention of it. A
    // region may name `accent` in `color` and twice more in `colors`, and it is
    // still one region — counting mentions would tell somebody about to rename
    // it that four things depend on it when one does. `tokenUses` counts the
    // same way, and the two panels sit next to each other.
    if (!uses.get(name).includes(by)) uses.get(name).push(by);
  };

  for (const block of ['paint', 'surfaces']) {
    for (const [where, spec] of Object.entries(design?.[block] ?? {})) {
      if (spec?.background) add(spec.background, `${block}.${where} background`);
    }
  }
  for (const { region, key } of eachRegion(design)) {
    for (const field of colourFields(region, treatments)) {
      const v = region[field];
      if (Array.isArray(v)) v.forEach((x) => add(x, key));
      else add(v, key);
    }
  }
  return uses;
}

/**
 * Could a token by this name ever be substituted?
 *
 * `renderTexture` interpolates `opts.text` through `/\{(\w+)\}/g`, so a token
 * called `driver-name` is unreachable: `{driver-name}` does not match, the brace
 * survives into the SVG, and the design renders the literal text `{driver-name}`
 * across the door. Nothing anywhere reports that — not the renderer, which sees
 * ordinary text, and not the dangling panel, which would list the token as
 * defined and used and be wrong on both counts.
 *
 * So the editor refuses the name at the point it is typed, which is the only
 * moment anybody can still cheaply pick a different one. `test/uses.test.mjs`
 * takes the pattern out of `src/render.mjs` and checks the two agree, because
 * this file cannot import it — the browser loads it directly.
 */
export function interpolates(token) {
  return /^\w+$/.test(token);
}

/**
 * Identity token -> the regions interpolating it.
 *
 * Only `text` is scanned, because only `text` is interpolated: `renderTexture`
 * substitutes `{word}` in `opts.text` and nowhere else. A `{driver}` written into
 * any other option is a literal brace and would be a lie to report.
 */
export function tokenUses(design) {
  const uses = new Map();
  for (const { region, key } of eachRegion(design)) {
    if (typeof region.text !== 'string') continue;
    for (const [, token] of region.text.matchAll(/\{(\w+)\}/g)) {
      if (!uses.has(token)) uses.set(token, []);
      if (!uses.get(token).includes(key)) uses.get(token).push(key);
    }
  }
  return uses;
}

/**
 * Names the design refers to that it does not define.
 *
 * Neither list is certainly a bug, and both are worth seeing. A colour name the
 * palette lacks is passed to the renderer as a literal — which is right if
 * somebody wrote `rebeccapurple` and wrong in a way nothing reports if they
 * meant a palette entry that has since been renamed. A token with no value
 * renders as nothing at all, which is never what anybody meant.
 */
export function danglingNames(design, treatments) {
  const palette = Object.keys(design?.palette ?? {});
  const identity = design?.identity ?? {};
  return {
    // A value the renderer can paint is nobody's business, whether it is
    // `#00F0FF` or `rebeccapurple`. Anything else that reached `ctx.color` and
    // is not in the palette went there as a literal and will paint nothing
    // anybody chose — which is what `gulf-bleu` looks like after a typo, and
    // what `accent` looks like after a rename that missed a region.
    colours: [...paletteUses(design, treatments)]
      .filter(([name]) => !palette.includes(name) && !isAColour(name))
      .map(([name, by]) => ({ name, by })),
    // A token with no value renders as nothing at all — the region stays, and
    // the text it was part of comes out short.
    tokens: [...tokenUses(design)]
      .filter(([token]) => identity[token] === undefined || identity[token] === '')
      .map(([token, by]) => ({ token, by })),
  };
}

/**
 * Is this a colour, or a name that failed to resolve?
 *
 * The question the whole dangling panel turns on, and it used to be answered by
 * a regex that accepted `#`, `rgb`, `hsl` and gave up: `red` was reported as an
 * unresolved name, `rebeccapurple` likewise, and `gulf-bleu` and `#00F0FF` were
 * told apart by their first character. The reason given was that the honest
 * alternative meant maintaining a table of 148 CSS colour names against a spec.
 * It did, right up until the moment we stopped refusing to have a dependency:
 * `colord` parses strictly to the CSS Color specification, in 8 KB with nothing
 * underneath it.
 *
 * The three additions are SVG paint values rather than colours, which is why
 * colord rightly declines them and why the renderer nevertheless accepts them.
 * `var(--x)` is a custom property, which resolves to whatever the document says
 * and cannot be judged from here.
 */
const SVG_PAINT = new Set(['none', 'currentcolor', 'inherit']);

export function isAColour(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (SVG_PAINT.has(s.toLowerCase()) || /^var\(/i.test(s)) return true;
  return colord(s).isValid();
}
