// ---------------------------------------------------------------------------
// Region list + car profile -> two SVG layers.
//
// Everything a livery declares for one texture is walked in order, each region
// resolved from panel-relative to absolute coordinates against the car profile,
// then handed to its treatment. Treatments return { base, emissive }; the two
// accumulate into separate documents because glow has to happen at raster time.
// (librsvg ignores SVG <filter> entirely — feGaussianBlur renders as nothing —
// so the emissive layer is rendered on its own, blurred, and screened back on.)
// ---------------------------------------------------------------------------

import { resolveRect, texture, expandRegions, spanPlacements } from './profile.mjs';
import { r2 } from './engine/rng.mjs';

const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * What an identity token looks like inside a region's `text`.
 *
 * Named rather than written inline where it is used, because the editor has to
 * know the same rule — a token called `driver-name` can never be substituted, so
 * `{driver-name}` would be painted on the door as itself — and `src/ui/uses.js`
 * cannot import from here, since the browser loads that file directly. The test
 * lifts this constant out of the source and checks the two agree, so this has to
 * stay findable: a regex spelled out at the call site was, until moving the call
 * one line hid it and the check quietly stopped comparing anything.
 */
export const TOKEN = /\{(\w+)\}/g;

/**
 * A value from a livery, made safe to put in a document.
 *
 * A treatment builds markup by interpolation — `fill="${color}"` — which is the
 * whole reason the pack API is pleasant to write against, and it means every
 * value a livery supplies is one quotation mark away from being STRUCTURE rather
 * than content. A palette entry of
 *
 *   x"/><image href="q" onerror="…"/><rect fill="x
 *
 * closed the attribute, closed the element, and added two of its own. In the
 * editor — which sets the finished document as `innerHTML` — the handler ran. A
 * livery is a file people download from each other, and the editor is served by
 * a local server that writes files, so that was a real way to lose.
 *
 * Escaped HERE, on the way in, rather than at each of the 39 places a value
 * reaches markup. Those places are spread across two shipped packs and every
 * pack anybody writes later, `--pack ./my-pack.mjs` included, and a rule that
 * needs remembering at 39 sites is a rule that will be missed at one. Doing it
 * at the boundary means a treatment cannot get this wrong, including one written
 * by somebody who never read this comment.
 *
 * The five entities are resolved by any XML parser back to the characters they
 * stand for, and identically in an attribute and in a text node — so this
 * changes what a value can DO and not what it means. A colour with a quote in it
 * was never a colour.
 */
export function safe(v) {
  return String(v).replace(/[&<>"']/g, (c) => ENTITY[c]);
}

/** The same, through a livery's options: strings only, so numbers stay numbers. */
function safeDeep(v) {
  if (typeof v === 'string') return safe(v);
  if (Array.isArray(v)) return v.map(safeDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeDeep(x)]));
  }
  // Numbers and booleans through untouched: `cell` is arithmetic, and a
  // treatment multiplying by a string would be a strange way to find that out.
  return v;
}

/**
 * Resolve a colour reference. Palette keys win over raw values, so a livery can
 * say `color: 'accent'` and stay renamable, while `color: '#FF00E5'` still works
 * for one-offs.
 *
 * The result is escaped, because every caller interpolates it into an attribute
 * — that is what a colour resolver is FOR — and `palette[name] ?? name` passes
 * an unknown name straight through, so the livery's own text reaches the
 * document either way.
 */
export function makeColorResolver(palette) {
  return (nameOrValue) => {
    if (typeof nameOrValue !== 'string') return safe(String(nameOrValue));
    return safe(palette[nameOrValue] ?? nameOrValue);
  };
}

export function renderTexture({ profile, role, regions, background, treatments, palette, rng, font, tokens, regionNotes = [] }) {
  const tex = texture(profile, role);
  const { width, height } = tex;

  const color = makeColorResolver(palette);
  // Once, not per region: the palette and the identity block are the same for
  // every region on the surface, and a design with 200 of them would otherwise
  // walk both 200 times to arrive at the same answer.
  const safePalette = safeDeep(palette ?? {});
  const safeTokens = safeDeep(tokens ?? {});
  const base = [`<rect width="${width}" height="${height}" fill="${color(background ?? 'black')}"/>`];
  const emissive = [];

  // A region selecting panels by TAG becomes one region per matching panel, so
  // the same design covers however many islands this car splits its flank into.
  const expanded = expandRegions(profile, role, regions ?? []);
  regionNotes.push(...expanded.notes);

  // Where the words are, as fractions of the whole sheet, before anything is
  // drawn. The emissive layer composites above the base, so decoration that
  // scatters itself — sparkles — lands on top of lettering unless it is told
  // where the lettering is. `avoid` says so by hand, in texture fractions,
  // per name per car, and the first time nobody wrote it a sparkle sat on the
  // driver's name. The renderer knows every text rectangle already; handing
  // the list over costs nothing and removes a chore that was only ever going
  // to be forgotten.
  //
  // Text and arc text, plus anything a design marked keepClear — the same
  // declaration the fitment check honours, and a region that asks artwork to
  // stay off it has said all it needs to.
  const lettering = expanded.regions
    .filter((r) => r.treatment === 'text' || r.treatment === 'radialText' || r.constraints?.keepClear)
    .flatMap((r) => {
      const f = resolveRect(profile, role, r);
      // A spanning name is on every panel it reaches, not only its home.
      if (r.span === true && f.panel) return spanPlacements(profile, role, r.panel, f).map((p) => p.on);
      return [{ x: f.x, y: f.y, w: f.w, h: f.h }];
    });

  // Clip paths for spanning regions, one per (region, panel), collected
  // here and written into <defs> of both documents.
  const clips = [];

  for (const region of expanded.regions) {
    const entry = treatments.get(region.treatment);
    if (!entry) {
      throw new Error(
        `Unknown treatment "${region.treatment}" on ${tex.file}.\n` +
        `  Available: ${[...treatments.keys()].sort().join(', ')}\n` +
        `  If it comes from a pack, add that pack to the livery's "packs" list.`
      );
    }

    const frac = resolveRect(profile, role, region);
    const r = {
      x: frac.x * width,
      y: frac.y * height,
      w: frac.w * width,
      h: frac.h * height,
      // Carried through so `text` can pre-compensate for stretched UV without
      // the livery author having to know about it.
      anisotropy: frac.anisotropy,
    };

    // Everything a livery said, made safe to interpolate into an attribute —
    // EXCEPT `text`, which is the one option that is content rather than a
    // parameter. It goes between the tags rather than inside them, where a
    // different escaping applies, and `radialText` renders it one character at
    // a time around a circle: pre-escaping would spell `&quot;` out in five
    // glyphs on the side of the car. Its two emitters escape it for the text
    // node they put it in, and `test/injection.test.mjs` pushes markup through
    // this field as well, so a treatment that ever puts `text` in an attribute
    // instead is caught rather than trusted.
    const opts = safeDeep({ ...region, text: undefined });
    if (typeof region.text === 'string') {
      opts.text = region.text.replace(TOKEN, (_, k) => tokens[k] ?? '');
    } else if (region.text !== undefined) {
      opts.text = region.text;
    } else {
      delete opts.text;
    }

    // `rotate` turns a treatment through a quarter turn (or any angle) about the
    // region's centre. Needed because motifs have a built-in grain — traces run
    // in horizontal lanes, piping in horizontal lines — and a panel's grain is
    // whatever the unwrapper chose. Seatbelt straps, for instance, run DOWN the
    // texture, so horizontal lanes cross them like rungs instead of following
    // them.
    //
    // The rect the author writes is the FINAL one. For a quarter turn the
    // treatment is handed that rect with its width and height swapped about the
    // same centre, so rotating the result lands exactly where they asked.
    // `rotate: 'auto'` means "however far this panel is from upright". An
    // unwrapper is free to lay a door sideways to pack the sheet, and a road car
    // routinely does: the Abarth's doors measure 270 and 90 degrees while the
    // formula car's flanks measure 0. Text placed without this reads vertically,
    // which looks like a bug and is really the texture being honest about its
    // own layout.
    //
    // A panel with no measurement — anything near-horizontal, where "up" on the
    // surface is meaningless — resolves to 0 rather than to a number derived
    // from rounding error.
    const asked = region.rotate === 'auto'
      ? (frac.panel?.textRotation ?? 0)
      : region.rotate;
    if (asked !== undefined && !Number.isFinite(asked)) {
      // A non-finite angle poisons every coordinate downstream, and an SVG
      // carrying rotate(NaN,...) draws nothing at all — silently, which is the
      // exact failure this library exists to prevent. `rotate: '90deg'` is the
      // obvious way to arrive here.
      throw new Error(
        `"${region.treatment ?? 'region'}" on ${tex.file} has rotate: ` +
        `${JSON.stringify(region.rotate)}. It must be a finite number of degrees ` +
        `(e.g. rotate: 90), or 'auto' to follow the panel's own orientation.`
      );
    }
    const rot = (((asked ?? 0) % 360) + 360) % 360;
    const quarter = rot === 90 || rot === 270;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const drawn = quarter
      ? { ...r, x: cx - r.h / 2, y: cy - r.w / 2, w: r.h, h: r.w }
      : r;

    // `palette` and `tokens` go over escaped too, not raw. No treatment in
    // either shipped pack reads them — they all go through `ctx.color` — which
    // is exactly why handing them over unescaped was worth closing rather than
    // documenting: the trap would have been sprung by the first pack author to
    // write `fill="${c.palette.accent}"`, reasonably, having been told the
    // values they are given are safe. A rule with an unmarked exception in it
    // is not a rule anybody can follow.
    // `panel` is the resolved panel this region landed on, measurements and
    // all, for a treatment that draws differently depending on what it is
    // on — `band` reads the wheel measurement. Null for an absolute region.
    const out = entry.fn(drawn,
      { palette: safePalette, color, rng, font, opts, width, height, tokens: safeTokens, lettering, panel: frac.panel ?? null });
    const spin = (svg) => (rot === 0 || !svg ? svg
      : `<g transform="rotate(${r2(rot)},${r2(cx)},${r2(cy)})">${svg}</g>`);

    // A spanning region is drawn ONCE, above, in its home panel's frame, and
    // then placed on every panel it reaches under that panel's seam map —
    // the same artwork, so a stripe's edge and a word's letters continue
    // across the seam rather than being re-rolled on the far side. Each copy
    // is clipped to its panel's rectangle, including the home copy: the part
    // of the rectangle past the home panel's edge is texture that belongs to
    // some other island, or to nobody, and painting it there would put a
    // stray band on whatever the unwrapper packed alongside.
    //
    // Maps are in fractions; SVG wants texels. u' = a u + c v + e becomes
    // x' = a x + (c W/H) y + e W, and likewise for y.
    if (region.span === true && frac.panel) {
      const placed = spanPlacements(profile, role, region.panel, frac);
      placed.forEach((p, k) => {
        const [a, b, c, d, e, f] = p.matrix;
        const m = [a, (b * height) / width, (c * width) / height, d, e * width, f * height].map(r2);
        // Clipped to the island's OUTLINE where the profile has one, and to
        // its box otherwise. Islands are not boxes: unwrappers pack a small
        // island into the concave corner of a big one, and a copy clipped to
        // the box paints texels that belong to the neighbour.
        const pan = profile.panels[role][p.panel];
        const id = `lk-span-${base.length}-${emissive.length}-${k}`;
        if (Array.isArray(pan.outline) && pan.outline.length >= 3) {
          const pts = pan.outline.map(([u, v]) => `${r2(u * width)},${r2(v * height)}`).join(' ');
          clips.push(`<clipPath id="${id}"><polygon points="${pts}"/></clipPath>`);
        } else {
          const [px, py, pw, ph] = pan.rect;
          clips.push(`<clipPath id="${id}"><rect x="${r2(px * width)}" y="${r2(py * height)}" ` +
            `width="${r2(pw * width)}" height="${r2(ph * height)}"/></clipPath>`);
        }
        // Two groups, not one: a clip-path on an element is evaluated in that
        // element's OWN coordinate system, transform included, so putting
        // both on one <g> would carry the clip rectangle along with the
        // artwork and clip to the wrong place on every panel but the home.
        const place = (svg) =>
          `<g clip-path="url(#${id})"><g transform="matrix(${m.join(' ')})">${spin(svg)}</g></g>`;
        if (out.base) base.push(place(out.base));
        if (out.emissive) emissive.push(place(out.emissive));
      });
      continue;
    }

    if (out.base) base.push(spin(out.base));
    if (out.emissive) emissive.push(spin(out.emissive));
  }

  const defs = clips.length ? `<defs>${clips.join('')}</defs>` : '';
  const doc = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` + defs + body + '</svg>';

  return {
    base: doc(base.join('')),
    // The emissive layer sits on transparency so it can be blurred into a glow.
    emissive: doc(emissive.join('')),
    hasEmissive: emissive.length > 0,
    width,
    height,
    file: tex.file,
    alpha: tex.alpha ?? false,
  };
}

/**
 * The two layers flattened into one document, for looking at.
 *
 * The build never needs this: `composeLayers` rasterises the layers separately
 * and does the glow with a real blur, because librsvg ignores SVG `<filter>`
 * entirely. But the EDITOR only ever showed `base`, and several treatments draw
 * nothing there at all — `traces` and `sparkles` are emissive-only always, and
 * `piping`, `ring`, `text` and `radialText` move there entirely under
 * `glow: true`. Those elements were being painted correctly and were invisible
 * in every view of the editor, which is this project's oldest failure wearing
 * the newest possible costume: the artwork is on the car, and the tool for
 * looking at the car says there is nothing there.
 *
 * A browser is not librsvg and does support filters, so the preview can do what
 * the build does — blurred emissive screened on twice, then the crisp emissive
 * over the top. It is an approximation of a raster blur rather than the same
 * arithmetic, and it is a preview; being a few percent off is not the failure
 * mode that matters here, and being absent is.
 */
export function previewSvg({ base, emissive, hasEmissive, width, height }, { glowSigma = 14 } = {}) {
  if (!hasEmissive) return base;

  // The same scaling the build applies, so a 4K render and a 2K one glow by the
  // same amount relative to the car rather than by the same number of pixels.
  const sigma = r2(glowSigma * (Math.max(width, height) / 2048));
  const body = (doc) => doc.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

  // The emissive layer appears three times, and is WRITTEN once. Two reasons,
  // and the second is the one that would have hurt.
  //
  // It is sent on every frame of a drag, and the emissive layer of a design
  // built around glow is most of the document — copying it out three times
  // meant three times the markup to serialise, ship and parse for a picture
  // that has one layer's worth of content in it.
  //
  // And repeating markup repeats any `id` inside it. No treatment emits one
  // today, but a gradient or a clip path is the obvious next thing a treatment
  // would want, and three copies of `id="g1"` in one document is a duplicate id
  // — every `url(#g1)` resolves to the first copy, inside the blurred pass, so
  // the crisp layer on top would quietly take the blurred one's paint. Defining
  // it once and referring to it is not an optimisation of that; it is the only
  // version that stays correct.
  const glow = '<use href="#lk-emissive" filter="url(#lk-glow)" style="mix-blend-mode:screen"/>';

  return base.replace(/<\/svg>$/,
    `<defs><filter id="lk-glow" x="-25%" y="-25%" width="150%" height="150%">` +
    `<feGaussianBlur stdDeviation="${sigma}"/></filter>` +
    `<g id="lk-emissive">${body(emissive)}</g></defs>` +
    // Twice, then crisp on top: composeLayers screens the blur in two passes
    // because one is not enough to lift a thin line off a dark base.
    glow + glow + '<use href="#lk-emissive"/></svg>');
}
