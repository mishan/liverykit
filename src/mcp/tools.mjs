const PROMPT_NOTE = '(Note: as an AI model, you cannot visually see the 3D car or rendered artwork. Your proposals are presented to a human user in the fitting editor, who will inspect and accept/discard them.)';

async function toolDescribeCar(client) {
  const state = await client.getState();
  const textures = state.surfaces.map((s) => ({
    role: s.role,
    from: s.from,
    file: s.file,
    width: s.width,
    height: s.height,
    panelCount: s.panels?.length ?? 0,
  }));
  const totalPanels = state.surfaces.reduce((sum, s) => sum + (s.panels?.length ?? 0), 0);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        car: state.car,
        textureCount: textures.length,
        totalPanels,
        textures,
      }, null, 2),
    }],
  };
}

async function toolFindPanels(client, args) {
  const state = await client.getState();
  const results = [];
  for (const s of state.surfaces) {
    if (args.role && s.role !== args.role && s.from !== args.role) continue;
    for (const p of s.panels ?? []) {
      if (args.tag && !(p.tags ?? []).includes(args.tag)) continue;
      if (typeof args.minVisibility === 'number' && typeof p.visible === 'number' && p.visible < args.minVisibility) continue;
      const area = p.rect ? (p.rect[2] * p.rect[3]) : 0;
      if (typeof args.minArea === 'number' && area < args.minArea) continue;
      if (typeof args.maxAnisotropy === 'number' && p.anisotropy > args.maxAnisotropy) continue;
      if (args.hasMirror === true && !p.mirrorOf) continue;
      if (args.hasMirror === false && p.mirrorOf) continue;

      results.push({
        role: s.role,
        panel: p.name,
        rect: p.rect,
        area: Number(area.toFixed(4)),
        tags: p.tags,
        visible: p.visible,
        anisotropy: p.anisotropy,
        mirrorOf: p.mirrorOf ?? null,
      });
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: results.length, panels: results }, null, 2) }],
  };
}

async function toolListTreatments(client) {
  const treatments = await client.getTreatments();
  return {
    content: [{ type: 'text', text: JSON.stringify(treatments, null, 2) }],
  };
}

async function toolReadDesign(client) {
  const state = await client.getState();
  return {
    content: [{ type: 'text', text: JSON.stringify(state.design, null, 2) }],
  };
}

async function toolReadFit(client) {
  const state = await client.getState();
  const fit = state.fit;

  const knownRegionIds = new Set(Object.values(state.regionIds ?? {}));
  for (const s of state.surfaces ?? []) {
    for (const r of s.regions ?? []) {
      if (r.id) knownRegionIds.add(r.id);
    }
  }

  const staleIds = [];
  for (const [id, override] of Object.entries(fit.regions ?? {})) {
    if (override.of) {
      if (!knownRegionIds.has(override.of)) staleIds.push(id);
    } else {
      if (!knownRegionIds.has(id)) staleIds.push(id);
    }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ fit, staleIds }, null, 2) }],
  };
}

async function toolReport(client) {
  const state = await client.getState();
  const reportData = {
    car: state.car,
    livery: state.livery,
    surfaces: state.surfaces.map((s) => ({
      role: s.role,
      from: s.from,
      file: s.file,
      regionCount: s.regions?.length ?? 0,
      regions: s.regions?.map((r) => ({
        id: r.id,
        treatment: r.treatment,
        panel: r.panel,
        at: r.at,
      })),
    })),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(reportData, null, 2) }],
  };
}

async function toolProposeDesign(client, args) {
  if (!args.why || typeof args.why !== 'string' || !args.why.trim()) {
    return {
      content: [{ type: 'text', text: 'Refusal: propose_design requires a non-empty "why" field.' }],
      isError: true,
    };
  }
  try {
    const res = await client.postProposal({
      why: args.why.trim(),
      design: args.design ?? [],
      fit: [],
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', proposalId: res.id, why: args.why }) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Proposal refused: ${e.message}` }],
      isError: true,
    };
  }
}

async function toolProposeFit(client, args) {
  if (!args.why || typeof args.why !== 'string' || !args.why.trim()) {
    return {
      content: [{ type: 'text', text: 'Refusal: propose_fit requires a non-empty "why" field.' }],
      isError: true,
    };
  }
  try {
    const res = await client.postProposal({
      why: args.why.trim(),
      design: [],
      fit: args.fit ?? [],
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', proposalId: res.id, why: args.why }) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Proposal refused: ${e.message}` }],
      isError: true,
    };
  }
}

export function createToolHandler(client) {
  const checkEditorAlive = async () => {
    await client.checkEditor();
  };

  const tools = [
    {
      name: 'describe_car',
      description: `Describe the car profile including texture roles, panel counts, bind table, and axes. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'find_panels',
      description: `Find panels in the car profile filtered by tag, role, visibility, size/area, anisotropy, or mirror. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Filter by texture role (e.g. "body")' },
          tag: { type: 'string', description: 'Filter by panel tag (e.g. "left", "nose")' },
          minVisibility: { type: 'number', description: 'Minimum visible raycast fraction (0..1)' },
          minArea: { type: 'number', description: 'Minimum rect area fraction (rect.w * rect.h)' },
          maxAnisotropy: { type: 'number', description: 'Maximum anisotropy value' },
          hasMirror: { type: 'boolean', description: 'Filter to panels with a mirror panel' },
        },
      },
    },
    {
      name: 'list_treatments',
      description: `List all available treatments from loaded packs with their option schemas. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'read_design',
      description: `Read the working design as currently held in the fitting editor. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'read_fit',
      description: `Read the working fit as currently held in the fitting editor, including stale region ids. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'report',
      description: `Report which surfaces and textures this design paints on this car. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'propose_design',
      description: `Propose design changes (palette, regions, options, identity) to the running editor's inbox for human review. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          why: { type: 'string', description: 'Required justification for the proposal' },
          design: {
            type: 'array',
            description: 'List of design diff operations (set-palette, add-region, remove-region, reorder-region, set-option, set-identity, set-region)',
            items: { type: 'object' },
          },
        },
        required: ['why', 'design'],
      },
    },
    {
      name: 'propose_fit',
      description: `Propose placement override or copy changes for this car to the running editor's inbox for human review. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          why: { type: 'string', description: 'Required justification for the proposal' },
          fit: {
            type: 'array',
            description: 'List of fit diff operations (set-override, drop-override, add-copy, drop-copy)',
            items: { type: 'object' },
          },
        },
        required: ['why', 'fit'],
      },
    },
  ];

  const listTools = async () => tools;

  const callTool = async (name, args = {}) => {
    await checkEditorAlive();

    if (JSON.stringify(args ?? {}).includes('"source":"human"') || JSON.stringify(args ?? {}).includes('"source": "human"')) {
      return {
        content: [{ type: 'text', text: 'Refusal: Proposals may not specify source: "human". Confirming bindings is a human action.' }],
        isError: true,
      };
    }

    switch (name) {
      case 'describe_car': return toolDescribeCar(client);
      case 'find_panels': return toolFindPanels(client, args);
      case 'list_treatments': return toolListTreatments(client);
      case 'read_design': return toolReadDesign(client);
      case 'read_fit': return toolReadFit(client);
      case 'report': return toolReport(client);
      case 'propose_design': return toolProposeDesign(client, args);
      case 'propose_fit': return toolProposeFit(client, args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  };

  return { listTools, callTool };
}
