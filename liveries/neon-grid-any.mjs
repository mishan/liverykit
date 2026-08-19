// ---------------------------------------------------------------------------
// neon-grid-any — the same design, written to travel.
//
// neon-grid.mjs is authored against one car: it names that car's texture roles
// and that car's panels, and it looks better for it. This is the same palette
// and the same treatments written entirely in the shared VOCABULARY, so it
// renders on any car whose profile carries a `bind` table.
//
//   node bin/liverykit.mjs neon-grid-any --profile cars/rss_formula_rss_4.json
//   node bin/liverykit.mjs neon-grid-any --profile cars/abarth500.json
//
// Two rules follow from being portable, and both are real constraints rather
// than stylistic choices:
//
//   NO PANEL NAMES. Panels are named per car — `left_mid_upper` exists on one
//   model and not on another — so a portable design can only address whole
//   textures. Fixing that is what panel TAGS are for; until then, artwork here
//   has to be the kind that cannot land wrong. An even field, concentric rings
//   and edge-anchored bands look deliberate wherever the unwrap puts them.
//   Position-dependent artwork is what breaks.
//
//   NO PER-ROLE DIFFERENCES. A term can bind to several textures — `body` on
//   the RSS4 covers both chassis textures — and a design that has never seen the
//   car cannot say "and something different on the rear one". Portable means
//   coarser. That is the trade, and it is worth being explicit about it rather
//   than pretending the layer is free.
//
// Anything a given car lacks is reported at the end of the build and skipped.
// ---------------------------------------------------------------------------

export default {
  name: 'Neon Grid (portable)',
  folder: 'neon_grid_any',
  // Deliberately no `car`. This livery does not know which car it is for, which
  // is the entire point; pass --profile to say.
  packs: ['core', 'synthwave'],

  identity: {
    driver: 'A. Driver',
    team: 'Neon Grid',
    number: '7',
    country: '',
  },

  palette: {
    base: '#12203A',
    accent: '#00F0FF',
    hot: '#FF2D95',
    violet: '#8A2BE2',
    ink: '#080B14',
    white: '#F2F2F7',
    rubber: '#121216',
  },

  render: {
    seed: 'neon-grid-01',
    glowSigma: 14,
    font: 'DejaVu Sans',
  },

  surfaces: {
    // The bodywork. Circuit traces over a dark field, with the horizon band
    // anchored to the texture edge so it reads as deliberate on any unwrap.
    body: {
      background: 'base',
      regions: [
        { treatment: 'grid', pitch: 0.045, color: 'accent', opacity: 0.18, width: 1.5 },
        { treatment: 'traces', lanes: 22, width: 4, color: 'accent', opacity: 0.75, glow: true },
        { treatment: 'halftone', color: 'violet', cell: 38, dot: 0.12, opacity: 0.35 },

        // Selected by TAG rather than by panel name, which is what lets this run
        // on a car nobody wrote it for. Each of these renders once per matching
        // panel: on the RSS4 the left flank is 10 islands and on the Abarth 12,
        // and the design does not need to know or care.
        //
        // `visible` keeps the work where someone can see it. A third of a car's
        // surface faces the ground or sits inside a bodywork cavity, and paint
        // there costs render time and buys nothing.
        { treatment: 'piping', tags: ['left', 'visible'], at: [0, 0.06, 1, 0.10], count: 1, color: 'accent', width: 6, glow: true, safe: false },
        { treatment: 'piping', tags: ['right', 'visible'], at: [0, 0.06, 1, 0.10], count: 1, color: 'accent', width: 6, glow: true, safe: false },

        // `shared` means the panel is drawn from the same texels as another —
        // mirrored bodywork, or four wheels on one rim texture. Such a panel
        // deliberately claims no side, because it is on both, so the two rules
        // above skip it and this one catches it.
        //
        // How much falls here is a fact about the car's unwrap, not about the
        // design: the RSS Formula 4 has none on its bodywork, since an
        // open-wheeler unwraps each flank separately for asymmetric aero and
        // sponsor space. The Abarth has five, because a mass-produced road car
        // mirrors its sides to halve the texture.
        { treatment: 'piping', tags: ['shared', 'visible'], at: [0, 0.06, 1, 0.10], count: 1, color: 'accent', width: 6, glow: true, safe: false },

        { treatment: 'halftone', tags: ['upper', 'visible'], color: 'hot', cell: 30, dot: 0.10, opacity: 0.30, safe: false },

        { treatment: 'stripe', at: [0, 0.47, 1, 0.022], color: 'hot', glow: true },
        { treatment: 'scanlines', opacity: 0.12 },

        // --- identity ---------------------------------------------------
        //
        // Text is the one thing that cannot be sprayed across every matching
        // panel: a pattern wants all of them, a number wants exactly one, and
        // it wants the one with room for it. `limit: 1` takes the largest
        // match, so this lands on the Abarth's rear quarter (14.8% of the
        // texture) and on the formula car's flank without either being named.
        //
        // The three `at` rects do not overlap, which matters because they do
        // not always land on separate panels: on the RSS4 the number and the
        // team name both resolve to `left_mid`, and they stack instead of
        // colliding. Placement within a panel is the one thing a portable
        // design still has to guess at — nothing here knows which part of a
        // panel is flat — so these sit centred and clear of the edges.
        //
        // `once` keeps identity on the term's PRIMARY texture. `body` on the
        // RSS4 covers two chassis textures, and without this the car wears its
        // number twice.
        //
        // The `id`s are how a FIT adjusts these for one particular car without
        // touching the design — see docs/fitting.md and fits/. Only regions
        // somebody might want to move need one.
        { id: 'driver-left', treatment: 'text', tags: ['left', 'mid', 'upper', 'visible'], limit: 1, once: true,
          at: [0.08, 0.05, 0.84, 0.10], text: '{driver}', color: 'white', tracking: 0.10 },
        { id: 'driver-right', treatment: 'text', tags: ['right', 'mid', 'upper', 'visible'], limit: 1, once: true,
          at: [0.08, 0.05, 0.84, 0.10], text: '{driver}', color: 'white', tracking: 0.10 },

        { id: 'number-left', treatment: 'text', tags: ['left', 'visible'], limit: 1, once: true,
          at: [0.25, 0.22, 0.50, 0.48], text: '{number}', color: 'white', tracking: 0.04 },
        { id: 'number-right', treatment: 'text', tags: ['right', 'visible'], limit: 1, once: true,
          at: [0.25, 0.22, 0.50, 0.48], text: '{number}', color: 'white', tracking: 0.04 },

        { id: 'team-left', treatment: 'text', tags: ['left', 'mid', 'visible'], limit: 1, once: true,
          at: [0.08, 0.78, 0.84, 0.13], text: '{team}', color: 'accent', tracking: 0.14 },
        { id: 'team-right', treatment: 'text', tags: ['right', 'mid', 'visible'], limit: 1, once: true,
          at: [0.08, 0.78, 0.84, 0.13], text: '{team}', color: 'accent', tracking: 0.14 },
      ],
    },

    wing: {
      background: 'ink',
      regions: [
        { treatment: 'traces', lanes: 10, width: 3, color: 'accent', glow: true },
        { treatment: 'scanlines', opacity: 0.18 },
      ],
    },

    // Radially unwrapped on every car that has one, so rings work and nothing
    // else reliably does.
    rims: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.44, width: 0.020, color: 'accent', opacity: 0.9, glow: true },
        { treatment: 'ring', radius: 0.36, width: 0.010, color: 'hot', opacity: 0.7 },
        { treatment: 'halftone', color: 'violet', cell: 30, dot: 0.14, opacity: 0.4 },
      ],
    },

    tyres: {
      background: 'rubber',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 44, dot: 0.17, start: 0, end: 200 },
        { treatment: 'ring', radius: 0.455, width: 0.020, color: 'accent', opacity: 0.85, glow: true },
        { treatment: 'ring', radius: 0.410, width: 0.008, color: 'hot', opacity: 0.70 },
        { treatment: 'scanlines', opacity: 0.16 },
      ],
    },

    interior: {
      background: 'ink',
      regions: [
        { treatment: 'traces', lanes: 14, width: 3, color: 'accent', opacity: 0.5 },
        { treatment: 'scanlines', opacity: 0.2 },
      ],
    },

    // The belt texture is an atlas of narrow strips running DOWN it, so traces
    // are rotated a quarter turn to run along each strap rather than across
    // every one of them like rungs on a ladder.
    belts: {
      background: 'ink',
      regions: [
        { treatment: 'traces', rotate: 90, lanes: 14, width: 3, color: 'accent' },
      ],
    },

    steeringWheel: {
      background: 'ink',
      regions: [
        { treatment: 'traces', lanes: 8, width: 3, color: 'accent', glow: true },
      ],
    },

    metalTrim: {
      background: 'ink',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 26, dot: 0.16, opacity: 0.5 },
      ],
    },

    heatShield: {
      background: 'ink',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 30, dot: 0.15, opacity: 0.6 },
        { treatment: 'scanlines', opacity: 0.18 },
      ],
    },

    // Driver kit. A 4:1 horizontal wrap on most cars, so horizontal bands only —
    // a vertical split lands somewhere unpredictable on the head.
    helmet: {
      background: 'base',
      regions: [
        { treatment: 'fill', at: [0, 0, 1, 0.38], color: 'ink' },
        { treatment: 'traces', at: [0, 0.02, 1, 0.28], lanes: 4, width: 5 },
        { treatment: 'stripe', at: [0, 0.46, 1, 0.028], color: 'accent', glow: true },
      ],
    },

    suit: {
      background: 'ink',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 34, dot: 0.14, opacity: 0.45 },
        { treatment: 'stripe', at: [0, 0.12, 1, 0.02], color: 'accent', glow: true },
      ],
    },

    gloves: {
      background: 'ink',
      regions: [
        { treatment: 'stripe', at: [0, 0.06, 1, 0.03], color: 'accent', glow: true },
      ],
    },

    crew: {
      background: 'ink',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 30, dot: 0.12, opacity: 0.4 },
      ],
    },

    numberPlate: {
      background: 'ink',
      regions: [
        { treatment: 'text', at: [0.06, 0.22, 0.88, 0.56], text: '{number}', color: 'accent', tracking: 0.14 },
      ],
    },
  },
};
