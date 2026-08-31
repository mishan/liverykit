import { CONSTRAINTS } from '../fitment.mjs';

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

  // From `paintedRoles`, not from `surfaces`. A vocabulary term may bind to
  // several textures — the RSS4 spreads its bodywork across two — and
  // `surfaces` holds one entry per term, the primary, because that is the one
  // you edit. Reading painted roles off it marks every secondary as unpainted
  // and offers it for adoption, which would claim a role the design already
  // paints and produce a livery that refuses to resolve.
  //
  // The fallback keeps this working against an editor older than the field
  // rather than reporting every role on the car as free.
  const paintedRoles = new Set(state.paintedRoles ?? state.surfaces.map((s) => s.role));
  const unpaintedSurfaces = [];
  const unpaintable = [];

  for (const info of Object.values(state.roles ?? {})) {
    if (!info.paintable) {
      unpaintable.push({ file: info.file, why: info.why });
    } else if (info.role && !paintedRoles.has(info.role) && !state.design?.paint?.[info.role]) {
      unpaintedSurfaces.push({
        role: info.role,
        file: info.file,
        width: info.width,
        height: info.height,
      });
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        car: state.car,
        textureCount: textures.length,
        totalPanels,
        textures,
        unpaintedSurfaces,
        unpaintable,
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

  const staleSet = new Set();

  for (const note of state.notes ?? []) {
    if (note.status === 'fit-stale' && note.term) {
      staleSet.add(note.term);
    }
  }

  for (const id of Object.keys(fit.regions ?? {})) {
    if (!knownRegionIds.has(id)) {
      staleSet.add(id);
    }
  }

  const copies = { ...(fit.mirrors ?? {}), ...(fit.copies ?? {}) };
  for (const [id, spec] of Object.entries(copies)) {
    if (!knownRegionIds.has(id) && spec?.of && !knownRegionIds.has(spec.of)) {
      staleSet.add(id);
    }
  }

  const staleIds = Array.from(staleSet);

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

/**
 * What is wrong with the design where it sits.
 *
 * Shaped so the worst news is impossible to skim past. An agent handed a flat
 * list will read the first few entries and act; the counts and the `verdict`
 * line are there so that "nine low findings and one high" cannot be summarised
 * as "some minor findings", and so that a run which skipped the geometry checks
 * cannot be reported as a clean one.
 *
 * This tool exists because of a specific failure. Asked to improve a fit, I
 * moved a team name into a part of the texture that no triangle uses — it
 * rendered perfectly and was on no part of the car — and every number available
 * to me at the time said the move was fine.
 */
async function toolCheckFitment(client) {
  const r = await client.checkFitment();
  const findings = r.findings ?? [];
  const count = (sev) => findings.filter((f) => f.severity === sev).length;

  const partial = (r.notChecked?.length ?? 0) > 0 || (r.notPlaced?.length ?? 0) > 0;
  const worst = count('fatal') ? 'fatal' : count('high') ? 'high' : count('low') ? 'low' : 'none';

  const verdict = worst === 'none'
    ? (partial
        ? 'Nothing found BY THE CHECKS THAT RAN. Some did not run — see notChecked and notPlaced.'
        : 'Every check ran and found nothing.')
    : `Worst finding is ${worst}. ${count('fatal')} fatal, ${count('high')} high, ` +
      `${count('low')} low.${partial ? ' Some checks did not run — see notChecked and notPlaced.' : ''}`;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      verdict,
      car: r.car,
      checked: r.checked ?? [],
      notChecked: r.notChecked ?? [],
      notPlaced: r.notPlaced ?? [],
      // Worst first, so truncation loses the least important end.
      findings: [...findings].sort((a, b) =>
        ({ fatal: 0, high: 1, low: 2 })[a.severity] - ({ fatal: 0, high: 1, low: 2 })[b.severity]),
    }, null, 2) }],
  };
}

async function toolRenderView(client, args = {}) {
  // OMITTED and EMPTY are different questions.
  //
  // `if (args.role)` sent an empty string, a stray space or a null down the
  // render-everything path — so a caller that computed a role and got nothing
  // received a whole-car preview and no hint that its role had evaporated.
  // Omitting `role` is a real request; supplying one that is not a usable name
  // is a mistake, and worth saying so.
  //
  // `undefined` is absence; JSON `null` is a value somebody sent, and sending
  // it is the mistake this catches.
  if ('role' in args && args.role !== undefined) {
    const role = typeof args.role === 'string' ? args.role.trim() : '';
    if (!role) {
      return {
        content: [{ type: 'text', text:
          `render_view got role: ${JSON.stringify(args.role)}, which is not a texture role. ` +
          'Omit `role` entirely to render every painted surface.' }],
        isError: true,
      };
    }
    const res = await client.renderSurface(role, args.seed);
    return {
      content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
    };
  }
  const res = await client.previewSurfaces(args.seed);
  return {
    content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
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
      description: `Describe the car profile including texture roles, panel counts, bind table, axes, and unpainted/unpaintable surfaces. ${PROMPT_NOTE}`,
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
      name: 'list_constraints',
      description:
        'List the placement constraints a design region may declare, and what each one ' +
        'means. Constraints live on the DESIGN, not the fit, so they travel to every car. ' +
        'A constraint name that is not on this list is refused rather than ignored, so ' +
        `read this before writing one. ${PROMPT_NOTE}`,
      inputSchema: { type: 'object', properties: {} },
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
      name: 'check_fitment',
      description:
        'Measure what is WRONG with the working design on this car: text landing on text, ' +
        'artwork outside a panel\'s readable area, text too small to read at the car\'s real ' +
        'scale, broken left/right mirroring, placements painted into texture space no triangle ' +
        'uses, and placements the bodywork hides. Call this BEFORE proposing a fit change and ' +
        'AGAIN after, and compare: a change that trades one finding for a worse one is not an ' +
        'improvement. Read `notChecked` — it names checks that did not run, and an empty ' +
        `findings list from a partial run does not mean the design is good. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'render_view',
      description: `Render texture SVG and region placement data for a surface role or the whole car. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Texture role to render (e.g. "ext_skin_sponsors" or "surfaces.body"). Omit for all painted surfaces.' },
          seed: { type: 'string', description: 'Optional render seed string' },
        },
      },
    },
    {
      name: 'propose_design',
      description:
        'Propose design changes (palette, regions, options, identity, constraints, ' +
        "adopt-surface) to the running editor's inbox for human review. Use " +
        'set-constraint to record what a region NEEDS — keepClear, minMm, minOnCar — ' +
        'which is often the right proposal when check_fitment reports the same problem ' +
        'twice: the constraint states the requirement once, on the design, for every car, ' +
        'rather than being re-fixed per car. Call list_constraints first; a name that is ' +
        `not on that list is refused, not ignored. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          why: { type: 'string', description: 'Required justification for the proposal' },
          design: {
            type: 'array',
            description: 'List of design diff operations (set-palette, add-region, remove-region, reorder-region, set-option, set-constraint, set-identity, set-region, adopt-surface). set-constraint takes { op, id, key, value }, where key is one of the names list_constraints returns and value null removes it.',
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
      case 'check_fitment': return toolCheckFitment(client);
      case 'list_constraints':
        return { content: [{ type: 'text', text: JSON.stringify(CONSTRAINTS, null, 2) }] };
      case 'render_view': return toolRenderView(client, args);
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
