// ---------------------------------------------------------------------------
// What a design's `hide` list can actually do on a given car.
//
// Its own module rather than a corner of the build, because two callers need
// the same answer and they must not each have their own. The build ships the
// files; `fitment.mjs` decides which of its findings a hide has silenced. A
// hide that cannot work silences nothing, and a checker that assumed otherwise
// would go quiet about a part the game still draws.
// ---------------------------------------------------------------------------

import { blends } from './engine/kn5.mjs';
import { isPngTexture } from './engine/pipeline.mjs';
import { resolveTargets } from './profile.mjs';

/**
 * What to do about each role the design says to `hide`.
 *
 * `hide` used to reach the editor's whole-car view and nothing else: the build
 * wrote no file for a hidden role, so in the game the part kept its stock
 * artwork. On the car this was built against nobody noticed, because that
 * car's own CSP config hides every number plate mesh already — which is a
 * fact about one car, not a property of the feature.
 *
 * The honest tool is a transparent texture, and it only works when the
 * material composites alpha. So this is a decision per role, and every branch
 * is reported, because the one that would be silent — a transparent file for
 * an opaque shader, encoded without complaint — is a part that still shows.
 *
 *   ship-transparent  alpha-blended material: ship a clear sheet
 *   car-hides         a clear sheet would not work, but the car's config hides
 *                     every mesh wearing it, so under CSP nothing shows anyway
 *   cannot            an opaque shader; the game will show it
 *   painted           the design also paints it, and painting wins
 *   absent            this car has no such role — designs travel, so not an error
 *
 * The car's own config used to settle it: `hiddenByCar` meant ship nothing.
 * Then the NSX's plate turned up on screen wearing an old build's artwork,
 * with the car config's HIDE sitting right there. A car config is applied by
 * the game with Custom Shaders Patch, and by nothing else — the Content
 * Manager showroom does not read MODEL_REPLACEMENT, and a skin is looked at
 * in the showroom at least as often as on the track. A transparent sheet is
 * honoured by whatever draws the mesh. So where one will work it is shipped
 * regardless, and `hiddenByCar` only decides what to say when one will not.
 *
 * The shader question is asked of PNG textures too. It used to be skipped for
 * them — a `.png` went straight to `ship-transparent` — on the unspoken theory
 * that a PNG is the format used for things that composite. The format has
 * nothing to say about it: what composites is the MATERIAL, and a fully
 * transparent sheet drawn by a shader that ignores alpha is a solid black
 * part. Black, and reported as hidden, is the worst of the outcomes here.
 *
 * `paintedRoles` is every role the build will actually paint. The design's
 * `paint` keys are only half of that list: `surfaces` names vocabulary terms
 * that the profile's bind table turns into roles, so a design painting
 * `surfaces.plate` and hiding `plate` looked, from `paint` alone, like a hide
 * with no paint anywhere near it. The build then rendered the artwork and the
 * hide loop overwrote it with a clear sheet — the design's own artwork,
 * deleted between one line of the build log and the next.
 *
 * Pure, so a test can ask about every branch without ImageMagick in the room.
 */
export function hidePlan(profile, livery, { paintedRoles = null } = {}) {
  if (!Array.isArray(livery.hide)) return [];
  const painted = paintedRoles ?? paintedFrom(profile, livery);
  return livery.hide.map((role) => {
    const tex = profile.textures?.[role];
    if (!tex) return { role, action: 'absent', why: `${role}: this car has no texture by that role` };
    const base = { role, file: tex.file, width: tex.width, height: tex.height };
    if (painted.has(role)) {
      return { ...base, action: 'painted', why: `${role} is both painted and hidden by this design; painting wins` };
    }
    const also = tex.hiddenByCar ? ` (the car's own config hides the mesh too, where that config is applied)` : '';
    const cannot = (why) => (tex.hiddenByCar
      ? { ...base, action: 'car-hides',
          why: `${role}: ${why}; the car's own config hides every mesh wearing ${tex.file}, which is what will hide it in the game` }
      : { ...base, action: 'cannot', why: `${role}: ${why}, so the game will show it` });
    // No size check: the sheet is not shipped at the texture's size (see
    // CLEAR_SHEET), so an odd-sized original is no obstacle.
    // Unknown shaders — a profile from before this was recorded — are treated
    // as opaque. Wrong in the cheaper direction: a needless warning, rather
    // than a file that claims to hide something and does not.
    const opaque = (tex.shaders ?? ['(shader not recorded — regenerate the profile)']).filter((s) => !blends(s));
    if (opaque.length) {
      return cannot(`${tex.file} is drawn by ${opaque.join(', ')}, which ignores alpha — a transparent texture would not hide it`);
    }
    return { ...base, action: 'ship-transparent', why: `${role}: ${tex.file} shipped fully transparent${also}` };
  });
}

/** Whether a hide REMOVES the surface from what the game draws. */
export const hideTakesEffect = (action) => action === 'ship-transparent' || action === 'car-hides';

/**
 * Every role this design paints, `surfaces` included.
 *
 * The build knows this already and passes it in; this is for callers holding
 * nothing but a design and a profile. A design that cannot be resolved at all
 * throws from `resolveTargets`, and that is not this function's news to break
 * — the caller is about to hear it from the build or the fitment check — so
 * the literal paint keys stand in until it does.
 */
function paintedFrom(profile, livery) {
  try {
    const { targets } = resolveTargets(profile, livery);
    return new Set(targets.map((t) => t.role));
  } catch {
    return new Set(Object.keys(livery.paint ?? {}));
  }
}
