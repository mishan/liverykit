/**
 * The constraints a design may put on a region, each with what it means.
 *
 * Read by the checker, which enforces them, and by the editor, which offers
 * them and refuses one nothing enforces. One list, so the two cannot drift
 * apart. It sits outside src/ui because the checker is not the editor's, and
 * the server hands the browser this file by name.
 */
export const CONSTRAINTS = {
  keepClear: 'boolean — nothing may be painted across this region, whatever the ' +
    'treatment. Without it the overlap check only speaks up for text on text, so a ' +
    'stripe drawn over a team name goes unmentioned.',
  minMm: 'number — the shortest side this must not go below ON THE CAR, in millimetres, ' +
    'replacing the global 25 mm floor. Applies to any treatment, not just text.',
  minOnCar: 'number 0-1 — the fraction of the box that must land on actual geometry. ' +
    'A background fill is meant to bleed off an island; a name is not.',
  minVisible: 'number 0-1 — the fraction of the box that must be seen from trackside, ' +
    'by the same ray casting as the visibility check, which otherwise only speaks up ' +
    'below 35%. A roundel tucked under a window frame is on the car and still cut off.',
  minMargin: 'number, mm — clean bodywork the box must have all round: with this much added ' +
    'on every side it must still be on the car and visible. Keeps a roundel off shut lines, ' +
    'window frames and arches.',
  groupWith: 'string, the id of another region — this one must be on the same panel as that ' +
    'one, as a team name belongs beside the race number. Checked only where a design declares ' +
    'it: a brief may want the name somewhere else.',
  stripe: 'string, a name for the stripe — this region is a piece of a stripe that runs along the ' +
    'car\'s length, and every region given the same name is another piece of the same stripe. Each ' +
    'piece must run along the car, not across it; neighboring pieces must line up where they meet, ' +
    'within 20 mm; and together they must cover the car nose to tail, over the rear wing where there ' +
    'is one, except where the car has glass, a vent, a grille or an opening. Checked only where a design ' +
    'declares it: a band across the car is a design choice too.',
};
