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
