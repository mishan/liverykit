// ---------------------------------------------------------------------------
// neon-grid — the worked example.
//
// Read this first. It exercises every part of the system: named panels, both
// built-in packs, identity tokens, safe areas, panels laid upside down or as a
// mirror image, and the escape hatch for parts the profile has no panel for.
//
// The one idea worth absorbing: coordinates are relative to a NAMED PANEL from
// the car profile, not to the texture.
//
//     { treatment: 'fill', panel: 'nose', at: [0.6, 0, 0.4, 1] }
//
// reads "the front 40% of the nose, wherever that happens to be on this car",
// and keeps working if you point the livery at a different car profile. Whereas
//
//     { treatment: 'fill', at: [0.3352, 0.066, 0.0832, 0.1175] }
//
// reads "this literal rectangle in the texture", and only makes sense for the
// one model it was measured against. Both are supported — the second is the
// escape hatch for parts nobody has mapped, like the wings below.
//
// It is written for the Tatuus FA01, which comes with the base game.
//
// Build it:   node bin/liverykit.mjs neon-grid
// ---------------------------------------------------------------------------

export default {
  name: 'Neon Grid',
  folder: 'neon_grid',            // installs to skins/neon_grid/
  car: 'tatuusfa1',               // loads cars/tatuusfa1.json
  packs: ['core', 'synthwave'],   // 'core' alone if you don't want the house style

  // Substituted into any text via {driver}, {team}, {number}.
  identity: {
    driver: 'A. Driver',
    team: 'Neon Grid',
    number: '7',
    country: '',
  },

  // Treatments refer to these by name, so renaming a color here changes the
  // whole livery and never leaves a stray hex behind. Raw '#RRGGBB' still works
  // anywhere a color is expected.
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

  // `paint` names this car's textures directly, by the role the profile gave
  // each one. The bodywork is all on one sheet, SkinBase.dds, which the profile
  // calls `skinbase`. The panel names below — flankRight, nose — are aliases
  // the profile's `aliases` block gives the generated names (right_mid,
  // centre_front), so a design reads as the car rather than as the unwrap.
  paint: {
    skinbase: {
      background: 'base',
      regions: [
        // --- RIGHT FLANK -------------------------------------------------
        // The chassis side, nose to sidepod. On this car the right flank is
        // laid upside down in its texture: at-x 0 is the nose end and at-y 0
        // is the BOTTOM of the car. The profile records that as a
        // textRotation of 180, and `rotate: 'auto'` turns the lettering back
        // upright; fills and stripes have no up and do not need it.
        //
        // `safe: false` opts out of the safe-area check. Backgrounds want to
        // reach the island edge; type does not, which is why the text regions
        // below leave it on.
        { treatment: 'fill',     panel: 'flankRight', at: [0, 0, 0.32, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankRight', at: [0.26, 0, 0.34, 1], safe: false, color: 'ink', angle: 0, cell: 26 },
        { treatment: 'traces',   panel: 'flankRight', at: [0.02, 0.05, 0.28, 0.90], safe: false, lanes: 7, width: 4 },
        { treatment: 'stripe',   panel: 'flankRight', at: [0, 0.40, 1, 0.035], safe: false, color: 'accent', glow: true },
        { treatment: 'text',     panel: 'flankRight', at: [0.52, 0.68, 0.42, 0.20], text: '{team}',   color: 'white', tracking: 0.10, rotate: 'auto' },
        { treatment: 'text',     panel: 'flankRight', at: [0.52, 0.49, 0.30, 0.17], text: '{driver}', color: 'white', tracking: 0.22, rotate: 'auto' },
        { treatment: 'text',     panel: 'flankRight', at: [0.24, 0.40, 0.22, 0.56], text: '{number}', color: 'accent', glow: true, tracking: 0.06, rotate: 'auto' },

        // --- LEFT FLANK --------------------------------------------------
        // The same composition, written for an island laid out the other way:
        // at-x 0 is the TAIL end and at-y 0 the top. It is also a mirror image
        // in the texture — the profile marks it `reflected` — so lettering
        // painted as-is reads backwards on the car, and no rotation can fix
        // it. `rotate: 'auto'` mirrors it back; leave it off and the build
        // says the text will read backwards rather than letting you find out
        // in the game.
        { treatment: 'fill',     panel: 'flankLeft', at: [0.68, 0, 0.32, 1], safe: false, color: 'ink' },
        { treatment: 'halftone', panel: 'flankLeft', at: [0.40, 0, 0.34, 1], safe: false, color: 'ink', angle: 180, cell: 26 },
        { treatment: 'traces',   panel: 'flankLeft', at: [0.70, 0.05, 0.28, 0.90], safe: false, lanes: 7, width: 4 },
        { treatment: 'stripe',   panel: 'flankLeft', at: [0, 0.565, 1, 0.035], safe: false, color: 'accent', glow: true },
        { treatment: 'text',     panel: 'flankLeft', at: [0.06, 0.12, 0.42, 0.20], text: '{team}',   color: 'white', tracking: 0.10, rotate: 'auto' },
        { treatment: 'text',     panel: 'flankLeft', at: [0.18, 0.34, 0.30, 0.17], text: '{driver}', color: 'white', tracking: 0.22, rotate: 'auto' },
        { treatment: 'text',     panel: 'flankLeft', at: [0.54, 0.04, 0.22, 0.56], text: '{number}', color: 'accent', glow: true, tracking: 0.06, rotate: 'auto' },

        // --- SIDEPODS ------------------------------------------------------
        // Three islands a side — the front of the pod, its flank behind that,
        // and its top — none of them adjacent to the chassis flank in the
        // texture. The profile's `adjacent` list is what reveals that they
        // meet on the car; nothing in the texture suggests they belong
        // together.
        { treatment: 'fill',   panel: 'sidepodRight',     color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'sidepodLeft',      color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'sidepodRightRear', color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'sidepodLeftRear',  color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'sidepodRightRear', at: [0, 0.44, 1, 0.05], color: 'violet', safe: false },
        { treatment: 'stripe', panel: 'sidepodLeftRear',  at: [0, 0.44, 1, 0.05], color: 'violet', safe: false },
        { treatment: 'halftone', panel: 'sidepodTopRight', color: 'ink', angle: 90, cell: 22, safe: false },
        { treatment: 'halftone', panel: 'sidepodTopLeft',  color: 'ink', angle: 90, cell: 22, safe: false },

        // --- NOSE ---------------------------------------------------------
        // The top of the nose runs along the texture's x axis, tip at at-x 1,
        // so the spine stripe along the car is a HORIZONTAL band here — the
        // kind of thing that is obvious from the profile and impossible to
        // guess from the texture.
        { treatment: 'fill',     panel: 'nose', at: [0.60, 0, 0.40, 1], color: 'ink', safe: false },
        { treatment: 'halftone', panel: 'nose', at: [0.34, 0, 0.32, 1], color: 'ink', angle: 0, cell: 26, safe: false },
        { treatment: 'traces',   panel: 'nose', at: [0.62, 0.04, 0.36, 0.40], lanes: 6, width: 4, safe: false },
        { treatment: 'stripe',   panel: 'nose', at: [0, 0.48, 1, 0.04], color: 'accent', glow: true, safe: false },
        { treatment: 'fill',     panel: 'noseRight', color: 'ink', safe: false },
        { treatment: 'fill',     panel: 'noseLeft',  color: 'ink', safe: false },

        // --- ENGINE COVER --------------------------------------------------
        // Split down the spine into two islands, each with at-y 0 on the
        // spine, so one thin stripe on each makes one stripe on the car.
        { treatment: 'fill',   panel: 'engineCoverRight', color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'engineCoverLeft',  color: 'ink', safe: false },
        { treatment: 'grid',   panel: 'engineCoverRight', horizon: 0.22, cols: 14, rows: 9, color: 'hot', safe: false },
        { treatment: 'grid',   panel: 'engineCoverLeft',  horizon: 0.22, cols: 14, rows: 9, color: 'hot', safe: false },
        { treatment: 'stripe', panel: 'engineCoverRight', at: [0, 0, 1, 0.05], color: 'accent', glow: true, safe: false },
        { treatment: 'stripe', panel: 'engineCoverLeft',  at: [0, 0, 1, 0.05], color: 'accent', glow: true, safe: false },
        { treatment: 'fill',   panel: 'airbox', color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'airbox', at: [0.47, 0, 0.06, 1], color: 'accent', glow: true, safe: false },

        // --- WINGS ----------------------------------------------------------
        // The endplates are panels. The wing planes are not: the profile
        // drops islands under 40 vertices as slivers, and these are flat,
        // low-polygon surfaces whose islands fall under that. So they are
        // painted by absolute texture rectangle, measured once against this
        // car's model — the escape hatch. Flat color survives being a little
        // out; lettering would not.
        { treatment: 'fill',   panel: 'rearWingEndplateRight', color: 'ink', safe: false },
        { treatment: 'fill',   panel: 'rearWingEndplateLeft',  color: 'ink', safe: false },
        { treatment: 'stripe', panel: 'rearWingEndplateRight', at: [0, 0.2750, 1, 0.0625], color: 'accent', glow: true },
        { treatment: 'stripe', panel: 'rearWingEndplateLeft',  at: [0, 0.2750, 1, 0.0625], color: 'accent', glow: true },
        { treatment: 'stripe', panel: 'rearWingEndplateRight', at: [0, 0.3875, 1, 0.0375], color: 'violet' },
        { treatment: 'stripe', panel: 'rearWingEndplateLeft',  at: [0, 0.3875, 1, 0.0375], color: 'violet' },
        { treatment: 'fill',   at: [0.4255, 0.0016, 0.2292, 0.2462], color: 'ink' },    // rear wing planes
        { treatment: 'stripe', at: [0.6110, 0.0019, 0.0080, 0.2459], color: 'accent', glow: true },

        { treatment: 'fill', panel: 'frontWingEndplateRight', color: 'ink', safe: false },
        { treatment: 'fill', panel: 'frontWingEndplateLeft',  color: 'ink', safe: false },
        { treatment: 'fill', at: [0.0022, 0.0051, 0.1544, 0.2521], color: 'ink' },    // front wing flaps
        { treatment: 'fill', at: [0.3352, 0.0017, 0.0832, 0.2458], color: 'ink' },    // front wing main plane
        { treatment: 'stripe', at: [0.3352, 0.1180, 0.0832, 0.0120], color: 'accent', glow: true },

        // No panel and no `at` means the whole texture.
        { treatment: 'scanlines', opacity: 0.07 },
      ],
    },

    // ------------------------------------------------------------------
    // MECHANICAL PARTS
    //
    // Uprights, hubs, the suspension arms: two textures shared by dozens of
    // meshes, so this is the one change that touches the most parts at once.
    // Kept restrained for that reason: a dark base reads as anodised rather
    // than repainted, and nothing here implies a shape that could land wrong
    // on an unrelated component.
    // ------------------------------------------------------------------
    mechparts: {
      background: '#15151C',
      regions: [
        { treatment: 'halftone',  at: [0, 0, 1, 1], color: 'base', cell: 22, dot: 0.10, start: 0, end: 200 },
        { treatment: 'scanlines', opacity: 0.14 },
      ],
    },
    details: {
      background: '#15151C',
      regions: [
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
    // The profile ray-casts visibility from the driver's eye as well as from
    // trackside, as `visibleFromCockpit`, and the two disagree sharply: the
    // flanks score 100% outside and 0% from the seat, the steering wheel the
    // other way about. Visibility isn't a property of a surface, it's a
    // property of a surface and a viewpoint.
    // ------------------------------------------------------------------
    interior: {
      background: 'ink',
    },
    steeringWheel: {
      background: 'ink',
      regions: [
        { treatment: 'traces', panel: 'face', at: [0.02, 0.02, 0.96, 0.20], lanes: 4, width: 5, safe: false },
        { treatment: 'traces', panel: 'face', at: [0.02, 0.78, 0.96, 0.20], lanes: 4, width: 5, safe: false },
      ],
    },

    // The blurred wheel the game swaps in at speed. Left stock, it sits in the
    // same place as the painted rims and draws the car's own artwork over them.
    rims_2: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.46, width: 0.035, color: 'accent', glow: true },
        { treatment: 'ring', radius: 0.30, width: 0.02,  color: 'base' },
      ],
    },
  },

  // --- surfaces -------------------------------------------------------------
  //
  // Keyed by VOCABULARY TERM rather than by this car's texture names, and
  // translated through the profile's "bind" table. `paint` above names roles
  // literally, which a design written for one car can afford; these would
  // carry over to another car unchanged.
  //
  // A term this car does not have is a reported no-op, not an error.
  surfaces: {
    rims: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.46, width: 0.035, color: 'accent', glow: true },
        { treatment: 'ring', radius: 0.30, width: 0.02,  color: 'base' },
        { treatment: 'halftone', at: [0, 0, 1, 1], color: 'base', cell: 26, dot: 0.16, start: 0, end: 200 },
      ],
    },
    // No tyres: this car's tyre texture is a tiled material, its UVs repeating
    // round the tyre rather than mapping it once, so nothing can be placed on
    // it and the build would only be able to say so.
    // The pit crew show up during stops and in replays. Free win, usually
    // forgotten.
    crew: {
      background: 'base',
    },
  },
};
