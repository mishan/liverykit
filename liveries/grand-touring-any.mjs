// ---------------------------------------------------------------------------
// grand-touring-any — the portable example that is not neon.
//
// The same rules as neon-grid-any, which is the place to read why: no panel
// names, no per-role differences, panels selected by TAG and lettering kept on
// the term's primary texture. What differs is the vocabulary. This one is the
// `classic` pack — a hockey stick down each flank, twin stripes above it, a
// chequered tail, chevrons on the wing and a row of sponsors — over a
// gradient from `core`, in a palette that belongs to no team. The sponsors
// are invented.
//
//   node bin/liverykit.mjs grand-touring-any --profile tatuusfa1
//   node bin/liverykit.mjs grand-touring-any --profile abarth500
// ---------------------------------------------------------------------------

export default {
  name: 'Grand Touring (portable)',
  folder: 'grand_touring_any',
  packs: ['core', 'classic'],

  identity: {
    driver: 'A. Driver',
    team: 'Northwind',
    number: '12',
    country: '',
  },

  palette: {
    navy: '#14223F',
    deep: '#0A1226',
    white: '#F4F1E8',
    red: '#C8302B',
    gold: '#D9A441',
    ink: '#101014',
    rubber: '#121216',
  },

  render: {
    seed: 'grand-touring-01',
    font: 'DejaVu Sans, Verdana, sans-serif',
  },

  surfaces: {
    body: {
      background: 'navy',
      regions: [
        // Each visible panel darkens toward the bottom of the car. Turned with
        // the panel, so "the bottom" is the car's on a door laid sideways.
        { treatment: 'gradient', tags: ['visible'], rotate: 'auto', from: 'navy', to: 'deep', angle: 90, safe: false },

        // Along the car on either flank, turning up at the back, with twin
        // stripes above: on the side's main panel only. Sprayed across every
        // panel of a side, a band at the bottom of a sill or a stripe under a
        // window line lands where bodywork hides it, and on the NSX both did.
        // Named, because `at` is in the texture's frame and `rotate` turns
        // only what is drawn inside it: on a door laid sideways in the sheet,
        // as the Abarth's are, a box along the texture runs up the car, and a
        // fit has to say where along the car is.
        //
        // Which end is the back depends on the side: upright, the left flank
        // is seen with the nose to the left, the right with it to the right.
        { id: 'stick-left', treatment: 'hockeyStick', tags: ['left', 'mid', 'visible'], limit: 1,
          at: [0, 0.56, 1, 0.36], rotate: 'auto', color: 'white', thickness: 0.22, rise: 'end', safe: false },
        { id: 'stick-right', treatment: 'hockeyStick', tags: ['right', 'mid', 'visible'], limit: 1,
          at: [0, 0.08, 1, 0.36], rotate: 'auto', color: 'white', thickness: 0.22, rise: 'start', safe: false },

        { id: 'stripes-left', treatment: 'racingStripes', tags: ['left', 'mid', 'visible'], limit: 1,
          at: [0, 0.10, 1, 0.07], rotate: 'auto', color: 'red', count: 2, gap: 0.6, edge: 'gold', safe: false },
        { id: 'stripes-right', treatment: 'racingStripes', tags: ['right', 'mid', 'visible'], limit: 1,
          at: [0, 0.83, 1, 0.07], rotate: 'auto', color: 'red', count: 2, gap: 0.6, edge: 'gold', safe: false },

        { treatment: 'checkers', tags: ['centre', 'tail', 'visible'], at: [0, 0.4, 1, 0.2], rotate: 'auto',
          color: 'white', rows: 2, safe: false, optional: true },

        // --- identity ----------------------------------------------------
        //
        // A number on a white board and the team beside it, on the side's main
        // panel; the right side is the left mirrored as the Tatuus lays its
        // flanks out. A roundel would be the period look, but on a formula
        // car's flank, 558 mm tall, a disc with the name under it holds a
        // two-digit number 104 mm tall and the 140 that reads from trackside
        // does not fit. The ids are neon-grid-any's, so fits read the same.
        { id: 'board-left', treatment: 'fill', tags: ['left', 'visible'], limit: 1, once: true,
          at: [0.28, 0.17, 0.24, 0.60], color: 'white' },
        { id: 'board-right', treatment: 'fill', tags: ['right', 'visible'], limit: 1, once: true,
          at: [0.48, 0.23, 0.24, 0.60], color: 'white' },

        { id: 'number-left', treatment: 'text', tags: ['left', 'visible'], limit: 1, once: true,
          at: [0.30, 0.20, 0.20, 0.54], rotate: 'auto', text: '{number}', color: 'ink', tracking: 0.02 },
        { id: 'number-right', treatment: 'text', tags: ['right', 'visible'], limit: 1, once: true,
          at: [0.50, 0.26, 0.20, 0.54], rotate: 'auto', text: '{number}', color: 'ink', tracking: 0.02 },

        { id: 'team-left', treatment: 'text', tags: ['left', 'mid', 'visible'], limit: 1, once: true,
          at: [0.54, 0.32, 0.38, 0.22], rotate: 'auto', text: '{team}', color: 'gold', tracking: 0.12 },
        { id: 'team-right', treatment: 'text', tags: ['right', 'mid', 'visible'], limit: 1, once: true,
          at: [0.08, 0.46, 0.38, 0.22], rotate: 'auto', text: '{team}', color: 'gold', tracking: 0.12 },

        { id: 'sponsors-left', treatment: 'sponsorRow', tags: ['left', 'rear', 'visible'], limit: 1, once: true,
          at: [0.10, 0.36, 0.80, 0.26], rotate: 'auto', text: 'KESTREL | HALCYON',
          color: 'navy', background: 'white' },
        { id: 'sponsors-right', treatment: 'sponsorRow', tags: ['right', 'rear', 'visible'], limit: 1, once: true,
          at: [0.10, 0.46, 0.80, 0.26], rotate: 'auto', text: 'KESTREL | HALCYON',
          color: 'navy', background: 'white' },
      ],
    },

    wing: {
      background: 'navy',
      regions: [
        { treatment: 'chevrons', at: [0.1, 0.25, 0.8, 0.5], color: 'gold', count: 4 },
      ],
    },

    rims: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.44, width: 0.02, color: 'gold' },
      ],
    },

    tyres: {
      background: 'rubber',
      regions: [
        { treatment: 'band', along: 0.8, width: 0.08, color: 'white' },
      ],
    },

    helmet: {
      background: 'navy',
      regions: [
        { treatment: 'racingStripes', at: [0, 0.4, 1, 0.12], color: 'red', edge: 'gold' },
      ],
    },

    suit: {
      background: 'navy',
      regions: [
        { treatment: 'stripe', at: [0, 0.12, 1, 0.03], color: 'gold' },
      ],
    },
  },
};
