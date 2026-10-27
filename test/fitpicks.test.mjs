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
    'skinbase_default #3': ['left_front', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_mid_upper_2', 'left_rear', 'left_rear_lower_2'],
    'skinbase_default #4': ['right_front', 'right_mid', 'right_mid_lower', 'right_mid_upper', 'right_mid_upper_2', 'right_rear', 'right_rear_lower'],
    'skinbase_default #5': ['left_front_upper_2', 'left_mid_lower_2', 'left_mid_lower_3'],
    'skinbase_default #6': ['centre_front_upper', 'centre_mid', 'centre_nose', 'centre_rear', 'centre_tail_lower', 'centre_tail_upper_5', 'left_front', 'left_front_upper_2', 'left_mid', 'left_mid_lower_2', 'left_mid_lower_3', 'left_mid_upper', 'left_mid_upper_2', 'left_rear', 'left_rear_lower_2', 'right_front', 'right_mid', 'right_mid_upper', 'right_mid_upper_2', 'right_rear', 'right_rear_lower'],
    'skinbase_default number-left': ['left_mid'],
    'skinbase_default number-right': ['right_mid'],
    'skinbase_default team-left': ['left_mid'],
    'skinbase_default team-right': ['right_mid'],
  },
  ks_mazda_mx5_cup: {
    'skin_00 #3': ['left_front', 'left_front_lower', 'left_front_upper', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_mid_upper_2', 'left_mid_upper_3', 'left_mid_upper_4', 'left_rear', 'left_rear_upper', 'left_tail'],
    'skin_00 #4': ['right_front', 'right_front_upper', 'right_mid', 'right_mid_lower', 'right_mid_upper', 'right_mid_upper_2', 'right_mid_upper_3', 'right_mid_upper_4', 'right_mid_upper_5', 'right_mid_upper_6', 'right_rear', 'right_rear_upper'],
    'skin_00 #5': [],
    'skin_00 #6': ['centre_front', 'centre_front_upper', 'centre_front_upper_2', 'centre_front_upper_4', 'centre_mid', 'centre_mid_upper', 'centre_rear', 'centre_tail', 'centre_tail_lower', 'centre_tail_upper', 'left_front', 'left_front_lower', 'left_front_upper', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_mid_upper_2', 'left_mid_upper_3', 'left_mid_upper_4', 'left_rear', 'left_rear_upper', 'left_tail', 'right_front', 'right_front_upper', 'right_mid', 'right_mid_lower', 'right_mid_upper_2', 'right_mid_upper_3', 'right_mid_upper_4', 'right_mid_upper_5', 'right_mid_upper_6', 'right_rear', 'right_rear_upper'],
    'skin_00 driver-left': ['left_mid'],
    'skin_00 driver-right': ['right_mid'],
    'skin_00 number-left': ['left_mid'],
    'skin_00 number-right': ['right_mid'],
    'skin_00 team-left': ['left_mid'],
    'skin_00 team-right': ['right_mid'],
  },
  tatuusfa1: {
    'skinbase #3': ['left_front', 'left_mid', 'left_mid_lower', 'left_mid_upper', 'left_mid_upper_2', 'left_nose', 'left_nose_lower', 'left_nose_upper', 'left_nose_upper_2', 'left_rear', 'left_rear_lower', 'left_rear_upper', 'left_tail', 'left_tail_lower', 'left_tail_lower_2'],
    'skinbase #4': ['right_front', 'right_mid', 'right_mid_lower', 'right_mid_upper', 'right_mid_upper_2', 'right_nose', 'right_nose_lower', 'right_nose_upper', 'right_nose_upper_2', 'right_rear', 'right_rear_lower', 'right_rear_upper', 'right_tail', 'right_tail_lower', 'right_tail_lower_2'],
    'skinbase #5': [],
    'skinbase #6': ['centre_front', 'centre_mid', 'centre_mid_lower', 'centre_rear', 'centre_rear_lower', 'centre_rear_lower_2', 'centre_rear_upper', 'centre_tail', 'centre_tail_lower', 'centre_tail_lower_3', 'left_front', 'left_mid', 'left_mid_lower', 'left_mid_upper_2', 'left_rear_lower', 'left_tail', 'left_tail_lower', 'left_tail_lower_2', 'right_front', 'right_mid', 'right_mid_lower', 'right_mid_upper_2', 'right_rear_lower', 'right_tail', 'right_tail_lower', 'right_tail_lower_2'],
    'skinbase driver-left': ['left_mid'],
    'skinbase driver-right': ['right_mid'],
    'skinbase number-left': ['left_mid'],
    'skinbase number-right': ['right_mid'],
    'skinbase team-left': ['left_mid'],
    'skinbase team-right': ['right_mid'],
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

test('a pinned fit stays on its panel whatever `limit` picks', async () => {
  // A door in the middle of the car and a rear quarter three times its size
  // that reaches forward into `mid`. Reaching does not displace the door,
  // whose centroid is there, so tagging by extent moves nothing. A quarter
  // whose centroid is itself in `mid` — a model regenerated, an island split
  // differently — is the bigger match and does take the pick, and a pinned fit
  // is the one that does not go with it.
  const car = ({ withExtent = true, quarterZ = -1.2 } = {}) => {
    const p = {
      id: 'c', calibration: { axes: { left: '+X', front: '+Z' } },
      textures: { body: { file: 'b.dds', width: 64, height: 64 } },
      aliases: { body: { doorLeft: 'door' } },
      panels: { body: {
        nose: { rect: [0.9, 0.9, 0.05, 0.05], centroid3d: [0, 1, 2] },
        tail: { rect: [0.9, 0.8, 0.05, 0.05], centroid3d: [0, 0, -2] },
        door: { rect: [0, 0, 0.2, 0.2], centroid3d: [1, 0.5, 0], extent3d: [[1, 0.2, -0.4], [1, 0.9, 0.4]] },
        quarter: { rect: [0.3, 0, 0.5, 0.5], centroid3d: [1, 0.6, quarterZ], extent3d: [[1, 0.1, -2], [1, 1, 0.2]] },
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
  const cars = {
    'by centroid': car({ withExtent: false }),
    'by extent': car(),
    'with the quarter centred in mid': car({ quarterZ: 0 }),
  };

  const loose = { at: where };
  assert.equal(place(cars['by centroid'], loose)[0].panel, 'door');
  assert.equal(place(cars['by extent'], loose)[0].panel, 'door',
    'a panel that only reaches `mid` does not take the pick from one centred there');
  assert.equal(place(cars['with the quarter centred in mid'], loose)[0].panel, 'quarter',
    'a bigger panel centred there does, and takes an unpinned fit with it');

  const door = [0.1 * 0.2, 0.2 * 0.2, 0.5 * 0.2, 0.5 * 0.2];
  for (const pinned of [{ panel: 'door', at: where }, { panel: 'doorLeft', at: where }]) {
    for (const [how, profile] of Object.entries(cars)) {
      assert.deepEqual(place(profile, pinned), [{ panel: 'door', abs: door }],
        `pinned as "${pinned.panel}" and tagged ${how}: the same texels of the same panel`);
    }
  }
});

test('every shipped design passes the check on every shipped car it is for, from the profile alone', async () => {
  // Raiden, ported to another car, rendered well and failed --check with
  // thirteen high findings, numbers and names too small to read from
  // trackside, and nothing ran the check. CI has no models, so this is the
  // part of the check a profile can answer; geometry is named as not run.
  const { fitment } = await import('../src/fitment.mjs');
  const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
  const cars = pkg.files.filter((f) => /^cars\/.*\.json$/.test(f)).map((f) => f.slice(5, -5));
  const designs = readdirSync(at('liveries'), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (existsSync(at(`liveries/${e.name}/livery.mjs`)) ? [[e.name, `liveries/${e.name}/livery.mjs`]] : [])
      : e.name.endsWith('.mjs') ? [[e.name.slice(0, -4), `liveries/${e.name}`]] : []);
  const failing = [];
  for (const [id, file] of designs) {
    const design = await loadLivery(at(file));
    for (const car of design.car ? [design.car] : cars) {
      const profile = await loadProfile(at(`cars/${car}.json`));
      const fitPath = at(`fits/${id}@${car}.json`);
      const fit = existsSync(fitPath) ? JSON.parse(readFileSync(fitPath, 'utf8')) : null;
      for (const f of fitment(design, profile, fit, { model: null }).findings) {
        if (f.severity === 'fatal' || f.severity === 'high') failing.push(`${id} on ${car}: ${f.kind} ${(f.ids ?? []).join(', ')}`);
      }
    }
  }
  assert.ok(designs.length > 3 && cars.length > 2, 'there are designs and cars to check');
  assert.deepEqual(failing, []);
});
