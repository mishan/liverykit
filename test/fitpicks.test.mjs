// ---------------------------------------------------------------------------
// Which panels the portable design's placed regions land on, pinned for the
// three shipped profiles and their fits.
//
// A fit adjusts a region by id, and most of what it adjusts is relative to
// whatever panel the region landed on: `team-left` on the Abarth moves the name
// within the panel `[left, mid, visible]` picks. Change the tagger so that the
// selection picks another panel, and the fit carries the name somewhere nobody
// chose while still reading perfectly well — the failure the note on `at` in
// AGENTS.md describes. CI compares output filenames and would not notice.
//
// A change here is not wrong in itself: a regenerated profile or a better
// tagger will move picks. It has to be looked at, and every fitted region that
// moved re-fitted by eye or given an explicit `panel`, before this is updated.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProfile, resolveTargets, expandRegions, resolveRect, panelName } from '../src/profile.mjs';
import { applyFit, allRegionKeys, regionKey } from '../src/fit.mjs';
import { tagProfile } from '../src/engine/tags.mjs';
import { loadLivery } from '../src/livery.mjs';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Region key -> sorted panels it lands on, for every region placed by tag or panel. */
async function picks(car) {
  const design = await loadLivery(at('liveries/neon-grid-any.mjs'));
  const profile = await loadProfile(at(`cars/${car}.json`));
  const fitPath = at(`fits/neon-grid-any@${car}.json`);
  const fit = existsSync(fitPath) ? JSON.parse(readFileSync(fitPath, 'utf8')) : null;
  const { targets } = resolveTargets(profile, design);
  const reserved = allRegionKeys(targets);
  const out = {};
  for (const { from, role, spec, primary } of targets) {
    // The build's own order: `once` first, then the fit, then the expansion.
    const regions = (spec.regions ?? []).filter((r) => !(r.once && !primary));
    const fitted = applyFit(regions, fit, { profile, role, surfaceKey: from, used: new Set(), notes: [], reserved }).regions;
    const { regions: expanded } = expandRegions(profile, role, fitted);
    fitted.forEach((r, i) => {
      if (r.tags === undefined && r.panel === undefined) return;
      const key = `${role} ${r.id ?? `#${(spec.regions ?? []).indexOf(regions[i])}`}`;
      const landed = expanded.filter((e) => (e.id !== undefined
        ? e.id === r.id
        : e.treatment === r.treatment && String(e.tags) === String(r.tags) && String(e.at) === String(r.at)));
      out[key] = [...new Set(landed.map((e) => e.panel))].sort();
    });
  }
  return out;
}

const PINNED = {
  abarth500: {
    'skinbase_default #3': ['left_front', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_rear', 'left_rear_lower'],
    'skinbase_default #4': ['right_front', 'right_mid', 'right_mid_lower', 'right_mid_upper', 'right_mid_upper_2', 'right_rear', 'right_rear_lower', 'right_tail_lower_2'],
    'skinbase_default #5': ['left_front_upper', 'left_mid_lower_2', 'left_mid_lower_3', 'left_tail', 'left_tail_lower'],
    'skinbase_default #6': ['centre_front_upper', 'centre_mid', 'centre_nose', 'centre_rear', 'centre_tail_lower', 'centre_tail_upper_4', 'left_front_upper', 'left_mid_lower_2', 'left_mid_lower_3', 'left_mid_upper', 'left_rear', 'left_rear_lower', 'right_mid_upper', 'right_mid_upper_2', 'right_rear', 'right_rear_lower'],
    'skinbase_default number-left': ['left_mid'],
    'skinbase_default number-right': ['right_mid'],
    'skinbase_default team-left': ['left_mid'],
    'skinbase_default team-right': ['right_mid'],
  },
  ac_friends_honda_nsx_gt3_evo: {
    'ext_skin_sponsors #3': ['left_front_upper', 'left_front_upper_3', 'left_front_upper_4', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_mid_upper_2', 'left_nose_lower', 'left_rear', 'left_rear_lower_3', 'left_rear_upper', 'left_tail_upper', 'left_tail_upper_3', 'left_tail_upper_4', 'left_tail_upper_5', 'left_tail_upper_6'],
    'ext_skin_sponsors #4': ['right_front_upper', 'right_front_upper_3', 'right_mid', 'right_mid_lower', 'right_nose_lower', 'right_rear', 'right_rear_lower_3', 'right_rear_upper', 'right_tail_upper', 'right_tail_upper_3', 'right_tail_upper_4', 'right_tail_upper_5', 'right_tail_upper_6'],
    'ext_skin_sponsors #5': [],
    'ext_skin_sponsors #6': ['centre_front', 'centre_front_upper', 'centre_mid', 'centre_rear', 'centre_tail_lower_2', 'centre_tail_lower_3', 'centre_tail_upper', 'centre_tail_upper_2', 'left_front_upper_3', 'left_front_upper_4', 'left_mid', 'left_mid_upper', 'left_mid_upper_2', 'left_rear', 'left_rear_lower_3', 'left_rear_upper', 'left_tail_upper', 'left_tail_upper_3', 'left_tail_upper_4', 'left_tail_upper_5', 'right_front_upper_3', 'right_mid', 'right_rear', 'right_rear_lower_3', 'right_rear_upper', 'right_tail_upper', 'right_tail_upper_3', 'right_tail_upper_4', 'right_tail_upper_5'],
    'ext_skin_sponsors driver-left': ['left_mid'],
    'ext_skin_sponsors driver-right': ['right_mid'],
    'ext_skin_sponsors number-left': ['left_rear'],
    'ext_skin_sponsors number-right': ['right_rear'],
    'ext_skin_sponsors team-left': ['left_mid'],
    'ext_skin_sponsors team-right': ['right_mid'],
  },
  rss_formula_rss_4: {
    'body #3': ['left_mid', 'left_mid_lower', 'left_mid_lower_2', 'left_mid_lower_3', 'left_mid_upper', 'left_mid_upper_2', 'left_mid_upper_3', 'left_mid_upper_4', 'left_nose', 'left_nose_lower'],
    'body #4': ['right_mid', 'right_mid_lower', 'right_mid_lower_2', 'right_mid_lower_3', 'right_mid_upper', 'right_mid_upper_2', 'right_mid_upper_3', 'right_mid_upper_4', 'right_nose', 'right_nose_lower'],
    'body #5': [],
    'body #6': ['centre_front', 'centre_front_upper', 'centre_mid_upper', 'centre_mid_upper_2', 'centre_mid_upper_3', 'centre_rear', 'centre_rear_lower', 'centre_tail', 'centre_tail_upper', 'left_mid_lower_2', 'left_mid_lower_3', 'left_mid_upper', 'left_mid_upper_2', 'left_mid_upper_3', 'right_mid_lower_2', 'right_mid_lower_3', 'right_mid_upper', 'right_mid_upper_2', 'right_mid_upper_3'],
    'body driver-left': ['left_mid_lower_2'],
    'body driver-right': ['right_mid_lower_2'],
    'body number-left': ['left_mid'],
    'body number-right': ['right_mid'],
    'body team-left': ['left_mid'],
    'body team-right': ['right_mid'],
    'bodyRear #3': ['left_mid_lower'],
    'bodyRear #4': ['right_mid_lower'],
    'bodyRear #5': [],
    'bodyRear #6': ['centre_front_upper'],
  },
};

for (const [car, pinned] of Object.entries(PINNED)) {
  test(`the portable design lands where it was fitted on ${car}`, async () => {
    assert.deepEqual(await picks(car), pinned,
      'a placed region now lands on different panels. Look at it on the car, re-fit it or give ' +
      'the fit an explicit panel, and only then update this snapshot.');
  });
}

// The snapshot above only catches a move on a profile it has seen. None of the
// shipped profiles carries `extent3d`, so it passed the extent tagger without
// ever meeting it, and regenerating the Abarth took `team-left` from the door
// to the rear quarter: the quarter is three times the door's size, newly
// reaches `mid`, and `limit` takes the biggest match. So a fitted placement on
// a `limit` selection names its panel, and this checks every shipped fit does.
test('a fit that places a region picked by `limit` names the panel it was fitted on', async () => {
  const unpinned = [];
  for (const file of readdirSync(at('fits')).filter((f) => f.endsWith('.json'))) {
    const fit = JSON.parse(readFileSync(at(`fits/${file}`), 'utf8'));
    const design = await loadLivery(at(`liveries/${fit.livery}.mjs`));
    const profile = await loadProfile(at(`cars/${fit.car}.json`));
    for (const { from, spec, primary } of resolveTargets(profile, design).targets) {
      (spec.regions ?? []).forEach((r, i) => {
        const o = fit.regions?.[regionKey(from, r, i)];
        if (r.once && !primary) return;
        if (!o || o.drop || r.tags === undefined || r.limit === undefined) return;
        if (o.panel === undefined) unpinned.push(`${file}: ${regionKey(from, r, i)}`);
      });
    }
  }
  assert.deepEqual(unpinned, [], 'these ride on whichever panel the selection picks today');
});

test('a pinned fit stays on its panel when a retag changes what `limit` picks', async () => {
  // A door in the middle of the car and a rear quarter three times its size
  // that reaches forward into `mid`. By centroid only the door is `mid`; by
  // extent the quarter is too, and `[left, mid]` with `limit: 1` goes to it.
  const car = (withExtent) => {
    const p = {
      id: 'c', calibration: { axes: { left: '+X', front: '+Z' } },
      textures: { body: { file: 'b.dds', width: 64, height: 64 } },
      aliases: { body: { doorLeft: 'door' } },
      panels: { body: {
        nose: { rect: [0.9, 0.9, 0.05, 0.05], centroid3d: [0, 1, 2] },
        tail: { rect: [0.9, 0.8, 0.05, 0.05], centroid3d: [0, 0, -2] },
        door: { rect: [0, 0, 0.2, 0.2], centroid3d: [1, 0.5, 0], extent3d: [[1, 0.2, -0.4], [1, 0.9, 0.4]] },
        quarter: { rect: [0.3, 0, 0.5, 0.5], centroid3d: [1, 0.6, -1.2], extent3d: [[1, 0.1, -2], [1, 1, 0.2]] },
      } },
    };
    if (!withExtent) for (const q of Object.values(p.panels.body)) delete q.extent3d;
    tagProfile(p);
    return p;
  };
  const region = { id: 'team', treatment: 'fill', tags: ['left', 'mid'], limit: 1 };
  const place = (profile, override) => {
    const fitted = applyFit([region], { regions: { team: override } }, { profile, role: 'body' }).regions;
    return expandRegions(profile, 'body', fitted).regions.map((r) => {
      const { x, y, w, h } = resolveRect(profile, 'body', r);
      return { panel: panelName(profile, 'body', r.panel), abs: [x, y, w, h] };
    });
  };
  const where = [0.1, 0.2, 0.5, 0.5];
  const before = car(false), after = car(true);

  const loose = { at: where };
  assert.equal(place(before, loose)[0].panel, 'door');
  assert.equal(place(after, loose)[0].panel, 'quarter',
    'the retag moves an unpinned fit, which is why a fit on a `limit` selection is pinned');

  for (const pinned of [{ panel: 'door', at: where }, { panel: 'doorLeft', at: where }]) {
    const door = [0.1 * 0.2, 0.2 * 0.2, 0.5 * 0.2, 0.5 * 0.2];
    assert.deepEqual(place(before, pinned), [{ panel: 'door', abs: door }]);
    assert.deepEqual(place(after, pinned), [{ panel: 'door', abs: door }],
      `pinned as "${pinned.panel}", the same texels of the same panel either way`);
  }
});
