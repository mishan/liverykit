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
import { piecesInView, pieceTriangles, onMeshShare, SHEET_VIEWS } from './engine/shot.mjs';

/** Below this many pixels a view shows too little of a piece to count. */
const TOO_FEW_PX = 30;

/** A view showing a piece at least this share of its home view's pixels is judged too. */
const COMPARABLE = 0.5;

/** Seen whole, allowing a pixel or two along an edge. */
export const WHOLE = 0.99;

/**
 * Text that declares no minVisible is still worth a word when a fifth of its
 * letters are hidden in the view that shows it best — low, since nothing asked.
 */
const TEXT_FLOOR = 0.8;

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Each whole piece, measured in each view, judged by its HOME view, the one
 * that shows the most of it, and by any other that shows it nearly as large
 * (see COMPARABLE). A door roundel's home is the side view, a bonnet roundel's
 * the top. Not by every view: half of it hidden from the front, by the car's
 * own nose, is how cars are.
 *
 * `geometry` is `wholeModelGeometry` for this design, and `sheets` the car's
 * own textures, for the parts whose alpha decides whether they stand in front.
 */
export function inView(design, profile, fit, geometry, sheets, { views = SHEET_VIEWS, width = 900, height = 540 } = {}) {
  const pieces = wholePieces(design, profile, fit);
  const findings = [];
  const measured = pieces.map((p) => ({
    id: p.id, role: p.role, surface: p.surface, panel: p.panel, what: p.what,
    home: null, visible: null, whole: null, onMesh: null, views: {},
  }));
  if (!pieces.length) return { views, measured, findings };

  // How much of each piece the car carries at all, which no view can say: a
  // view counts only the texels a triangle draws. A ring hanging off its
  // island was counted whole in every view, and the critic that called it cut
  // off at the panel edge was overruled for being right.
  const onMesh = pieces.map((p) => onMeshShare(geometry, p, pieceTriangles(geometry, geometry.groups, p)));

  const seen = pieces.map(() => []);
  for (const view of views) {
    piecesInView(geometry, geometry.groups, sheets, pieces, { view, width, height })
      .forEach((c, i) => { if (c.whole >= TOO_FEW_PX) seen[i].push({ view, ...c }); });
  }

  pieces.forEach((p, i) => {
    const m = measured[i];
    for (const s of seen[i]) m.views[s.view] = round(s.shown / s.whole);
    const carried = onMesh[i];
    if (carried !== null) m.onMesh = round(carried);
    const off = carried !== null && carried < WHOLE;
    if (off) {
      m.why = `only ${Math.round(carried * 100)}% of it is on the car: the rest is painted into texture space ` +
        'no triangle uses, so no view can show it';
    }
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
    // Judged in every view that shows it at least half as large as home does,
    // and held to the worst of them. Home alone missed mirrored bodywork: both
    // flanks show the same texels, and a mirror hiding the right-hand copy was
    // never judged while the left view was a few pixels larger. Half, from the
    // NSX: the views that merely glance at a piece, where the car's own shape
    // hides part of it, gave 27 to 43% of home's pixels (a door from the
    // three-quarter, top and rear-left views, the roof from the three-quarter),
    // and the ones that really show it 58 to 96% (the bonnet from the front,
    // the rear quarter from the rear-left), with a mirrored copy near 100%.
    const judged = seen[i].filter((s) => s.whole >= home.whole * COMPARABLE);
    const worst = judged.reduce((a, b) => (b.shown / b.whole < a.shown / a.whole ? b : a), home);
    const fraction = worst.shown / worst.whole;
    m.home = home.view;
    m.view = worst.view;
    m.visible = round(fraction);
    m.whole = fraction >= WHOLE && !off;
    // How big it is in the picture, as a share of the frame's width and height.
    m.size = [round(home.box[2]), round(home.box[3])];
    const by = worst.blockers[0] ?? null;
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
      view: worst.view, visible: m.visible,
      why: `${p.id} (${p.what}) is ${Math.round(fraction * 100)}% visible in the ${worst.view} view, ` +
        (worst === home ? 'the view that shows the most of it'
          : `which shows it nearly as large as the ${home.view} view does`) +
        `; the rest is behind ${behind}` +
        (p.minVisible !== null ? `, and it asked for minVisible ${p.minVisible}` : '') +
        '. Move it clear of what stands in front, or make it smaller.',
    });
  });
  return { views, measured, findings };
}
