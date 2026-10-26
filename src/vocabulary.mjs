/**
 * The terms a design may paint by — `body`, `rims` — rather than by a
 * texture's own name, and what is known about each.
 *
 * A game supplies them, because what a car is made of is a fact about the
 * game: which terms exist, which live in a model other than the car's own,
 * what to say when a profile has not bound one, and which can be named from
 * file names alone. Assetto Corsa's are in src/engine/classify.mjs, with the
 * classifier that proposes them.
 *
 * With none in use, a design paints texture roles by name under `paint`, and
 * a profile that binds terms is refused rather than half understood.
 *
 *   terms          { [term]: { describes, ... } }
 *   elsewhere      Set of terms drawn by another model, which a car's own
 *                  model is expected never to reference
 *   unbound(term, profile)   what to tell a person whose profile has not bound it
 *   nameFromFiles(textures)  bindings that file names alone are evidence for
 */
let current = null;

/** Put a vocabulary in use, or none with null. Returns the one it replaced. */
export function useVocabulary(v) {
  const was = current;
  current = v;
  return was;
}

/** The vocabulary in use, or null. */
export const vocabulary = () => current;
