// Which way a model faces. A car says so with its wheels; anything else has to
// be told, and a profile has to say which of the two it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { carKn5, CAR } from './fixtures/kn5.mjs';

async function profile({ wheels = true, facing } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lk-frame-'));
  try {
    const path = join(dir, 'fixture.kn5');
    await writeFile(path, carKn5({ wheels }));
    const said = [];
    const p = await profileFromKn5(path, { id: 'fixture_car', facing, log: (m) => said.push(m) });
    return { p, said };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('the stated facing is said on the command line, and a regeneration keeps it', async () => {
  // A person's statement, like a confirmed binding: regenerating without
  // restating it must not quietly go back to guessing from mesh names.
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cli = (args, env) => new Promise((ok) => execFile(process.execPath,
    [join(ROOT, 'bin/liverykit.mjs'), ...args], { env: { ...process.env, ...env } },
    (e, out, err) => ok({ code: e?.code ?? 0, stdout: out, stderr: err })));
  const dir = await mkdtemp(join(tmpdir(), 'lk-frame-cli-'));
  try {
    const kn5 = join(dir, 'box.kn5');
    await writeFile(kn5, carKn5({ wheels: false }));
    const env = { LIVERYKIT_PRIOR_DIR: dir };
    const axes = async (out) => JSON.parse(await readFile(join(out, 'box.json'), 'utf8')).calibration.axes;

    const told = await cli(['--from-kn5', kn5, '--facing=-X,-Z', '--out', join(dir, 'a')], env);
    assert.equal(told.code, 0, told.stderr);
    assert.deepEqual(await axes(join(dir, 'a')), { left: '-X', front: '-Z', confident: true, from: 'stated' });

    await writeFile(join(dir, 'box.json'), await readFile(join(dir, 'a', 'box.json')));
    const again = await cli(['--from-kn5', kn5, '--out', join(dir, 'b')], env);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(await axes(join(dir, 'b')), await axes(join(dir, 'a')));
    assert.match(again.stdout, /facing.*stated/);

    const nonsense = await cli(['--from-kn5', kn5, '--facing', 'up', '--out', join(dir, 'c')], env);
    assert.notEqual(nonsense.code, 0);
    assert.match(nonsense.stderr, /--facing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
