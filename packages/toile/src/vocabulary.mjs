/**
 * The terms a design may paint by — `body`, `rims` — rather than by a
 * texture's own name, and what is known about each.
 *
 * A game supplies them, because what a car is made of is a fact about the
 * game: which terms exist, which live in a model other than the car's own,
 * what to say when a profile has not bound one, and which can be named from
 * file names alone. Assetto Corsa's are in liverykit's src/engine/classify.mjs, with the
 * classifier that proposes them.
 *
 * With none in use, a design paints texture roles by name under `paint`, and
 * a profile that binds terms is refused rather than half understood.
 *
 *   terms          { [term]: { describes, ... } }
 *   elsewhere      Set of terms drawn by another model, which a car's own
 *                  model is expected never to reference
 *   unbound(term, profile)   what to tell a person whose profile has not bound it
 *   unverified(term, file)   ...whose binding names a file the model never draws
 *   named(term, roles)       ...whose binding was proposed from file names alone
 *   nameFromFiles(textures)  bindings that file names alone are evidence for
 */
let current = null;

/**
 * Put a vocabulary in use, or none with null. Returns the one it replaced.
 * Checked whole here, because a missing piece would otherwise surface as a
 * TypeError the first time a profile happened to need it, which the callers
 * that degrade to "unresolvable" would turn into a surface quietly not painted.
 */
export function useVocabulary(v) {
  if (v !== null) {
    const missing = [
      (typeof v?.terms !== 'object' || v.terms === null) && 'terms',
      !(v?.elsewhere instanceof Set) && 'elsewhere (a Set)',
      ...['unbound', 'unverified', 'named', 'nameFromFiles'].filter((k) => typeof v?.[k] !== 'function'),
    ].filter(Boolean);
    if (missing.length) throw new Error(`a vocabulary needs ${missing.join(', ')}`);
  }
  const was = current;
  current = v;
  return was;
}

/** The vocabulary in use, or null. */
export const vocabulary = () => current;
