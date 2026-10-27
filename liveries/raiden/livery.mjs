// ---------------------------------------------------------------------------
// raiden — a traditional racing livery, written for the Mazda MX5 Cup.
//
// Two or three colors and one motif repeated, the way the liveries people
// remember are built: a warm white car, an indigo sweep along the lower flank
// under a vermilion pinstripe, an indigo spine down the bonnet, and the number in
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
  car: 'ks_mazda_mx5_cup',
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
        // The sweep: the lower flank in indigo under a vermilion pinstripe, all
        // round the car's sides, nose corners to tail. One long shape fixes the
        // direction of travel and survives motion blur. Placed by height on the
        // car rather than panel by panel: on the MX5 the flank is a door, two
        // quarters, a fender merged with the door on one side and its own
        // island on the other, a sill and the nose's corners. Within 55 degrees
        // of sideways, so it goes round the bumper's corners ahead of the
        // wheels and stops short of the grille.
        { id: 'sweep', treatment: 'fill', band: { height: [0, 0.345], within: 55 }, color: 'indigo' },
        { id: 'pin', treatment: 'fill', band: { height: [0.353, 0.371], within: 55 }, color: 'vermilion' },

        // Down the middle of the bonnet, from its front edge to the scuttle,
        // edged in vermilion. Fills rather than racingStripes, which runs its
        // stripes along the panel's u, and u runs across this bonnet.
        { id: 'spine', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.31, -0.3, 0.38, 1.3], color: 'indigo', safe: false },
        { id: 'spine-edge-left', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.6732, -0.3, 0.0168, 1.3], color: 'vermilion', safe: false },
        { id: 'spine-edge-right', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.31, -0.3, 0.0168, 1.3], color: 'vermilion', safe: false },
        // And on, nose to tail, over the islands the bonnet's does not span
        // onto: down the front bumper to the grille, along the boot lid and
        // down the rear bumper to the tail's pinstripe. The same 0.55 m on
        // each, measured across the car.
        { id: 'spine-nose', treatment: 'stripe', panel: 'centre_nose', at: [0.362, 0, 0.269, 0.3], color: 'indigo', safe: false },
        { id: 'spine-nose-edge-left', treatment: 'stripe', panel: 'centre_nose', at: [0.619, 0, 0.012, 0.3], color: 'vermilion', safe: false },
        { id: 'spine-nose-edge-right', treatment: 'stripe', panel: 'centre_nose', at: [0.362, 0, 0.012, 0.3], color: 'vermilion', safe: false },
        { id: 'spine-boot', treatment: 'stripe', panel: 'centre_tail_lower', at: [0.286, 0, 0.428, 1], color: 'indigo', safe: false },
        { id: 'spine-boot-edge-left', treatment: 'stripe', panel: 'centre_tail_lower', at: [0.695, 0, 0.019, 1], color: 'vermilion', safe: false },
        { id: 'spine-boot-edge-right', treatment: 'stripe', panel: 'centre_tail_lower', at: [0.286, 0, 0.019, 1], color: 'vermilion', safe: false },
        { id: 'spine-tail', treatment: 'stripe', panel: 'centre_tail', at: [0.385, 0, 0.235, 0.47], color: 'indigo', safe: false },
        { id: 'spine-tail-edge-left', treatment: 'stripe', panel: 'centre_tail', at: [0.61, 0, 0.01, 0.47], color: 'vermilion', safe: false },
        { id: 'spine-tail-edge-right', treatment: 'stripe', panel: 'centre_tail', at: [0.385, 0, 0.01, 0.47], color: 'vermilion', safe: false },

        // The number in a white roundel low on the door, across the sweep's
        // edge so it reads against both colors.
        { id: 'roundel-left', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.2675, 0.324, 0.625, 0.32], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-left-edge', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.2675, 0.324, 0.625, 0.32], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.425, 0.3715, 0.31, 0.225], rotate: 'auto', text: '{number}', color: 'indigo', scale: 1, weight: 900 },

        // The driver under it, with the flag they race under ahead of the
        // name. Mirrored, the flag would keep to the front of the car on both
        // sides, which on the right puts it after the name: the right flank's
        // text runs the other way along its panel, so it is placed there by
        // hand, past the name's start.
        { id: 'flag-left', treatment: 'decal', image: 'flag-jp', panel: 'left_mid', at: [0.11, 0.615, 0.12, 0.084], rotate: 'auto' },
        { id: 'flag-right', treatment: 'decal', image: 'flag-jp', panel: 'right_mid', at: [0.77, 0.061, 0.12, 0.084], rotate: 'auto' },
        { id: 'driver-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.1, 0.15, 0.14, 0.45], rotate: 'auto', text: '{driver}', color: 'indigo', weight: 800, tracking: 0.1, anchor: 'start' },

        // The team, large along the top of the rear haunch, where a
        // three-quarter view and a camera above the track see it squarely.
        { id: 'team-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.08, 0.37, 0.134, 0.41], rotate: 'auto', text: '{team}', color: 'indigo', weight: 900, tracking: 0.14 },

        // A secondary sponsor on the rear quarter, over the arch.
        { id: 'sponsor-b-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.47, 0.42, 0.134, 0.3], rotate: 'auto', text: 'HALCYON', color: 'indigo', weight: 800 },

        // The primary sponsor on the bonnet, white in the spine, across the
        // car so it reads from in front of it.
        { id: 'sponsor-bonnet', treatment: 'text', panel: 'centre_front', at: [0.33, 0.66, 0.34, 0.15], rotate: 0, text: 'ORBIT FUELS', color: 'white', weight: 900, tracking: 0.08 },

        // The sweep round the tail, at the flanks' own heights, so it meets
        // them at the corners, and the team in white on it, for the car you
        // are following.
        { id: 'tail-sweep', treatment: 'fill', band: { height: [0, 0.345], side: 'rear' }, color: 'indigo' },
        { id: 'tail-pin', treatment: 'fill', band: { height: [0.353, 0.371], side: 'rear' }, color: 'vermilion' },
        { id: 'team-tail', treatment: 'text', panel: 'centre_tail', at: [0.404, 0.53, 0.192, 0.21], text: '{team}', color: 'white', weight: 900, tracking: 0.14, rotate: 'auto' },

        // The number again on the boot lid, for the cameras above the track:
        // the car has no roof to carry it.
        { id: 'roundel-boot', treatment: 'ring', panel: 'centre_tail_lower', at: [0.35, 0.185, 0.3, 0.63], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-boot-edge', treatment: 'ring', panel: 'centre_tail_lower', at: [0.35, 0.185, 0.3, 0.63], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-boot', treatment: 'text', panel: 'centre_tail_lower', at: [0.392, 0.33, 0.216, 0.34], rotate: 'auto', text: '{number}', color: 'indigo', scale: 1, weight: 900 },
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
