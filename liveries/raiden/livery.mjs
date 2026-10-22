// ---------------------------------------------------------------------------
// raiden — a traditional racing livery, written for the Honda NSX GT3 Evo.
//
// Two or three colors and one motif repeated, the way the liveries people
// remember are built: a warm white car, an indigo sweep along the lower flank
// under a vermilion pinstripe, an indigo spine nose to tail, and the number in
// a white roundel on the door. Vermilion is kept to the extremities, where it
// sharpens the silhouette. The sponsors are invented.
//
//   node bin/liverykit.mjs raiden
//
// A livery folder, for the flag in decals/ beside it.
// ---------------------------------------------------------------------------

export default {
  name: 'Raiden',
  folder: 'raiden',
  car: 'ac_friends_honda_nsx_gt3_evo',
  packs: ['core', 'classic'],

  identity: {
    driver: 'R. HAYASE',
    team: 'RAIDEN',
    number: '27',
    country: 'JP',
  },

  palette: {
    white: '#F2EFE6',
    indigo: '#1B2A6B',
    vermilion: '#F0412A',
    ink: '#111111',
  },

  render: {
    seed: 'raiden-01',
    font: 'DejaVu Sans, Verdana, sans-serif',
  },

  // A pool of vermilion on the ground under each sill, at night, with the
  // headlights. The editor and the preview draw it too.
  underglow: 'vermilion',

  surfaces: {
    body: {
      background: 'white',
      regions: [
        // The aero kit in black, as carbon: splitter, skirts and diffuser, the
        // car's lowest panels all round up to 260 mm, as find_space's aero
        // layout found them, less the four the bumpers hide (a quarter of each
        // is seen). Under the sweep, which it rests on.
        { id: 'kit-centre_nose_upper', treatment: 'fill', panel: 'centre_nose_upper', color: 'ink', safe: false },
        { id: 'kit-centre_nose_lower_2', treatment: 'fill', panel: 'centre_nose_lower_2', color: 'ink', safe: false },
        { id: 'kit-left_front_upper', treatment: 'fill', panel: 'left_front_upper', at: [0, 0.827, 1, 0.1687], color: 'ink', safe: false },
        { id: 'kit-right_front_upper', treatment: 'fill', panel: 'right_front_upper', at: [0, 0.0048, 1, 0.1687], color: 'ink', safe: false },
        { id: 'kit-left_front', treatment: 'fill', panel: 'left_front', at: [0, 0.6378, 1, 0.2169], color: 'ink', safe: false },
        { id: 'kit-right_front', treatment: 'fill', panel: 'right_front', at: [0, 0.1457, 1, 0.217], color: 'ink', safe: false },
        { id: 'kit-left_mid_lower', treatment: 'fill', panel: 'left_mid_lower', color: 'ink', safe: false },
        { id: 'kit-right_mid_lower', treatment: 'fill', panel: 'right_mid_lower', color: 'ink', safe: false },
        { id: 'kit-centre_tail_lower', treatment: 'fill', panel: 'centre_tail_lower', color: 'ink', safe: false },

        // The sweep: the lower flank in indigo under a vermilion pinstripe. One
        // long shape fixes the direction of travel and survives motion blur;
        // the door and the quarter are two islands, so it spans them.
        //
        // Every flank region is written once, for the left, and mirrored onto
        // the right by the profile's measured axes: the NSX's right flank is
        // unwrapped upside down and reversed.
        { id: 'sweep-left', mirror: true, treatment: 'stripe', panel: 'left_mid', span: true,
          at: [-1.5, 0.58, 4, 0.6], rotate: 'auto', color: 'indigo', safe: false },
        { id: 'pin-left', mirror: true, treatment: 'stripe', panel: 'left_mid', span: true,
          at: [-1.5, 0.535, 4, 0.03], rotate: 'auto', color: 'vermilion', safe: false },

        // Down the middle of the car, nose to tail.
        { id: 'spine', treatment: 'racingStripes', panel: 'centre_front', span: true,
          at: [-0.5, 0.36, 4, 0.28], rotate: 'auto', color: 'indigo', count: 1, edge: 'vermilion', edgeWidth: 0.06, safe: false },

        // The number in a white roundel low on the door, across the sweep's
        // edge so it reads against both colors. Laid out by find_space, which
        // keeps all of it on the car, in sight and on bodywork flat enough to
        // read.
        { id: 'roundel-left', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.3684, 0.4241, 0.2971, 0.4092], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-left-edge', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.3684, 0.4241, 0.2971, 0.4092], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.4071, 0.4713, 0.22, 0.3148], rotate: 'auto', text: '{number}', color: 'indigo', scale: 0.767, weight: 900 },

        // The driver under it, with the flag they race under ahead of the
        // name. Mirrored, the flag would keep to the front of the car on both
        // sides, which on the right puts it after the name: the right flank's
        // text runs the other way along its panel, so it is placed there by
        // hand, past the name's start.
        { id: 'flag-left', treatment: 'decal', image: 'flag-jp', panel: 'left_mid', at: [0.25, 0.857, 0.075, 0.072], rotate: 'auto' },
        { id: 'flag-right', treatment: 'decal', image: 'flag-jp', panel: 'right_mid', at: [0.79, 0.071, 0.075, 0.072], rotate: 'auto' },
        { id: 'driver-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.335, 0.8466, 0.45, 0.0924], rotate: 'auto', text: '{driver}', color: 'white', weight: 800, tracking: 0.1, anchor: 'start' },

        // The team, large along the top of the rear haunch, where a
        // three-quarter view and a camera above the track see it squarely.
        { id: 'team-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.237, 0.099, 0.355, 0.107], rotate: 'auto', text: '{team}', color: 'indigo', weight: 900, tracking: 0.14 },

        // Secondary sponsors behind the door, white out of the sweep, on the
        // two spots find_space measured as seen nearly square-on from
        // trackside (12 and 16 degrees off).
        { id: 'sponsor-a-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.149, 0.83, 0.217, 0.08], rotate: 'auto', text: 'KESTREL', color: 'white', weight: 800 },
        { id: 'sponsor-b-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.32, 0.525, 0.217, 0.08], rotate: 'auto', text: 'HALCYON', color: 'indigo', weight: 800 },

        // The primary sponsor on the bonnet, white in the spine, across the
        // car so it reads from in front of it.
        { id: 'sponsor-bonnet', treatment: 'text', panel: 'centre_front', at: [0.2, 0.39, 0.13, 0.22], rotate: 90, text: 'ORBIT FUELS', color: 'white', weight: 900, tracking: 0.08 },

        // The sweep round the tail, under the same pinstripe, and the team in
        // white on it, for the car you are following. Not the number: at the
        // 140 mm a number needs, it ran onto the curve of the fascia.
        { id: 'tail-sweep', treatment: 'fill', panel: 'centre_tail_upper', at: [0, 0.52, 1, 0.48], color: 'indigo', safe: false },
        { id: 'tail-pin', treatment: 'stripe', panel: 'centre_tail_upper', at: [0, 0.47, 1, 0.05], color: 'vermilion', safe: false },
        { id: 'team-tail', treatment: 'text', panel: 'centre_tail_upper', at: [0.404, 0.548, 0.192, 0.268], text: '{team}', color: 'white', weight: 900, tracking: 0.14, rotate: 'auto' },

        // The number again on the roof, for the cameras above the track.
        { id: 'roundel-roof', treatment: 'ring', panel: 'centre_mid', at: [0.607, 0.201, 0.286, 0.312], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-roof-edge', treatment: 'ring', panel: 'centre_mid', at: [0.607, 0.201, 0.286, 0.312], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-roof', treatment: 'text', panel: 'centre_mid', at: [0.644, 0.237, 0.2116, 0.24], rotate: 'auto', text: '{number}', color: 'indigo', scale: 0.767, weight: 900 },
      ],
    },

    numberPlate: {
      background: 'indigo',
      regions: [
        // The sheet is two-sided: the top half is the face the world sees.
        { id: 'banner', treatment: 'text', panel: 'centre_mid_upper_2', at: [0.05, 0.2, 0.9, 0.6], rotate: 'auto', text: 'RAIDEN RACING', color: 'white', tracking: 0.2, weight: 800 },
      ],
    },

    rims: {
      background: 'ink',
      regions: [
        { treatment: 'ring', radius: 0.44, width: 0.02, color: 'vermilion' },
      ],
    },

    // Over the tyre's own sidewall lettering, a vermilion band round the
    // outside of each sidewall, beyond the rim's ring.
    tyres: {
      background: 'stock',
      regions: [
        { treatment: 'band', along: 0.15, width: 0.06, color: 'vermilion' },
      ],
    },
  },
};
