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

export function definePack(name, treatments) {
  if (!name) throw new Error('definePack needs a name');
  for (const [key, fn] of Object.entries(treatments)) {
    if (typeof fn !== 'function') throw new Error(`Treatment "${name}.${key}" is not a function`);
  }
  return { name, treatments };
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
      table.set(key, { fn, pack: name });
    }
  }
  return table;
}
