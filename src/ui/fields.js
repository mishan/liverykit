// ---------------------------------------------------------------------------
// Which parts of a region are placement, and which are the treatment's.
//
// A region is one flat object — `{ id, treatment, panel, at, color, cell }` —
// with a fixed, small structural half and a tail of whatever its treatment
// reads. Both the server and the browser need to make that split, and they must
// make it the SAME way: the server decides what to send as a region's options,
// and the inspector decides which of them to show a control for. Two lists would
// drift, and the symptom would be a control that edits a field nobody reads, or
// an option that never appears.
//
// So there is one list, in a file with no imports, which the browser can load
// beside `app.js` and Node can import directly.
// ---------------------------------------------------------------------------

/**
 * Fields that say WHERE a region goes rather than what it is.
 *
 * `scale` is deliberately absent: `text` and `radialText` both read it as an
 * option, and a fit may also override it — the same field genuinely means the
 * same thing to both, so it belongs with the treatment's own.
 */
export const STRUCTURAL = new Set([
  'id', 'treatment', 'panel', 'tags', 'limit', 'at', 'rotate', 'safe', 'once', 'drop',
]);

/**
 * The part of a region that belongs to its treatment.
 *
 * `__`-prefixed keys are excluded because they are nobody's: `applyFit` stamps
 * `__key` onto the regions it returns so everything downstream can name one, and
 * a bookkeeping field surfacing in the editor as an editable option would be a
 * control that writes a field the renderer ignores.
 */
export function treatmentOptions(region) {
  return Object.fromEntries(
    Object.entries(region).filter(([k]) => !STRUCTURAL.has(k) && !k.startsWith('__')));
}
