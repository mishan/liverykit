// ---------------------------------------------------------------------------
// Liveries, as code and as data.
//
// A design has always been an ES module, and the module is worth keeping: one of
// the two shipped designs is commented as a tutorial, and a livery is allowed to
// compute things. But the data in it is plain, and a tool that can only read it
// is stuck at half a job — while generating a module back out would destroy the
// comments, which are the part worth having.
//
// So a livery may instead BE data. These check that both forms load, that a
// design is validated in its own terms rather than failing somewhere far away,
// and that a design carrying code is refused rather than quietly flattened.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLivery, validateDesign, serialisableDesign } from '../src/livery.mjs';
import { fitLiveryId } from '../src/fit.mjs';
import '../src/index.mjs';

test('a design loads from code or from data, and comes out the same', async () => {
  const fromCode = await loadLivery(new URL('../liveries/neon-grid-any.mjs', import.meta.url).pathname);

  const dir = await mkdtemp(join(tmpdir(), 'lk-livery-'));
  const path = join(dir, 'neon-grid-any.json');
  await writeFile(path, JSON.stringify(serialisableDesign(fromCode).design, null, 2));
  const fromData = await loadLivery(path);

  assert.deepEqual(fromData, fromCode, 'the same design, whichever way it arrived');
});

test('a design that is data still builds', async () => {
  // The claim worth checking is not that JSON parses, it is that nothing
  // downstream can tell the difference.
  const { renderSurface } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));

  const fromCode = await loadLivery(new URL('../liveries/neon-grid-any.mjs', import.meta.url).pathname);
  const dir = await mkdtemp(join(tmpdir(), 'lk-livery-'));
  const path = join(dir, 'x.json');
  await writeFile(path, JSON.stringify(serialisableDesign(fromCode).design));
  const fromData = await loadLivery(path);

  const role = Object.keys(profile.textures).find((r) => profile.panels[r]?.left_mid);
  assert.equal(
    renderSurface({ livery: fromData, profile, fit: null, role }).svg,
    renderSurface({ livery: fromCode, profile, fit: null, role }).svg,
  );
});

test('a fit knows a data design by the same name as a code one', () => {
  // fits/<livery>@<car>.json, and the file repeats the pair inside itself.
  // Stripping only `.mjs` would give a data design a fit called
  // `my-livery.json@abarth500.json` — which loads, and disagrees with every
  // other fit about how the pair is named.
  assert.equal(fitLiveryId('/x/liveries/my-livery.json'), 'my-livery');
  assert.equal(fitLiveryId('/x/liveries/my-livery.mjs'), 'my-livery');
});

test('a design is checked in its own terms, not somewhere far away', async () => {
  const ok = { name: 'L', folder: 'l', surfaces: { body: { regions: [{ id: 'a', treatment: 'fill' }] } } };
  assert.equal(validateDesign(ok, 'x'), ok);

  const cases = [
    [{ packs: 'core' }, /"packs" must be an array/],
    [{ palette: [] }, /"palette" must be an object/],
    [{ surfaces: [] }, /"surfaces" must be an object/],
    [{ surfaces: { body: { regions: {} } } }, /regions" must be an array/],
    [{ surfaces: { body: { regions: [{ id: '' }] } } }, /id must be a non-empty string/],
    [{ surfaces: { body: { regions: [{ treatment: 7 }] } } }, /treatment must be the name/],
    [{ surfaces: { body: { regions: [{ at: [0, 0, 1] }] } } }, /must be four numbers/],
    [{ surfaces: { body: { regions: [{ panel: 'L', tags: ['left'] }] } } }, /both "panel" and "tags"/],
  ];
  for (const [design, expected] of cases) {
    assert.throws(() => validateDesign(design, 'x.json'), expected, JSON.stringify(design));
  }

  // And a file that is not a design at all says so on load.
  const dir = await mkdtemp(join(tmpdir(), 'lk-livery-'));
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '[]');
  await assert.rejects(() => loadLivery(bad), /must be an object/);
});

test('a design carrying code is reported, never silently flattened', () => {
  const { design, lossy } = serialisableDesign({
    name: 'L',
    render: { font: () => 'DejaVu Sans' },
    surfaces: { body: { regions: [{ id: 'a', treatment: 'fill' }] } },
  });
  assert.deepEqual(lossy, ['render.font']);
  assert.equal(design.render.font, undefined);
  assert.equal(design.surfaces.body.regions[0].id, 'a', 'the rest still comes across');
});
