// Which way a model faces. A car says so with its wheels; anything else has to
// be told, and a profile has to say which of the two it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { carKn5, CAR } from './fixtures/kn5.mjs';

async function profile({ wheels = true, facing } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lk-frame-'));
  const path = join(dir, 'fixture.kn5');
  await writeFile(path, carKn5({ wheels }));
  const said = [];
  const p = await profileFromKn5(path, { id: 'fixture_car', facing, log: (m) => said.push(m) });
  return { p, said };
}

/** Each panel's name and tags, which is what the facing decides. */
const layout = (p) => Object.fromEntries(Object.entries(p.panels).map(([role, panels]) =>
  [role, Object.fromEntries(Object.entries(panels).map(([n, q]) => [n, q.tags]))]));

test('a stated facing places panels exactly as the wheels do', async () => {
  const fromWheels = await profile();
  const stated = await profile({ wheels: false, facing: { left: '+X', front: '+Z' } });
  assert.equal(fromWheels.p.calibration.axes.from, 'wheels');
  assert.deepEqual(stated.p.calibration.axes, { left: '+X', front: '+Z', confident: true, from: 'stated' });
  assert.deepEqual(layout(stated.p), layout(fromWheels.p));
});

test('a model with no wheels faces the way it is told', async () => {
  // The fixture's +Z face, found by where it sits on the sheet.
  const at = (p) => {
    const panels = Object.values(p.panels)[0];
    const near = (r) => r.every((v, i) => Math.abs(v - CAR.faces.front[i]) < 0.02);
    return Object.keys(panels).find((n) => near(panels[n].rect));
  };
  const ahead = await profile({ wheels: false, facing: { left: '+X', front: '+Z' } });
  const turned = await profile({ wheels: false, facing: { left: '-X', front: '-Z' } });
  assert.match(at(ahead.p), /^centre_nose/);
  assert.match(at(turned.p), /^centre_tail/);
});

test('the wheels win over a stated facing that disagrees, and it is said', async () => {
  const { p, said } = await profile({ facing: { left: '+X', front: '-Z' } });
  assert.equal(p.calibration.axes.from, 'wheels');
  assert.equal(p.calibration.axes.front, '+Z');
  assert.ok(said.some((m) => /facing.*disagrees with the wheels/.test(m)), said.join('\n'));
});

test('a facing that is not a direction is refused', async () => {
  await assert.rejects(profile({ wheels: false, facing: { left: 'X', front: '+Z' } }), /facing/);
});
