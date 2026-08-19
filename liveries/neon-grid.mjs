// ---------------------------------------------------------------------------
// neon-grid — the worked example.
//
// Read this first. It exercises every part of the system: named panels, both
// built-in packs, identity tokens, safe areas, and the escape hatch for
// unmapped textures.
//
// The one idea worth absorbing: coordinates are relative to a NAMED PANEL from
// the car profile, not to the texture.
//
//     { treatment: 'fill', panel: 'nose', at: [0, 0, 1, 0.4] }
//
// reads "the front 40% of the nose, wherever that happens to be on this car",
// and keeps working if you point the livery at a different car profile. Whereas
//
//     { treatment: 'fill', at: [0.10, 0.25, 0.30, 0.20] }
//
// reads "this literal rectangle in the texture", and only makes sense for the
// one model it was measured against. Both are supported — the second is the
// escape hatch for textures nobody has mapped yet, like the helmet below.
//
// Build it:   node bin/liverykit.mjs neon-grid
// ---------------------------------------------------------------------------

export default {
  name: 'Neon Grid',
  folder: 'neon_grid',            // installs to skins/neon_grid/
  car: 'rss_formula_rss_4',       // loads cars/rss_formula_rss_4.json
  packs: ['core', 'synthwave'],   // 'core' alone if you don't want the house style

  // Substituted into any text via {driver}, {team}, {number}.
  identity: {
    driver: 'A. Driver',
    team: 'Neon Grid',
    number: '7',
    country: '',
  },

  // Treatments refer to these by name, so renaming a colour here changes the
  // whole livery and never leaves a stray hex behind. Raw '#RRGGBB' still works
  // anywhere a colour is expected.
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
    seed: 'neon-grid-01',   // any string; --seed re-rolls all procedural placement
    glowSigma: 14,          // scales with render size automatically
    font: 'DejaVu Sans',    // must be installed and visible to fontconfig
  },

  paint: {
    body: {
      background: 'base',
      regions: [
        // --- RIGHT FLANK -------------------------------------------------
        // On this car the right flank's columns run rear->front, so at-x 1 is
        // the nose end. The car profile records that; the livery just has to
        // put its dark territory at the correct end.
        //
        // `safe: false` opts out of the safe-area check. Backgrounds want to
        // reach the island edge; type does not, which is why the text regions
        // below leave it on.
        { treatment: 'fill',     panel: 'flankRight', at: [0.675, 0, 0.325, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankRight', at: [0.375, 0, 0.350, 1], safe: false, color: 'ink', angle: 180, cell: 26 },
        { treatment: 'traces',   panel: 'flankRight', at: [0.700, 0.05, 0.275, 0.90], safe: false, lanes: 7, width: 4 },
        { treatment: 'stripe',   panel: 'flankRight', at: [0, 0.44, 1, 0.035], safe: false, color: 'accent', glow: true },
        { treatment: 'text',     panel: 'flankRight', at: [0.0375, 0.49, 0.5625, 0.22], text: '{team}',   color: 'white', tracking: 0.10 },
        { treatment: 'text',     panel: 'flankRight', at: [0.0375, 0.72, 0.3750, 0.13], text: '{driver}', color: 'white', tracking: 0.22 },
        { treatment: 'text',     panel: 'flankRight', at: [0.7325, 0.10, 0.2500, 0.28], text: '{number}', color: 'accent', glow: true, tracking: 0.06 },

        // --- LEFT FLANK --------------------------------------------------
        // A separate UV island running the other way, so the same composition
        // is written mirrored and the car reads identically from both sides.
        // Note it is NOT a mirrored island — text comes out the right way round
        // on both flanks without any trickery.
        { treatment: 'fill',     panel: 'flankLeft', at: [0, 0, 0.325, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankLeft', at: [0.275, 0, 0.350, 1], safe: false, color: 'ink', angle: 0, cell: 26 },
        { treatment: 'traces',   panel: 'flankLeft', at: [0.025, 0.05, 0.275, 0.90], safe: false, lanes: 7, width: 4 },
        { treatment: 'stripe',   panel: 'flankLeft', at: [0, 0.44, 1, 0.035], safe: false, color: 'accent', glow: true },
        { treatment: 'text',     panel: 'flankLeft', at: [0.4000, 0.49, 0.5625, 0.22], text: '{team}',   color: 'white', tracking: 0.10 },
        { treatment: 'text',     panel: 'flankLeft', at: [0.5875, 0.72, 0.3750, 0.13], text: '{driver}', color: 'white', tracking: 0.22 },
        { treatment: 'text',     panel: 'flankLeft', at: [0.0175, 0.10, 0.2500, 0.28], text: '{number}', color: 'accent', glow: true, tracking: 0.06 },

        // --- FORWARD FLANK -------------------------------------------------
        // A SEPARATE island from the main flank, adjacent to it on the car. The
        // profile's `adjacent` list is what reveals this; nothing in the texture
        // suggests the two belong together. Carrying the dark territory across
        // the seam is what makes the sidepod read as one surface.
        { treatment: 'fill',     panel: 'flankRightFront', at: [0, 0, 0.55, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankRightFront', at: [0.45, 0, 0.45, 1], safe: false, color: 'ink', angle: 0, cell: 26 },
        { treatment: 'stripe',   panel: 'flankRightFront', at: [0, 0.44, 1, 0.035], safe: false, color: 'accent', glow: true },
        { treatment: 'fill',     panel: 'flankLeftFront', at: [0.45, 0, 0.55, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankLeftFront', at: [0.10, 0, 0.45, 1], safe: false, color: 'ink', angle: 180, cell: 26 },
        { treatment: 'stripe',   panel: 'flankLeftFront', at: [0, 0.44, 1, 0.035], safe: false, color: 'accent', glow: true },

        // --- NOSE ---------------------------------------------------------
        // at-y 0 is the tip. The crest runs down one texture column, so a spine
        // stripe along the car is a VERTICAL rectangle here — the kind of thing
        // that is obvious from a calibration screenshot and impossible to guess.
        { treatment: 'fill',     panel: 'nose', at: [0, 0, 1, 0.40], color: 'ink', safe: false },
        { treatment: 'halftone', panel: 'nose', at: [0, 0.34, 1, 0.32], color: 'ink', angle: 90, cell: 26, safe: false },
        { treatment: 'traces',   panel: 'nose', at: [0.0333, 0.02, 0.9333, 0.36], lanes: 8, width: 4, safe: false },
        { treatment: 'stripe',   panel: 'nose', at: [0.5667, 0, 0.0367, 1], color: 'accent', glow: true, safe: false },

        // --- ENGINE COVER --------------------------------------------------
        { treatment: 'fill',   panel: 'engineCover', color: 'ink', safe: false },
        { treatment: 'grid',   panel: 'engineCover', horizon: 0.22, cols: 14, rows: 9, color: 'hot', safe: false },
        { treatment: 'stripe', panel: 'engineCover', at: [0.4833, 0, 0.0333, 1], color: 'accent', glow: true },

        // --- WINGS ----------------------------------------------------------
        // These panels are marked low/medium confidence in the car profile, so
        // the artwork stays coarse. Flat bands survive being 3% out of place;
        // lettering does not.
        { treatment: 'fill',   panel: 'rearWing', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'rearWing', at: [0, 0.2750, 1, 0.0625], color: 'accent', glow: true },
        { treatment: 'stripe', panel: 'rearWing', at: [0, 0.3875, 1, 0.0375], color: 'violet' },

        { treatment: 'fill', panel: 'frontWingEndplateRight', color: 'ink', safe: false },
        { treatment: 'fill', panel: 'frontWingEndplateLeft',  color: 'ink', safe: false },
        { treatment: 'fill', panel: 'frontWing', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'frontWing', at: [0.44, 0, 0.12, 1], color: 'accent', glow: true },

        // No panel and no `at` means the whole texture.
        { treatment: 'scanlines', opacity: 0.07 },
      ],
    },

    // ------------------------------------------------------------------
    // SEATBELTS
    //
    // Four separate textures — webbing, hardware, shoulder pads, and a small
    // logo strip. Straight across your chest in every cockpit shot, and the
    // hardware scores 90% visible from the seat AND 86% from trackside, which
    // is rare: most surfaces are one or the other.
    //
    // Only the hardware is big enough to have mapped panels. The other three
    // are small single-purpose textures where the whole image IS the surface,
    // so they use absolute coordinates. Belt webbing is a long strip, so bands
    // running the length of the texture read as stripes along the belt.
    // ------------------------------------------------------------------

    belts: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'buckles', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'buckles', at: [0, 0.42, 1, 0.16], color: 'accent', glow: true, safe: false },
      ],
    },

    // Webbing. The texture is an ATLAS of ~10 straps, each a narrow column
    // running DOWN it — v is along the strap, u is across its 5 cm width. The
    // first attempt used full-width horizontal bands, which crossed every
    // strap like a rung and chopped the lettering into fragments. rotate:90
    // turns the trace pattern a quarter turn so it follows the belt instead.
    belts_2: {
      background: 'ink',
      regions: [
        { treatment: 'traces', panel: 'straps', rotate: 90, lanes: 14, width: 3,
          color: 'accent', safe: false },
      ],
    },

    // Shoulder pads — black with a cyan edge, same grain as the straps.
    belts_3: {
      background: 'ink',
      regions: [
        { treatment: 'traces', rotate: 90, at: [0, 0, 1, 1], lanes: 8, width: 3, color: 'accent' },
      ],
    },

    // Belt logo strip — a badge slot, like the wheel hub.
    belts_4: {
      background: 'ink',
      regions: [
        { treatment: 'text', at: [0.05, 0.28, 0.9, 0.44], text: '{team}', color: 'accent', glow: true, tracking: 0.10 },
      ],
    },

    // ------------------------------------------------------------------
    // WHEELS
    //
    // On an open-wheeler the front wheels are permanently in your field of
    // view from the cockpit. The face is a .png in the model, not a .dds, and
    // only 28x28 — the pipeline writes PNG for these rather than forcing a DDS
    // encode that could never match the filename anyway. Rendered at 256 for
    // free detail, since UVs are fractions.
    // ------------------------------------------------------------------

    rimFace: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.46, width: 0.035, color: 'accent', glow: true },
        { treatment: 'ring', radius: 0.30, width: 0.02,  color: 'base' },
        { treatment: 'halftone', at: [0, 0, 1, 1], color: 'base', cell: 26, dot: 0.16, start: 0, end: 200 },
      ],
    },

    // Shared metal — suspension, calipers, hubs, roll hoop, rim spokes. 83
    // meshes on one 256x256 texture, so this is the one change that touches
    // the most parts at once. Kept restrained for that reason: a dark base
    // reads as anodised rather than repainted, and nothing here implies a
    // shape that could land wrong on an unrelated component.
    metal: {
      background: '#15151C',
      regions: [
        { treatment: 'halftone',  at: [0, 0, 1, 1], color: 'base', cell: 22, dot: 0.10, start: 0, end: 200 },
        { treatment: 'scanlines', opacity: 0.14 },
      ],
    },

    // ------------------------------------------------------------------
    // COCKPIT
    //
    // If you drive in cockpit view, this is the livery you actually look at
    // for a whole race — and it's on entirely separate textures from the
    // bodywork, so an exterior-only livery leaves it stock.
    //
    // These panels were chosen by `visibleFromCockpit` in the car profile,
    // which ray-casts from the driver's eye rather than from trackside.
    // The two measures disagree sharply: the flanks score 99% outside and 6%
    // from the seat, the tub interior the other way about. Visibility isn't a
    // property of a surface, it's a property of a surface and a viewpoint.
    // ------------------------------------------------------------------

    // Tub interior — the sides in your peripheral vision.
    interior: {
      background: 'ink',
      regions: [
        { treatment: 'fill',      panel: 'tub', color: 'ink', safe: false },
        { treatment: 'halftone',  panel: 'tub', at: [0, 0.55, 1, 0.45], color: 'base', angle: 90, cell: 22, safe: false },
        { treatment: 'stripe',    panel: 'tub', at: [0, 0.46, 1, 0.03], color: 'accent', glow: true, safe: false },
        { treatment: 'scanlines', opacity: 0.10 },
      ],
    },

    // The surround you see over the nose, plus the tub sides. `surround` is
    // 100% visible from the seat — the most valuable panel on the car for a
    // cockpit driver, and worth nothing at all from trackside.
    interior_2: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'surround', color: 'base', safe: false },
        { treatment: 'traces', panel: 'surround', at: [0.05, 0.05, 0.9, 0.9], lanes: 5, width: 3, safe: false },
        { treatment: 'fill',   panel: 'sideLeft',  color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'sideRight', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'sideLeft',  at: [0, 0.4, 1, 0.06], color: 'accent', glow: true, safe: false },
        { treatment: 'stripe', panel: 'sideRight', at: [0, 0.4, 1, 0.06], color: 'accent', glow: true, safe: false },
        { treatment: 'scanlines', opacity: 0.08 },
      ],
    },

    // Steering wheel face — dead ahead, and never occluded by your hands.
    steeringWheel: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'face', color: 'ink', safe: false },
        // Trace the rim rather than the middle: from the seat the wheel reads
        // as a dark silhouette, so contrast has to sit on its outline.
        { treatment: 'traces', panel: 'face', at: [0.02, 0.02, 0.96, 0.20], lanes: 4, width: 5,
          color: 'accent', safe: false },
        { treatment: 'traces', panel: 'face', at: [0.02, 0.78, 0.96, 0.20], lanes: 4, width: 5,
          color: 'accent', safe: false },
        { treatment: 'traces', panel: 'face', rotate: 90, at: [0.02, 0.02, 0.20, 0.96], lanes: 4, width: 5,
          color: 'accent', safe: false },
        { treatment: 'traces', panel: 'face', rotate: 90, at: [0.78, 0.02, 0.20, 0.96], lanes: 4, width: 5,
          color: 'accent', safe: false },
        { treatment: 'fill',   panel: 'spoke', color: 'base', safe: false },
      ],
    },

    // Wheel plastics and button console.
    steeringWheel_2: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'console', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'console', at: [0, 0.06, 1, 0.04], color: 'accent', glow: true, safe: false },
      ],
    },

    // Hand grips. Partly hidden by your hands, so colour blocks only.
    grips: {
      background: 'ink',
      regions: [
        { treatment: 'fill',     panel: 'gripLeft',  color: 'ink', safe: false },
        { treatment: 'fill',     panel: 'gripRight', color: 'ink', safe: false },
        { treatment: 'halftone', panel: 'gripLeft',  at: [0, 0.6, 1, 0.4], color: 'base', angle: 90, cell: 18, safe: false },
        { treatment: 'halftone', panel: 'gripRight', at: [0, 0.6, 1, 0.4], color: 'base', angle: 90, cell: 18, safe: false },
      ],
    },

    // Wheel hub logo. This texture exists solely to carry a badge, so the
    // whole image IS the sticker — no panel, absolute coordinates.
    wheelLogo: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.44, width: 0.05, color: 'accent', glow: true },
        { treatment: 'ring', radius: 0.34, width: 0.02, color: 'base' },
        { treatment: 'text', at: [0.1, 0.38, 0.8, 0.24], text: '{team}', color: 'white', tracking: 0.08 },
        { treatment: 'text', at: [0.3, 0.6, 0.4, 0.18], text: '{number}', color: 'accent', glow: true, tracking: 0.06 },
      ],
    },

    // Exhaust heat-shield foil. Ships gold — rgb(107,92,12) — and sits only on
    // the right-hand side, because that is where the exhaust exits. It was the
    // last off-palette thing on the car, and the asymmetry is what gave it
    // away: a livery bug would have been symmetric.
    heatShield: {
      background: 'ink',
      regions: [
        { treatment: 'halftone', at: [0, 0, 1, 1], color: 'accent', cell: 40, dot: 0.14, start: 0, end: 200 },
        { treatment: 'scanlines', opacity: 0.12 },
      ],
    },

    // The car's SECOND body texture. Only visible by reading the model: no
    // stock skin folder makes it obvious, and the first version of this livery
    // left this whole area of the car unpainted.
    bodyRear: {
      background: 'base',
      regions: [
        { treatment: 'fill',   panel: 'main', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'main', at: [0.46, 0, 0.08, 1], color: 'accent', glow: true, safe: false },
        { treatment: 'scanlines', opacity: 0.07 },
      ],
    },

    // One texture covers tread and sidewall, and its layout is only half
    // mapped — rings come back as clean sidewall bands, so it is radially
    // unwrapped, but the tread's share is not isolated. When you don't know a
    // layout, choose artwork that cannot land wrong: an even field and
    // concentric rings look deliberate wherever they fall. Position-dependent
    // artwork is what breaks.
    tyres: {
      background: 'rubber',
      regions: [
        { treatment: 'halftone', color: 'accent', cell: 44, dot: 0.17, start: 0, end: 200 },
        { treatment: 'ring', radius: 0.455, width: 0.020, color: 'accent', opacity: 0.85, glow: true },
        { treatment: 'ring', radius: 0.410, width: 0.008, color: 'hot',    opacity: 0.70 },
        { treatment: 'ring', radius: 0.315, width: 0.012, color: 'violet', opacity: 0.55 },
        { treatment: 'scanlines', opacity: 0.16 },
      ],
    },

    // The helmet's panels are barely mapped, so this uses absolute texture
    // coordinates — the escape hatch. It is a 4:1 horizontal wrap, which means
    // horizontal bands only: a vertical split lands somewhere unpredictable on
    // the head. Anything important is repeated across the strip so it shows up
    // wherever the seam happens to fall. The helmet ends up ~40px on screen, so
    // fine detail is wasted.
    helmet: {
      background: 'base',
      regions: [
        { treatment: 'fill',   at: [0, 0,    1, 0.38],  color: 'ink' },
        { treatment: 'traces', at: [0, 0.02, 1, 0.28],  lanes: 4, width: 5 },
        { treatment: 'stripe', at: [0, 0.46, 1, 0.028], color: 'accent', glow: true },
        { treatment: 'text',   at: [0.02, 0.62, 0.20, 0.24], text: '{number}', color: 'white', tracking: 0.12 },
        { treatment: 'text',   at: [0.52, 0.62, 0.20, 0.24], text: '{number}', color: 'white', tracking: 0.12 },
      ],
    },

    // Suits are read at distance and in shadow. Bold blocks and piping survive;
    // small type does not.
    suit: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'torso', color: 'base', safe: false },
        { treatment: 'piping', panel: 'torso', at: [0, 0, 1, 0.14], count: 1, color: 'accent', width: 7, glow: true, safe: false },
        { treatment: 'text',   panel: 'torso', at: [0.1, 0.30, 0.8, 0.24], text: '{team}', color: 'white', tracking: 0.12 },
        { treatment: 'piping', panel: 'legs',  count: 3, color: 'violet', width: 5, angle: 6, safe: false },
      ],
    },

    gloves: {
      background: 'ink',
      regions: [
        { treatment: 'fill',   panel: 'back', color: 'base', safe: false },
        { treatment: 'piping', panel: 'back', at: [0, 0, 1, 0.12], count: 1, color: 'accent', width: 6, glow: true, safe: false },
      ],
    },

    // The pit crew show up during stops and in replays. Free win, usually
    // forgotten.
    crew: {
      background: 'ink',
      regions: [
        { treatment: 'fill', panel: 'torso', color: 'base', safe: false },
        { treatment: 'text', panel: 'torso', at: [0.1, 0.30, 0.8, 0.30], text: '{team}', color: 'white', tracking: 0.12 },
      ],
    },
  },
};
