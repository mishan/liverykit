// ---------------------------------------------------------------------------
// How much of each number, word and roundel each view of the car shows.
//
// A critic looking at renders called a whole roundel "cut off" in four of the
// six cases a person had checked, and each time the planner believed it and
// made the design worse. The renders are this project's own, so whether a piece
// is whole in the left view is not a judgement: it is a count of pixels. This
// counts them, and says which pieces a view hides part of and what stands in
// the way.
//
// `fitment` casts from forty-nine directions and says how visible a piece is in
// general. This asks the narrower question a picture raises, of the views a
// critic is shown, and the two disagree for good reasons: a mirror hides part
// of a door from the front three-quarter and none of it from the side.
// ---------------------------------------------------------------------------

import { wholePieces } from './fitment.mjs';
import { piecesInView, SHEET_VIEWS } from './engine/shot.mjs';

/** Below this many pixels a view shows too little of a piece to count. */
const TOO_FEW_PX = 30;

/** Seen whole, allowing a pixel or two along an edge. */
export const WHOLE = 0.99;

/**
 * Text that declares no minVisible is still worth a word when a fifth of its
 * letters are hidden in the view that shows it best — low, since nothing asked.
 */
const TEXT_FLOOR = 0.8;

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Each whole piece, measured in each view, judged by its HOME view: the one
 * that shows the most of it. A door roundel's home is the side view, a bonnet
 * roundel's the top. Held to the home view because that is the picture in which
 * a person would call it whole or not; half of it hidden from the front, by the
 * car's own nose, is how cars are.
 *
 * `geometry` is `wholeModelGeometry` for this design, and `sheets` the car's
 * own textures, for the parts whose alpha decides whether they stand in front.
 */
export function inView(design, profile, fit, geometry, sheets, { views = SHEET_VIEWS, width = 900, height = 540 } = {}) {
  const pieces = wholePieces(design, profile, fit);
  const findings = [];
  const measured = pieces.map((p) => ({
    id: p.id, role: p.role, surface: p.surface, panel: p.panel, what: p.what,
    home: null, visible: null, whole: null, views: {},
  }));
  if (!pieces.length) return { views, measured, findings };

  const seen = pieces.map(() => []);
  for (const view of views) {
    piecesInView(geometry, geometry.groups, sheets, pieces, { view, width, height })
      .forEach((c, i) => { if (c.whole >= TOO_FEW_PX) seen[i].push({ view, ...c }); });
  }

  pieces.forEach((p, i) => {
    const m = measured[i];
    for (const s of seen[i]) m.views[s.view] = round(s.shown / s.whole);
    const home = seen[i].reduce((a, b) => (!a || b.whole > a.whole ? b : a), null);
    if (!home) {
      // Said, because a piece with a floor that nothing measured would
      // otherwise read as one that met it.
      if (p.minVisible !== null) {
        findings.push({
          kind: 'hidden-in-view', severity: 'low', surface: p.surface, role: p.role, panel: p.panel, ids: [p.id],
          why: `${p.id} shows fewer than ${TOO_FEW_PX} pixels in every view (${views.join(', ')}), so how much ` +
            'of it a picture of the car shows could not be counted',
        });
      }
      return;
    }
    const fraction = home.shown / home.whole;
    m.home = home.view;
    m.visible = round(fraction);
    m.whole = fraction >= WHOLE;
    // How big it is in the picture, as a share of the frame's width and height.
    m.size = [round(home.box[2]), round(home.box[3])];
    const by = home.blockers[0] ?? null;
    if (by) m.hiddenBy = by.mesh ?? by.sheet;

    const floor = p.minVisible !== null ? Math.min(p.minVisible, WHOLE) : (p.text !== null ? TEXT_FLOOR : null);
    if (floor === null || fraction >= floor) return;
    const same = by?.sheet === p.role;
    const behind = !by ? 'something else'
      : by.mesh ? `${by.mesh}${same ? ', a part painted from the same texture' : ` (which wears ${by.sheet})`}`
        : same ? `another part painted from the same ${p.role} texture` : by.sheet;
    findings.push({
      kind: 'hidden-in-view',
      severity: p.minVisible !== null ? 'high' : 'low',
      surface: p.surface, role: p.role, panel: p.panel, ids: [p.id],
      view: home.view, visible: m.visible,
      why: `${p.id} (${p.what}) is ${Math.round(fraction * 100)}% visible in the ${home.view} view, the view ` +
        `that shows the most of it; the rest is behind ${behind}` +
        (p.minVisible !== null ? `, and it asked for minVisible ${p.minVisible}` : '') +
        '. Move it clear of what stands in front, or make it smaller.',
    });
  });
  return { views, measured, findings };
}
