import { CONSTRAINTS } from '../fitment.mjs';
import { VIEWS } from '../engine/shot.mjs';
import { EditorUnreachable } from './client.mjs';

// Updated when render_car arrived. The old wording — "you cannot visually see
// the 3D car" — became false and, worse, discouraging: an agent that believes
// it cannot see will not call the tool built so that it can.
const PROMPT_NOTE = '(Note: you cannot see the fitting editor directly, and your proposals '
  + 'go to a human there who accepts or discards them. You CAN see the car: call render_car, '
  + 'which returns a picture of the working design on the model.)';

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

// In profile.mjs, where fitment can reach it too: find_panels tells a planner
// which way a panel runs, and the stripe check holds the draft to the same
// answer, so the two cannot come to disagree.
export { axesOf } from '../profile.mjs';
import { axesOf } from '../profile.mjs';

async function toolFindPanels(client, args) {
  const state = await client.getState();
  // A surface goes by three names — the texture role (`ext_skin_sponsors`),
  // the design's key for it (`surfaces.body`) and the vocabulary term alone
  // (`body`) — and this matched only the first two. The third is the one a
  // design is written in, so an agent asked for `role: "body"` four times,
  // was told four times that there were no panels, and concluded the car had
  // none. An empty answer to a question about a name that does not exist is
  // not an answer; it is refused, with the names that do.
  // `paint.<role>` too, the form find_space and a design's own `paint` block
  // use to name one texture outright.
  const asked = typeof args.role === 'string' ? args.role.replace(/^paint\./, '') : args.role;
  const named = (s) => [s.role, s.from, s.from?.replace(/^(surfaces|paint)\./, '')].includes(asked)
    || s.from === args.role;
  // Every texture the design paints, not only each term's primary: a term can
  // bind several, and a panel on the second is as placeable as one on the first.
  const all = [...state.surfaces, ...(state.secondarySurfaces ?? [])];
  const surfaces = args.role ? all.filter(named) : all;
  if (args.role && !surfaces.length) {
    return {
      content: [{ type: 'text', text: `No surface called ${JSON.stringify(args.role)} on this car. ` +
        `Ask by texture role (or paint.<role>) or by the design's surface: ` +
        `${all.map((s) => `${s.role} (${s.from})`).join(', ')}.` }],
      isError: true,
    };
  }
  const results = [];
  let before = 0;
  const tagsSeen = new Set();
  const unmeasured = [];
  for (const s of surfaces) {
    for (const p of s.panels ?? []) {
      before++;
      for (const t of p.tags ?? []) tagsSeen.add(t);
      if (args.tag && !(p.tags ?? []).includes(args.tag)) continue;
      const area = p.rect ? (p.rect[2] * p.rect[3]) : 0;
      if (typeof args.minArea === 'number' && area < args.minArea) continue;
      if (typeof args.maxAnisotropy === 'number' && p.anisotropy > args.maxAnisotropy) continue;
      if (args.hasMirror === true && !p.mirrorOf) continue;
      if (args.hasMirror === false && p.mirrorOf) continue;
      // A panel nobody measured cannot meet a floor on what was measured. It
      // used to pass, and every primary panel went unmeasured here because the
      // editor's state left `visible` out of them. Left out, it is named: it
      // was dropped without a word unless nothing at all passed, and the RSS 4
      // has nine such panels while the harness asks 0.45 of every run. Tested
      // last, so the count is only what the floor alone left out.
      if (typeof args.minVisibility === 'number' && !(p.visible >= args.minVisibility)) {
        if (typeof p.visible !== 'number') unmeasured.push(`${s.role}.${p.name}`);
        continue;
      }

      results.push({
        role: s.role,
        surface: s.from,
        panel: p.name,
        rect: p.rect,
        area: Number(area.toFixed(4)),
        tags: p.tags,
        visible: p.visible,
        anisotropy: p.anisotropy,
        mirrorOf: p.mirrorOf ?? null,
        // Which way at's x and y run on the car.
        axes: axesOf(p),
      });
    }
  }
  const answer = { count: results.length, panels: results };
  if (unmeasured.length) {
    answer.unmeasured = `${unmeasured.length} panel(s) have no visibility measurement, so minVisibility could ` +
      `not be held to them and left them out: ${unmeasured.slice(0, 12).join(', ')}` +
      `${unmeasured.length > 12 ? `, and ${unmeasured.length - 12} more` : ''}. Ask without minVisibility to see them.`;
  }
  // Nothing passed: say what there was, so the next question can be a better
  // one rather than the same one with the numbers loosened.
  if (!results.length) {
    answer.note = `No panel passed every filter. Before filtering there were ${before} panel(s) on ` +
      `${surfaces.map((s) => s.role).join(', ')}; the tags among them are: ${[...tagsSeen].sort().join(', ') || 'none'}.`;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }],
  };
}

async function toolListTreatments(client) {
  const treatments = await client.getTreatments();
  return {
    content: [{ type: 'text', text: JSON.stringify(treatments, null, 2) }],
  };
}

/**
 * A tool's failure as its answer, except an editor that could not be reached:
 * that goes on to the protocol, which marks it so. Answered here, it came back
 * as this tool refusing, and a client could not tell it from one.
 */
const failed = (e, prefix = '') => {
  if (e instanceof EditorUnreachable) throw e;
  return { content: [{ type: 'text', text: `${prefix}${e.message}` }], isError: true };
};

/**
 * The design or fit a draft makes, without proposing it.
 *
 * A caller building a change as a list of operations otherwise sees only the
 * list — which, from an agent that re-sends whole regions each time it moves
 * one, was sixty operations deep and repeated itself, while the design it
 * amounted to was a handful of regions. Staged by the same code as a
 * proposal, so a draft the inbox would refuse is refused here too.
 */
async function draftApplied(client, args, shape) {
  try {
    const r = await client.checkFitment(draftOf(args));
    return { content: [{ type: 'text', text: JSON.stringify(shape(r), null, 2) }] };
  } catch (e) {
    return failed(e);
  }
}

async function toolReadDesign(client, args = {}) {
  if (draftOf(args)) return draftApplied(client, args, (r) => r.design);
  const state = await client.getState();
  return {
    content: [{ type: 'text', text: JSON.stringify(state.design, null, 2) }],
  };
}

async function toolReadFit(client, args = {}) {
  // The same shape with a draft as without. Returning the bare fit here left
  // out the stale ids the description promises, and changed the shape a caller
  // parses depending on whether it passed a proposal.
  if (draftOf(args)) {
    return draftApplied(client, args, (r) => ({
      fit: r.fit, staleIds: r.staleIds, ...(r.staleIdsError ? { staleIdsError: r.staleIdsError } : {}),
    }));
  }
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
async function toolCheckFitment(client, args = {}) {
  let r;
  try {
    r = await client.checkFitment(draftOf(args), args.count ?? null);
  } catch (e) {
    // A draft the inbox would refuse is refused here too, in the same words,
    // and that is an answer about the draft rather than a broken tool.
    return failed(e);
  }
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
      // Which of those the car's profile cannot support. Left out, a caller
      // gating on notChecked could only fail every draft on such a car.
      unsupported: r.unsupported ?? [],
      notPlaced: r.notPlaced ?? [],
      // Worst first, so truncation loses the least important end.
      findings: [...findings].sort((a, b) =>
        ({ fatal: 0, high: 1, low: 2 })[a.severity] - ({ fatal: 0, high: 1, low: 2 })[b.severity]),
      // Passed through when the editor counted it, which it does for a
      // proposal: how much of each whole piece each view shows.
      ...(r.inView ? { inView: r.inView, inViewAt: r.inViewAt } : {}),
    }, null, 2) }],
  };
}

async function toolFindSpace(client, args = {}) {
  try {
    const r = await client.findSpace(args);
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  } catch (e) {
    return failed(e);
  }
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

/**
 * The draft a measuring tool was asked about, or null for the working state.
 *
 * Same shape as a proposal and staged by the same code, so a draft that
 * measures clean is one propose_design will take. `why` is not asked for: a
 * draft is not being offered to anyone, and the reason belongs on the
 * proposal that eventually is.
 */
function draftOf(args) {
  const d = args?.proposal;
  if (d === undefined || d === null) return null;
  // A string is the likeliest mistake — the JSON of a draft rather than the
  // draft — and read as an object it had no `design`, so it measured as the
  // working design and passed.
  if (typeof d !== 'object' || Array.isArray(d)) {
    throw new Error('A draft must be an object { design: [...ops], fit: [...ops] }; ' +
      `got ${Array.isArray(d) ? 'a list' : `a ${typeof d}`}: ${String(JSON.stringify(d)).slice(0, 200)}.`);
  }
  // Whatever was sent goes on as sent, `null` included, and the staging
  // refuses anything but a list. Only a key left out means "no operations".
  return { design: d.design === undefined ? [] : d.design, fit: d.fit === undefined ? [] : d.fit };
}

const DRAFT_SCHEMA = {
  type: 'object',
  description:
    'Optional. Operations to apply ON TOP of the working design before answering, in the ' +
    'shape propose_design takes: { design: [...ops], fit: [...ops] }. Nothing is proposed ' +
    'and nothing in the editor changes — this is how to measure a change before offering it. ' +
    'Design operations are refused when the editor was opened on a .mjs livery, which it cannot ' +
    'write back; fit operations still work there.',
  properties: {
    design: { type: 'array', items: { type: 'object' } },
    fit: { type: 'array', items: { type: 'object' } },
  },
};

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
      fit: args.fit ?? [],
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', proposalId: res.id, why: args.why }) }],
    };
  } catch (e) {
    return failed(e, 'Proposal refused: ');
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
    return failed(e, 'Proposal refused: ');
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
      description: 'Find panels in the car profile filtered by tag, role, visibility, size/area, anisotropy, or mirror. ' +
        'Each panel\'s "axes" says which way the x and y of `at` run on the car. An axis that was not measured ' +
        'clearly is null, and "unclear" says why; do not guess it. ' +
        `${PROMPT_NOTE}`,
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
      description: `Read the working design as currently held in the fitting editor. Pass \`proposal\` to read the design those operations would make instead, without proposing it. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { proposal: DRAFT_SCHEMA },
      },
    },
    {
      name: 'read_fit',
      description: `Read the working fit as currently held in the fitting editor, including stale region ids. Pass \`proposal\` to read the fit those operations would make instead. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { proposal: DRAFT_SCHEMA },
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
      name: 'find_space',
      description:
        'Where on a panel a shape of a given size fits whole: all of it on the car, all of it ' +
        'visible from trackside, and as far as possible from any edge, shut line or hidden area. ' +
        'Measured by sweeping the panel with the ray casting check_fitment uses. A panel\'s box is ' +
        'not the panel — its middle is often against a window frame, an arch or a shut line — so ' +
        'ask this before placing a roundel, logo or number box. Returns the roomiest spots as ' +
        'panel-relative `at` rectangles, each with its clearance in mm, and a coarse map of the ' +
        `panel, texture top first ('#' clean, '.' not). ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          panel: { type: 'string', description: 'Panel name, as find_panels lists it' },
          role: { type: 'string', description: 'Texture role or surface, when the panel name is on more than one' },
          widthMm: { type: 'number', description: 'Width of the shape on the car, in mm (not with largest)' },
          heightMm: { type: 'number', description: 'Height on the car, in mm; defaults to widthMm, as a roundel is' },
          marginMm: { type: 'number', description: 'Only spots with at least this much clean bodywork all round (default 0)' },
          count: { type: 'number', description: 'How many spots (default 5)' },
          largest: { type: 'boolean', description: 'Instead of a size, sweep sizes and return the LARGEST shape of the given aspect that fits whole, with its spot' },
          aspect: { type: 'number', description: 'With largest: the shape\'s height over its width (a roundel is 1; for a number and a name together, use layout)' },
          layout: {
            type: 'object',
            description: 'Instead of a size: lay out a race number in a white roundel with a name under it, as large ' +
              'as the panel allows, and return the regions ready to use (roundel, number, and the name on one ' +
              'line or two) with the capital heights they measure. Tries the group\'s proportions, sizes the ' +
              'letters by the arithmetic check_fitment holds them to, keeps the number\'s letters inside the ' +
              'disc, and splits the name only when one line would cost the number more than a tenth of its ' +
              'size. Follows the panel\'s own turn. marginMm defaults to 30 here.',
            properties: {
              number: { type: 'string', description: 'The race number as it is drawn, e.g. "85"' },
              name: { type: 'string', description: 'The name under it, e.g. "NEON DOLL RACING"' },
            },
            required: ['number', 'name'],
          },
          stripe: {
            type: 'object',
            description: 'Instead of a size: lay out a stripe along the car, nose to tail, as a band of the given ' +
              'width at a given distance from the centreline, and return the regions ready to use: one for every ' +
              'panel of this sheet the band crosses seen from above (bonnet, roof, a hatch set into it, engine ' +
              'cover, deck, the top of the rear wing), each with the "at" that puts the band in the same place ' +
              'on that panel and the stripe constraint that holds the pieces together, and what check_fitment ' +
              'still finds with them, if anything. Glass, vents and openings get no piece; a panel the band ' +
              'crosses too little of to lay one on is listed under skipped, with why. With this, panel is ' +
              'any panel of the sheet the stripe is painted on.',
            properties: {
              widthMm: { type: 'number', description: 'The stripe\'s width on the car, in mm' },
              offsetMm: { type: 'number', description: 'Its centre\'s distance from the car\'s centreline, in mm, left positive (default 0)' },
              name: { type: 'string', description: 'The stripe\'s name, for its ids and its constraint (default "centre")' },
            },
            required: ['widthMm'],
          },
          aero: {
            type: 'object',
            description: 'Instead of a size: lay out a ground-effect kit, the front splitter, the side skirts and ' +
              'the rear diffuser: the car\'s lowest panels all round, from the bottom of its bodywork up to ' +
              'heightMm, returned as regions ready to use, with which part of the car each is on. A panel the ' +
              'world sees lying wholly inside that height is filled whole; a taller one on a flank, such as the ' +
              'rear of a front wing, gets the kit up to the line of the kit panel next to it; a door, or any panel ' +
              'the line would only clip, is left out, listed under skipped with why. With this, panel is any panel ' +
              'of the sheet the kit is painted on.',
            properties: {
              heightMm: { type: 'number', description: 'How far up the car, in mm from the bottom of the bodywork, a panel may reach and still be part of the kit' },
              name: { type: 'string', description: 'The kit\'s name, for its ids (default "aero")' },
            },
            required: ['heightMm'],
          },
          cellMm: { type: 'number', description: 'The sweep\'s cell size on the car, in mm (default 50): smaller is finer, and slower to sweep' },
        },
        required: ['panel'],
      },
    },
    {
      name: 'render_car',
      description:
        'Render the working design on the car and RETURN THE IMAGE, so you can look at it. ' +
        'You cannot otherwise see the car: the editor draws in a browser you have no access ' +
        'to. Call this after proposing a change and before claiming it is an improvement. ' +
        'Views: ' + [...Object.keys(VIEWS), 'sheet'].join(', ') + '. "sheet" is six labelled views in ' +
        'one picture (three-quarter, left, right, top, front, rear-left), the cheapest way to look all ' +
        'round; it and "top" are the views that see the bonnet, roof and rear deck squarely. ' +
        'Unpainted parts wear the car\'s own ' +
        'textures, where the model carries them. Note the limits — no normal maps, no ' +
        'environment reflections and one fixed light rig, so it answers "does the artwork land ' +
        'where I said" and not ' +
        `"is this exactly the game". ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          view: { type: 'string', description: `One of: ${[...Object.keys(VIEWS), 'sheet'].join(', ')}` },
          width: { type: 'number', description: 'Pixels across, 200-1400 (default 760); a sheet 400-2400 (default 1400)' },
          height: { type: 'number', description: 'Pixels down, 150-900 (default 460); a sheet 300-1440 (default 840)' },
          proposal: DRAFT_SCHEMA,
        },
      },
    },
    {
      name: 'check_fitment',
      description:
        'Measure what is WRONG with the working design on this car: text landing on text, ' +
        'artwork outside a panel\'s readable area, text too small to read at the car\'s real ' +
        'scale, broken left/right mirroring, placements painted into texture space no triangle ' +
        'uses, and placements the bodywork hides. With a proposal it also counts, in pixels, how ' +
        'much of each number, word, ring and anything declaring minVisible each of the six views ' +
        'in render_car\'s sheet shows (inView), and reports hidden-in-view where the view in which ' +
        'a piece is largest, or one that shows it nearly as large, has part of it behind something. ' +
        'Call this BEFORE proposing a fit change and ' +
        'AGAIN after, and compare: a change that trades one finding for a worse one is not an ' +
        'improvement. Read `notChecked` — it names checks that did not run, and an empty ' +
        'findings list from a partial run does not mean the design is good. An entry also in ' +
        '`unsupported` is one this car\'s profile cannot measure, which no draft can change. Pass `proposal` ' +
        'to measure a change BEFORE offering it: a proposal only reaches the working design ' +
        `once a person accepts it. ${PROMPT_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          proposal: DRAFT_SCHEMA,
          count: {
            type: 'object',
            description: 'Optional, with a proposal: the pictures being judged, as render_car was given them ' +
              '({ view, width, height }; a sheet counts each view at the size of one of its cells). inView is ' +
              'counted at that frame so it describes those pictures. Default 900x540 per view.',
            properties: { view: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } },
          },
        },
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
        'set-constraint to record what a region NEEDS — keepClear, minMm, minOnCar, minVisible, minMargin, ' +
        'groupWith, stripe — ' +
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
          fit: {
            type: 'array',
            description: 'Optional fit operations, as propose_fit takes them, for placing the regions ' +
              'this same proposal adds — so the person reviews one change and not two halves of it.',
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
      case 'read_design': return toolReadDesign(client, args);
      case 'read_fit': return toolReadFit(client, args);
      case 'report': return toolReport(client);
      case 'render_car': {
        // Reported, not thrown. Without a car model there is no picture, and the
        // useful answer is "no model" — a blank image would look like a car
        // wearing nothing, which is a lie about the design rather than a gap.
        try {
          const { png, skipped, absent } = await client.shoot(
            args.view ?? 'left', args.width, args.height, draftOf(args));
          const content = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
          // Named, not silently absent. Transparent surfaces with no artwork —
          // glass, emissive masks — are left out rather than drawn as grey
          // slabs, and a caller reading the picture should know that a part of
          // the car is missing on purpose.
          if (skipped) {
            content.push({ type: 'text', text:
              `${skipped} transparent surface(s) are not drawn: neither the design nor the ` +
              'model supplies artwork for them, and grey would misrepresent something that ' +
              'is see-through.' });
          }
          // The other half of the same honesty. The car's own textures are what
          // the unpainted parts wear here; a model that cannot give one up
          // leaves that part bare grey, which otherwise reads as a design that
          // paints nothing there.
          if (absent) {
            content.push({ type: 'text', text:
              `${absent} of the car's own texture(s) could not be read from the model, so the ` +
              'parts wearing them are drawn bare grey. An encrypted kn5 has none of them, ' +
              'and that is not a fault in the design.' });
          }
          return { content };
        } catch (e) {
          return failed(e);
        }
      }
      case 'check_fitment': return toolCheckFitment(client, args);
      case 'find_space': return toolFindSpace(client, args);
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
