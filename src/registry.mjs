// ---------------------------------------------------------------------------
// Treatment registry.
//
// A "treatment" turns a rectangle plus some options into SVG. That mechanism is
// generic; the art is not. Circuit traces and synthwave horizon grids are a
// specific aesthetic, and baking them into the core would make every user of
// this library fight an opinion they didn't ask for.
//
// So treatments ship in packs. `core` holds the primitives any livery needs —
// fills, stripes, text, halftones. `synthwave` holds the opinionated ones. A
// livery declares which packs it wants, and anyone can register their own
// without forking:
//
//     import { definePack, registerPack } from 'liverykit';
//
//     registerPack(definePack('my-team', {
//       chevron: (rect, ctx) => ({
//         base: `<path d="..." fill="${ctx.color('accent')}"/>`,
//         emissive: '',
//       }),
//     }));
//
// A treatment returns `{ base, emissive }`. Anything in `emissive` gets the
// glow pass at raster time — librsvg ignores SVG <filter> entirely, so glow
// cannot be done in the SVG itself and has to be a separate layer.
// ---------------------------------------------------------------------------

const packs = new Map();

/** Option kinds a schema may declare. Anything else is an error in the pack. */
const OPTION_TYPES = new Set(['string', 'number', 'boolean', 'color', 'colors', 'enum', 'rects']);

/**
 * Describe what a treatment takes, so a tool can offer controls for it.
 *
 * Optional, and the build never reads it. A treatment is a function that reads
 * whatever it likes off `ctx.opts`, and that stays true — this is metadata for
 * anything trying to present the treatment to a person, which today is the
 * fitting editor and tomorrow might be documentation. A pack that describes
 * nothing works exactly as before; its treatments simply get a raw JSON field
 * instead of controls.
 *
 * `hint` is the code's own default, WRITTEN OUT for a human to read. It is a
 * string on purpose. If it held the real value it would be a second source of
 * truth for defaults, free to drift from the `?? 0.42` in the function — and
 * this project's whole disposition is that two copies of one fact drift
 * silently. A tool shows it as placeholder text and writes nothing.
 */
export function definePack(name, treatments, describe = {}) {
  if (!name) throw new Error('definePack needs a name');
  for (const [key, fn] of Object.entries(treatments)) {
    if (typeof fn !== 'function') throw new Error(`Treatment "${name}.${key}" is not a function`);
  }

  for (const [key, spec] of Object.entries(describe)) {
    // A description of something that does not exist is a typo, and a silent one
    // — the treatment it was meant for would just show no controls.
    if (!treatments[key]) {
      throw new Error(
        `Pack "${name}" describes a treatment "${key}" it does not define. ` +
        `Defined: ${Object.keys(treatments).join(', ')}`
      );
    }
    for (const [opt, o] of Object.entries(spec.options ?? {})) {
      if (!OPTION_TYPES.has(o?.type)) {
        throw new Error(
          `Pack "${name}", treatment "${key}", option "${opt}": type ` +
          `${JSON.stringify(o?.type)} is not one of ${[...OPTION_TYPES].join(', ')}`
        );
      }
      if (o.type === 'enum' && !Array.isArray(o.values)) {
        throw new Error(`Pack "${name}", treatment "${key}", option "${opt}": an enum needs "values"`);
      }
    }
  }

  return { name, treatments, describe };
}

/**
 * Registering the same pack object twice is a no-op — module caching makes that
 * happen naturally and it isn't a mistake. Registering a *different* pack under
 * a name already taken is refused unless you say `{ overwrite: true }`, since
 * silently shadowing someone else's treatments produces a livery that renders
 * fine and looks wrong.
 */
export function registerPack(pack, { overwrite = false } = {}) {
  const existing = packs.get(pack.name);
  if (existing === pack) return pack;
  if (existing && !overwrite) {
    throw new Error(
      `Pack "${pack.name}" is already registered.\n` +
      `  Pass { overwrite: true } to replace it, or pick another name.`
    );
  }
  packs.set(pack.name, pack);
  return pack;
}

/** Mostly for tests, and for swapping a pack out at runtime. */
export function unregisterPack(name) {
  return packs.delete(name);
}

export function getPack(name) {
  const p = packs.get(name);
  if (!p) {
    throw new Error(
      `Unknown pack "${name}". Registered: ${[...packs.keys()].join(', ') || '(none)'}\n` +
      `  Packs must be registered before the livery that uses them is built.`
    );
  }
  return p;
}

export const listPacks = () => [...packs.keys()];

/**
 * Flatten the requested packs into one treatment table.
 *
 * Later packs win on collision, but noisily — a silently shadowed treatment is
 * a genuinely confusing bug to chase, since the livery still renders, just not
 * the way it reads.
 */
export function resolveTreatments(packNames = ['core']) {
  const table = new Map();
  for (const name of packNames) {
    for (const [key, fn] of Object.entries(getPack(name).treatments)) {
      if (table.has(key)) {
        console.warn(`  ! Pack "${name}" overrides treatment "${key}" from "${table.get(key).pack}"`);
      }
      table.set(key, { fn, pack: name, describe: getPack(name).describe?.[key] ?? null });
    }
  }
  return table;
}
