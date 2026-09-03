import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { loadProfile } from '../src/profile.mjs';
import { loadLivery } from '../src/livery.mjs';
import { createProtocolServer } from '../src/mcp/protocol.mjs';
import { createEditorClient } from '../src/mcp/client.mjs';
import { createToolHandler } from '../src/mcp/tools.mjs';
import '../src/index.mjs';

const ROOT = process.cwd();

async function setupTestEditor() {
  const profile = await loadProfile(join(ROOT, 'cars/rss_formula_rss_4.json'));
  const livery = {
    name: 'Test Livery',
    folder: 'test_livery',
    identity: { driver: 'Tester' },
    palette: { 'gulf-blue': '#7BB3D9' },
    surfaces: {
      body: {
        regions: [
          { id: 'stripe-centre', treatment: 'stripe', tags: ['centre'], at: [0, 0.4, 1, 0.2] },
        ],
      },
    },
  };
  const fitPath = join(ROOT, 'fits/neon-grid@rss_formula_rss_4.json');

  const { server, url } = await startUi({
    livery,
    profile,
    fitPath,
    liveryId: 'neon-grid',
    liveryPath: join(ROOT, 'liveries/neon-grid.json'),
    port: 0, // OS assigns available port
    log: () => {},
  });

  const stop = () => new Promise((ok) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(ok);
  });
  return { server, url, stop };
}

// ---------------------------------------------------------------------------
// 1. Protocol Layer
// ---------------------------------------------------------------------------
test('protocol: initialize handshake', async () => {
  const server = createProtocolServer({ toolHandler: { listTools: async () => [], callTool: async () => {} } });
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });

  assert.equal(res.id, 1);
  assert.equal(res.result.serverInfo.name, 'liverykit');
  assert.ok(res.result.capabilities.tools);
});

test('protocol: list tools', async () => {
  const mockHandler = {
    listTools: async () => [{ name: 'test_tool', description: 'a test tool' }],
    callTool: async () => {},
  };
  const server = createProtocolServer({ toolHandler: mockHandler });
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });

  assert.equal(res.id, 2);
  assert.equal(res.result.tools.length, 1);
  assert.equal(res.result.tools[0].name, 'test_tool');
});

test('protocol: unknown method returns error', async () => {
  const server = createProtocolServer({ toolHandler: { listTools: async () => [], callTool: async () => {} } });
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'nonexistent/method',
  });

  assert.equal(res.id, 3);
  assert.equal(res.error.code, -32601);
});

// ---------------------------------------------------------------------------
// 2. Read-Only Tools (Knowing)
// ---------------------------------------------------------------------------
test('mcp tools: describe_car', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);
    const res = await handler.callTool('describe_car', {});

    assert.ok(!res.isError);
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.car.id, 'rss_formula_rss_4');
    assert.ok(data.textureCount > 0);
    assert.ok(data.totalPanels > 0);
    assert.ok(Array.isArray(data.unpaintedSurfaces));
    assert.ok(Array.isArray(data.unpaintable));
  } finally {
    await stop();
  }
});

test('mcp tools: render_view', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    // Single surface render
    const resSurface = await handler.callTool('render_view', { role: 'body' });
    assert.ok(!resSurface.isError);
    const dataSurface = JSON.parse(resSurface.content[0].text);
    assert.ok(dataSurface.svg);
    assert.ok(Array.isArray(dataSurface.placed));

    // Preview all surfaces
    const resAll = await handler.callTool('render_view', {});
    assert.ok(!resAll.isError);
    const dataAll = JSON.parse(resAll.content[0].text);
    assert.ok(Array.isArray(dataAll.surfaces));
    assert.ok(dataAll.surfaces.length > 0);
  } finally {
    await stop();
  }
});

test('mcp tools: find_panels with filters', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    // Search by tag
    const resTag = await handler.callTool('find_panels', { tag: 'left' });
    assert.ok(!resTag.isError);
    const dataTag = JSON.parse(resTag.content[0].text);
    assert.ok(dataTag.count > 0);
    assert.ok(dataTag.panels.every((p) => p.tags.includes('left')));

    // Search by role
    const resRole = await handler.callTool('find_panels', { role: 'body' });
    const dataRole = JSON.parse(resRole.content[0].text);
    assert.ok(dataRole.count > 0);
    assert.ok(dataRole.panels.every((p) => p.role === 'body'));

    // Search by mirror
    const resMirror = await handler.callTool('find_panels', { hasMirror: true });
    const dataMirror = JSON.parse(resMirror.content[0].text);
    assert.ok(dataMirror.panels.every((p) => Boolean(p.mirrorOf)));
  } finally {
    await stop();
  }
});

test('mcp tools: list_treatments', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);
    const res = await handler.callTool('list_treatments', {});

    assert.ok(!res.isError);
    const data = JSON.parse(res.content[0].text);
    assert.ok(data.treatments.length > 0);
    assert.ok(data.treatments.some((t) => t.name === 'stripe'));
  } finally {
    await stop();
  }
});

test('mcp tools: read_design & read_fit', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const resDesign = await handler.callTool('read_design', {});
    assert.ok(!resDesign.isError);
    const design = JSON.parse(resDesign.content[0].text);
    assert.ok(design.surfaces || design.paint);

    const resFit = await handler.callTool('read_fit', {});
    assert.ok(!resFit.isError);
    const fitData = JSON.parse(resFit.content[0].text);
    assert.ok(fitData.fit);
    assert.ok(Array.isArray(fitData.staleIds));
  } finally {
    await stop();
  }
});

test('mcp tools: report', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);
    const res = await handler.callTool('report', {});

    assert.ok(!res.isError);
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.car.id, 'rss_formula_rss_4');
    assert.ok(data.surfaces.length > 0);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Proposing Tools & Inbox
// ---------------------------------------------------------------------------
test('mcp tools: propose_design posts to proposal inbox', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const propRes = await handler.callTool('propose_design', {
      why: 'a first pass at Gulf palette',
      design: [
        { op: 'set-palette', name: 'gulf-blue', value: '#7BB3D9' },
      ],
    });

    assert.ok(!propRes.isError);
    const propData = JSON.parse(propRes.content[0].text);
    assert.equal(propData.status, 'proposed');
    assert.ok(propData.proposalId);

    // Read proposal from server
    const pending = await fetch(new URL('api/proposal', url).href).then((r) => r.json());
    assert.equal(pending.proposal.id, propData.proposalId);
    assert.equal(pending.proposal.why, 'a first pass at Gulf palette');
    assert.equal(pending.proposal.design[0].op, 'set-palette');

    // Ack proposal
    await fetch(new URL('api/proposal/ack', url).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: propData.proposalId, status: 'accepted' }),
    });

    const cleared = await fetch(new URL('api/proposal', url).href).then((r) => r.json());
    assert.equal(cleared.proposal, null);
  } finally {
    await stop();
  }
});

test('mcp tools: propose_design with adopt-surface', async () => {
  // `grips`, not `wing`. On the RSS4 `wing` is a vocabulary TERM bound to no
  // roles at all — `bind.wing` is an empty array, which is the profile saying
  // this car has no such surface — so `paint.wing` names a texture that does
  // not exist and could never be adopted. `grips` is a real texture role on
  // this profile that the design does not paint, which is the case the tool is
  // actually for.
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const propRes = await handler.callTool('propose_design', {
      why: 'adopt the grip texture into the design',
      design: [
        { op: 'adopt-surface', role: 'grips' },
      ],
    });

    assert.ok(!propRes.isError);
    const pending = await fetch(new URL('api/proposal', url).href).then((r) => r.json());
    assert.equal(pending.proposal.why, 'adopt the grip texture into the design');
    assert.equal(pending.proposal.design[0].op, 'adopt-surface');
    assert.equal(pending.proposal.design[0].role, 'grips');
  } finally {
    await stop();
  }
});

test('mcp tools: a secondary bound role is not offered as unpainted', async () => {
  // A vocabulary term may bind to several textures: on the RSS4 `body` binds to
  // `body` AND `bodyRear`. The editor's `surfaces` list holds one entry per
  // term — the primary — because that is the one you edit, so reading painted
  // roles off it marks every secondary as free.
  //
  // Offering `bodyRear` for adoption would then produce `paint.bodyRear`
  // alongside `surfaces.body`, two claims on one texture, which
  // `resolveTargets` refuses outright. The design would stop resolving on the
  // next request.
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);
    const res = await handler.callTool('describe_car', {});
    const text = res.content.map((c) => c.text).join('\n');
    const described = JSON.parse(text);

    const offered = (described.unpaintedSurfaces ?? []).map((s) => s.role);
    assert.ok(!offered.includes('bodyRear'),
      `bodyRear is already painted via surfaces.body; offered: ${offered.join(', ')}`);
    assert.ok(!offered.includes('body'), 'nor the primary');
    // And it still offers the ones that genuinely are free, or the check above
    // would pass on a tool that offered nothing at all.
    assert.ok(offered.length > 0, 'some textures on this car really are unpainted');
  } finally {
    await stop();
  }
});

test('mcp tools: propose_fit with valid add-copy', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const propRes = await handler.callTool('propose_fit', {
      why: 'add copy of stripe on right flank',
      fit: [
        { op: 'add-copy', id: 'stripe-right', of: 'stripe-centre', panel: 'flank_right' },
      ],
    });

    assert.ok(!propRes.isError);
    const pending = await fetch(new URL('api/proposal', url).href).then((r) => r.json());
    assert.equal(pending.proposal.why, 'add copy of stripe on right flank');
    assert.equal(pending.proposal.fit[0].op, 'add-copy');
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// 4. Refusals & Integrity Guards
// ---------------------------------------------------------------------------
test('refusal: no editor, no service', async () => {
  const client = createEditorClient('http://127.0.0.1:59999/');
  const handler = createToolHandler(client);

  await assert.rejects(
    async () => handler.callTool('describe_car', {}),
    /No fitting editor is listening/
  );
});

test('refusal: source: "human" is refused', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const res = await handler.callTool('propose_fit', {
      why: 'try setting human binding',
      fit: [{ op: 'set-override', id: 'body', source: 'human' }],
    });

    assert.ok(res.isError);
    assert.match(res.content[0].text, /source: "human"/);
  } finally {
    await stop();
  }
});

test('refusal: proposal without why is refused', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const res = await handler.callTool('propose_design', {
      why: '',
      design: [],
    });

    assert.ok(res.isError);
    assert.match(res.content[0].text, /requires a non-empty "why" field/);
  } finally {
    await stop();
  }
});

test('refusal: invalid fit proposal is refused at proposal time', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    // Bad fit structure: missing 'of' field on a copy
    const res = await handler.callTool('propose_fit', {
      why: 'broken copy',
      fit: [{ op: 'add-copy', id: 'bad-copy' }],
    });

    assert.ok(res.isError);
    assert.match(res.content[0].text, /Proposal refused|fit rejected/);
  } finally {
    await stop();
  }
});

test('refusal: concurrent pending proposal is rejected', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    const first = await handler.callTool('propose_fit', {
      why: 'first proposal',
      fit: [{ op: 'set-override', id: 'stripe-centre', panel: 'nose' }],
    });
    assert.ok(!first.isError);

    const second = await handler.callTool('propose_fit', {
      why: 'second proposal',
      fit: [{ op: 'set-override', id: 'stripe-centre', panel: 'flank' }],
    });
    assert.ok(second.isError);
    assert.match(second.content[0].text, /already pending/);
  } finally {
    await stop();
  }
});

test('refusal: zero writes to disk during proposals', async () => {
  const { url, stop } = await setupTestEditor();
  const fitPath = join(ROOT, 'fits/neon-grid@rss_formula_rss_4.json');
  const initialContent = await readFile(fitPath, 'utf8').catch(() => null);

  try {
    const client = createEditorClient(url);
    const handler = createToolHandler(client);

    await handler.callTool('propose_fit', {
      why: 'test proposal',
      fit: [{ op: 'set-override', id: 'stripe-centre', panel: 'nose' }],
    });

    const contentAfterProposal = await readFile(fitPath, 'utf8').catch(() => null);
    assert.equal(initialContent, contentAfterProposal, 'Disk content must not change during proposal');
  } finally {
    await stop();
  }
});

test('integrity: tool descriptions declare agent has no eyes', async () => {
  const client = createEditorClient('http://127.0.0.1:7391/');
  const handler = createToolHandler(client);
  const tools = await handler.listTools();

  for (const t of tools) {
    assert.ok(
      t.description.includes('cannot visually see') || t.description.includes('cannot see'),
      `Tool "${t.name}" description must state that agent cannot see the car`
    );
  }
});

// ---------------------------------------------------------------------------
// check_fitment — the tool that exists because of a specific mistake.
//
// Asked to improve a fit, I moved a team name into a part of the texture no
// triangle uses. It rendered perfectly, it was on no part of the car, and every
// number available to me said the move was fine. The value of this tool is
// entirely in whether the bad news survives the trip to an agent intact.
// ---------------------------------------------------------------------------

test('check_fitment: a run that skipped checks cannot read as a clean one', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const client = createEditorClient(url);
    const tools = createToolHandler(client);

    const listed = (await tools.listTools()).find((t) => t.name === 'check_fitment');
    assert.ok(listed, 'the tool is offered');
    assert.match(listed.description, /notChecked/,
      'and the description tells the caller to read it');

    const res = await tools.callTool('check_fitment', {});
    const out = JSON.parse(res.content[0].text);

    // No model is loaded in this test, so the geometry checks cannot run. That
    // is the common case and the dangerous one: an empty findings list here
    // means "nothing found by the checks that ran", and an agent that reads it
    // as "the design is good" makes exactly my mistake.
    assert.ok(out.notChecked.includes('unseen'), 'the skipped checks are named');
    assert.ok(out.notChecked.includes('off-mesh'));
    assert.ok(!out.checked.includes('unseen'), 'and not also counted as passed');
    assert.match(out.verdict, /did not run/,
      `the verdict says so in words, not just in a field: ${out.verdict}`);
  } finally {
    await stop();
  }
});

test('check_fitment: the worst finding leads, and is counted', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const tools = createToolHandler(createEditorClient(url));
    const out = JSON.parse((await tools.callTool('check_fitment', {})).content[0].text);

    const rank = { fatal: 0, high: 1, low: 2 };
    const order = out.findings.map((f) => rank[f.severity]);
    assert.deepEqual(order, [...order].sort((a, b) => a - b),
      'worst first, so truncation loses the least important end');

    // A count and a sorted list, because "some minor findings" is how nine low
    // and one high gets summarised by anything reading in a hurry.
    if (out.findings.length) {
      assert.match(out.verdict, /Worst finding is (fatal|high|low)\./, out.verdict);
      assert.match(out.verdict, /\d+ fatal, \d+ high, \d+ low/, out.verdict);
    }
  } finally {
    await stop();
  }
});

test('list_constraints: the vocabulary is discoverable, not folklore', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const tools = createToolHandler(createEditorClient(url));
    const listed = (await tools.listTools()).find((t) => t.name === 'list_constraints');
    assert.ok(listed, 'the tool is offered');

    const out = JSON.parse((await tools.callTool('list_constraints', {})).content[0].text);
    // The names have to match what fitment actually enforces, or the tool is
    // documentation that lies — worse than none, because it will be believed.
    const { CONSTRAINTS } = await import('../src/fitment.mjs');
    assert.deepEqual(Object.keys(out), Object.keys(CONSTRAINTS));
    for (const [k, v] of Object.entries(out)) {
      assert.equal(typeof v, 'string', `${k} explains itself`);
      assert.ok(v.length > 40, `${k} says what it means, not just its type`);
    }
  } finally {
    await stop();
  }
});

test('propose_design can record what a region needs, and refuses a name nothing enforces', async () => {
  const { url, stop } = await setupTestEditor();
  try {
    const tools = createToolHandler(createEditorClient(url));

    // The tool has to point at list_constraints, because guessing a constraint
    // name is the one thing that cannot work: the vocabulary is closed and a
    // near-miss is refused rather than ignored.
    const listed = (await tools.listTools()).find((t) => t.name === 'propose_design');
    assert.match(listed.description, /list_constraints/);
    assert.match(listed.inputSchema.properties.design.description, /set-constraint/);

    const res = await tools.callTool('propose_design', {
      why: 'the team name is being crossed by a stripe on both flanks',
      design: [{ op: 'set-constraint', id: 'stripe-centre', key: 'keepClear', value: true }],
    });
    assert.ok(!res.isError, res.content[0].text);

    // And the whole point: it lands in the INBOX for a human, not on the design.
    const { applyDesignOp, opSetConstraint } = await import('../src/ui/ops.js');
    assert.throws(() => opSetConstraint({}, { id: 'x', key: 'keepClose', value: true }),
      /No constraint called "keepClose"/);
    assert.throws(() => applyDesignOp({}, { op: 'set-constraints', id: 'x' }),
      /No design op called "set-constraints"/,
      'a near-miss op name is refused too, rather than quietly doing nothing');
  } finally {
    await stop();
  }
});

test('check_fitment answers about the working fit, not the file on disk', async () => {
  // Found by doing the before/after the tool's own description asks for. A fit
  // change went in, `read_fit` showed it, and `check_fitment` reported the
  // identical findings as before — because the endpoint read `sent.fit ?? fit`
  // and the MCP client deliberately sends nothing, asking the editor about its
  // own state. So it fell through to the file loaded at startup and reported
  // confidently on a fit nobody was looking at.
  //
  // It agreed with reality whenever the two happened to match, which is the
  // worst way for this to be wrong: it reads as a verified comparison.
  //
  // Two text regions that do not overlap, then a working fit that puts one on
  // the other. Overlap is the one check that needs neither a car model nor a
  // regenerated profile, so this stays a test about plumbing.
  const profile = await loadProfile(join(ROOT, 'cars/rss_formula_rss_4.json'));
  const livery = {
    name: 'Two Names', folder: 'two_names', packs: ['core'],
    identity: { driver: 'Tester', team: 'Team', number: '7' },
    palette: { ink: '#101014' },
    surfaces: { body: { regions: [
      { id: 'a-name', treatment: 'text', panel: 'centre_mid', at: [0.1, 0.1, 0.8, 0.2], text: '{driver}' },
      { id: 'b-name', treatment: 'text', panel: 'centre_mid', at: [0.1, 0.7, 0.8, 0.2], text: '{team}' },
    ] } },
  };
  const { server, url } = await startUi({
    livery, profile, fitPath: join(ROOT, 'fits/neon-grid@rss_formula_rss_4.json'),
    liveryId: 'neon-grid', liveryPath: join(ROOT, 'liveries/neon-grid.json'),
    port: 0, log: () => {},
  });
  try {
    const tools = createToolHandler(createEditorClient(url));
    const ask = async () => JSON.parse((await tools.callTool('check_fitment', {})).content[0].text);

    const before = await ask();
    assert.deepEqual(before.findings.filter((f) => f.kind === 'overlap'), [],
      'the two names start apart');

    // The door the browser and an accepted proposal both use.
    await fetch(new URL('api/preview', url).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fit: { livery: 'neon-grid', car: profile.id, regions: {
        'b-name': { panel: 'centre_mid', at: [0.1, 0.12, 0.8, 0.2] },
      } } }),
    });

    const after = await ask();
    const hit = after.findings.filter((f) => f.kind === 'overlap');
    assert.ok(hit.length >= 1, `the working fit is what gets checked: ${
      JSON.stringify(after.findings)}`);
    assert.deepEqual(hit[0].ids.sort(), ['a-name', 'b-name']);
    assert.match(hit[0].why, /both are text/);

    // This car's `surfaces.body` binds two texture roles, so the collision is
    // real on both sheets. They used to arrive as exact duplicates, which reads
    // as a bug in the checker rather than as two places to go and look.
    assert.equal(new Set(hit.map((f) => f.role)).size, hit.length,
      `each names its own texture: ${JSON.stringify(hit.map((f) => f.role))}`);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});

test('render_car returns an image, and refuses a view it does not have', async () => {
  // The tool that exists because three changes in a row were shipped blind.
  // The editor draws with WebGL in a browser an MCP tool cannot reach, so an
  // agent proposing livery changes could describe them confidently and never
  // once look at the result — including the change that made the whole car
  // see-through.
  const { url, stop } = await setupTestEditor();
  try {
    const tools = createToolHandler(createEditorClient(url));
    const listed = (await tools.listTools()).find((t) => t.name === 'render_car');
    assert.ok(listed, 'the tool is offered');
    // The description has to state what the picture is NOT, or it will be read
    // as a screenshot of the game and trusted further than it should be.
    assert.match(listed.description, /no stock car textures|no transparency/);

    // No car model in this harness, so the honest answer is a refusal rather
    // than a blank image — a picture of nothing looks like a car with nothing
    // on it, which is a lie about the design.
    const res = await tools.callTool('render_car', { view: 'left' });
    if (res.isError) {
      assert.match(res.content[0].text, /model/i, res.content[0].text);
    } else {
      assert.equal(res.content[0].type, 'image');
      assert.equal(res.content[0].mimeType, 'image/png');
      assert.ok(res.content[0].data.length > 100, 'and it has pixels in it');
    }
  } finally {
    await stop();
  }
});

test('a shot is drawn from geometry, with the artwork on it', async () => {
  // Rendering without the editor, so this can be checked without a browser or
  // a car. Two triangles forming a quad, facing the camera, wearing a solid
  // magenta sheet.
  const { rasterise, VIEWS } = await import('../src/engine/shot.mjs');
  assert.ok(VIEWS.left && VIEWS.right, 'the named views exist');

  // In the YZ plane, facing the `left` camera at +x. A quad in the XY plane
  // is edge-on from there and renders as nothing — which the first version of
  // this test did, and which is exactly the kind of mistake the whole file
  // exists to make visible.
  const quad = {
    positions: new Float32Array([0, -1, -1, 0, -1, 1, 0, 1, 1, 0, 1, -1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const art = { w: 2, h: 2, data: Buffer.from([
    255, 0, 255, 255, 255, 0, 255, 255,
    255, 0, 255, 255, 255, 0, 255, 255,
  ]) };

  const painted = rasterise(quad, [{ role: 'body', start: 0, count: 6 }],
    new Map([['body', art]]), { view: 'left', width: 80, height: 80 });
  const at = (img, x, y) => [0, 1, 2].map((k) => img.data[(y * img.width + x) * 4 + k]);
  const [r, g, b] = at(painted, 40, 40);
  // Darker than the source, because it is shaded — the hue is what matters.
  assert.ok(r > 40 && b > 40 && g < r / 2, `the artwork reaches the pixels: ${r},${g},${b}`);

  // A group with no artwork is drawn bare grey, which says "your design does
  // not paint this" rather than inventing a colour for it.
  const bare = rasterise(quad, [{ role: 'body', start: 0, count: 6 }],
    new Map(), { view: 'left', width: 80, height: 80 });
  const [br, bg, bb] = at(bare, 40, 40);
  assert.ok(Math.abs(br - bg) < 30 && Math.abs(bg - bb) < 30,
    `unpainted is grey, not a plausible colour: ${br},${bg},${bb}`);
  assert.notDeepEqual([br, bg, bb], [r, g, b]);
});

test('the left view shows the left of the car', async () => {
  // It showed the right. A profile calls +X the car's left because AC puts
  // WHEEL_LF there, and the NSX's driver sits at +0.34 in a left-hand-drive
  // car, so that is not in doubt. The `left` camera sat at -X and looked
  // across at the far flank, and every "left" render this project produced
  // was of the right-hand side. Nobody caught it because a livery is nearly
  // symmetric, until a stripe painted on left_mid alone showed up only in
  // the `right` view.
  const { rasterise } = await import('../src/engine/shot.mjs');
  // Two slabs, one each side, each wearing its own colour. Whichever is
  // nearer the camera wins the depth test, so the colour at the centre says
  // which side the view is looking at.
  const slab = (x) => [x, -1, -1, x, -1, 1, x, 1, 1, x, 1, -1];
  const model = {
    positions: new Float32Array([...slab(1), ...slab(-1)]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  };
  const solid = (r, g, b) => ({ w: 1, h: 1, data: Buffer.from([r, g, b, 255]) });
  const sheets = new Map([['leftSide', solid(255, 0, 0)], ['rightSide', solid(0, 0, 255)]]);
  const groups = [{ role: 'leftSide', start: 0, count: 6 }, { role: 'rightSide', start: 6, count: 6 }];
  const centre = (img) => [0, 1, 2].map((k) => img.data[(40 * img.width + 40) * 4 + k]);

  const [lr, , lb] = centre(rasterise(model, groups, sheets, { view: 'left', width: 80, height: 80 }));
  assert.ok(lr > lb * 2, `left view sees the +X slab, which is red: got ${lr},${lb}`);
  const [rr, , rb] = centre(rasterise(model, groups, sheets, { view: 'right', width: 80, height: 80 }));
  assert.ok(rb > rr * 2, `right view sees the -X slab, which is blue: got ${rr},${rb}`);
  const [flr, , flb] = centre(rasterise(model, groups, sheets, { view: 'front-left', width: 80, height: 80 }));
  assert.ok(flr > flb * 2, `front-left is a left view: got ${flr},${flb}`);
});

test('render_view tells an empty role apart from no role at all', async () => {
  // `if (args.role)` sent an empty string, a stray space or a null down the
  // render-everything path, so a caller that computed a role and got nothing
  // received a whole-car preview and no hint that its role had evaporated.
  const { url, stop } = await setupTestEditor();
  try {
    const tools = createToolHandler(createEditorClient(url));

    for (const role of ['', '   ', null, 42]) {
      const res = await tools.callTool('render_view', { role });
      assert.ok(res.isError, `role: ${JSON.stringify(role)} should be refused`);
      assert.match(res.content[0].text, /not a texture role/);
      assert.match(res.content[0].text, /Omit `role`/, 'and says what to do instead');
    }

    // Omitting it is a real request and still renders everything.
    const all = await tools.callTool('render_view', {});
    assert.ok(!all.isError, all.content[0].text);
    assert.ok(JSON.parse(all.content[0].text).surfaces, 'the whole-car preview');

    // And a real role is trimmed rather than refused.
    const one = await tools.callTool('render_view', { role: ' body ' });
    assert.ok(!one.isError, one.content[0].text);
  } finally {
    await stop();
  }
});

test('the shot composites blended surfaces the way the viewer does', async () => {
  // Two ways the rasteriser drifted from the viewer it exists to check.
  const { rasterise } = await import('../src/engine/shot.mjs');

  // Two quads facing the camera, the second nearer. Both blended.
  const quad = (x) => ({
    positions: [x, -1, -1, x, -1, 1, x, 1, 1, x, 1, -1],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    normals: [-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0],
  });
  // The `left` camera sits at POSITIVE x — the car's left — looking toward
  // -x, so larger x is nearer. Getting this backwards is how the first
  // version of this test asserted that the far quad should win; it was then
  // written for a camera that sat on the wrong side of the car, and moved
  // with it when that was fixed.
  const back = quad(0), front = quad(0.4);
  const model = {
    positions: new Float32Array([...back.positions, ...front.positions]),
    uvs: new Float32Array([...back.uvs, ...front.uvs]),
    normals: new Float32Array([...back.normals, ...front.normals]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  };
  const sheet = (r, g, b, a) => ({ w: 1, h: 1, data: Buffer.from([r, g, b, a]) });
  const at = (img) => [0, 1, 2].map((k) => img.data[((img.height >> 1) * img.width + (img.width >> 1)) * 4 + k]);

  // ADDITIVE: a black emissive sheet must add nothing, leaving the magenta
  // behind it visible. Alpha-composited it would be a black rectangle — the
  // exact failure this renderer is meant to catch.
  const withGlow = rasterise(model, [
    { role: 'plate', start: 0, count: 6, blend: true },
    { role: 'glow', start: 6, count: 6, blend: true, add: true },
  ], new Map([['plate', sheet(255, 0, 255, 255)], ['glow', sheet(0, 0, 0, 255)]]),
    { view: 'left', width: 60, height: 60 });
  const [r, g, b] = at(withGlow);
  assert.ok(r > 40 && b > 40 && g < r / 2,
    `a black emissive sheet hid the plate under it: ${r},${g},${b}`);

  // SORTED: the nearer blended quad composites last. Given a fully opaque one
  // in front, its colour is what survives — which only holds if the two are
  // ordered by distance rather than by however the groups arrived.
  const ordered = rasterise(model, [
    { role: 'far', start: 0, count: 6, blend: true },
    { role: 'near', start: 6, count: 6, blend: true },
  ], new Map([['far', sheet(255, 0, 255, 255)], ['near', sheet(0, 255, 0, 255)]]),
    { view: 'left', width: 60, height: 60 });
  const [nr, ng, nb] = at(ordered);
  assert.ok(ng > nr && ng > nb, `the nearer surface should win: ${nr},${ng},${nb}`);

  // And the same two groups listed the other way round give the same picture.
  const reversed = rasterise(model, [
    { role: 'near', start: 6, count: 6, blend: true },
    { role: 'far', start: 0, count: 6, blend: true },
  ], new Map([['far', sheet(255, 0, 255, 255)], ['near', sheet(0, 255, 0, 255)]]),
    { view: 'left', width: 60, height: 60 });
  assert.deepEqual(at(reversed), [nr, ng, nb],
    'group order must not change the picture; that is what sorting is for');
});
