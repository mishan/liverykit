// ---------------------------------------------------------------------------
// raiden — a traditional racing livery, written for the Mazda MX5 Cup.
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
        // The sweep: the lower flank in indigo under a vermilion pinstripe. One
        // long shape fixes the direction of travel and survives motion blur;
        // the door and the rear quarter are separate islands, so it spans
        // them. It starts at the door: carried onto the front fender, it ran
        // diagonally up the right one and into the grille.
        //
        // Every flank region is written once, for the left, and mirrored onto
        // the right by the profile's measured axes: the MX5's right flank is
        // unwrapped upside down.
        { id: 'sweep-left', mirror: true, treatment: 'stripe', panel: 'left_mid', span: true,
          at: [0.58, -1.5, 0.6, 2.5], rotate: 'auto', color: 'indigo', safe: false },
        { id: 'pin-left', mirror: true, treatment: 'stripe', panel: 'left_mid', span: true,
          at: [0.535, -1.5, 0.03, 2.5], rotate: 'auto', color: 'vermilion', safe: false },

        // And forward over the front fenders and round the corners ahead of
        // the wheels, at the door's height as the model measures it. Spanning
        // cannot carry it there the same way on both sides: the left fender is
        // one island with the door, the right one its own, and the corners are
        // the nose's. The left fender's box stops short of the mirror cap,
        // which shares its texture rectangle.
        { id: 'sweep-fender-left', treatment: 'stripe', panel: 'left_front', at: [0.51, 0.47, 0.49, 0.23], color: 'indigo', safe: false },
        { id: 'pin-fender-left', treatment: 'stripe', panel: 'left_front', at: [0.472, 0.47, 0.026, 0.23], color: 'vermilion', safe: false },
        { id: 'sweep-fender-right', treatment: 'stripe', panel: 'right_front', at: [0, 0, 0.421, 0.45], color: 'indigo', safe: false },
        { id: 'pin-fender-right', treatment: 'stripe', panel: 'right_front', at: [0.436, 0, 0.03, 0.45], color: 'vermilion', safe: false },
        // The sill under the right door is an island of its own, where the
        // left one is part of the fender's, which the sweep already reaches.
        // All of it is below the sweep's top edge.
        { id: 'sill-right', treatment: 'stripe', panel: 'right_mid_upper', at: [0, 0, 0.42, 1], color: 'indigo', safe: false },
        { id: 'sweep-corner-left', treatment: 'stripe', panel: 'centre_nose', at: [0.75, 0.4, 0.25, 0.6], color: 'indigo', safe: false },
        { id: 'pin-corner-left', treatment: 'stripe', panel: 'centre_nose', at: [0.75, 0.37, 0.25, 0.03], color: 'vermilion', safe: false },
        { id: 'sweep-corner-right', treatment: 'stripe', panel: 'centre_nose', at: [0, 0.4, 0.25, 0.6], color: 'indigo', safe: false },
        { id: 'pin-corner-right', treatment: 'stripe', panel: 'centre_nose', at: [0, 0.37, 0.25, 0.03], color: 'vermilion', safe: false },

        // Down the middle of the bonnet, from its front edge to the scuttle,
        // edged in vermilion. Fills rather than racingStripes, which runs its
        // stripes along the panel's u, and u runs across this bonnet.
        { id: 'spine', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.36, -0.3, 0.28, 1.3], color: 'indigo', safe: false },
        { id: 'spine-edge-left', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.6232, -0.3, 0.0168, 1.3], color: 'vermilion', safe: false },
        { id: 'spine-edge-right', treatment: 'stripe', panel: 'centre_front', span: true, at: [0.36, -0.3, 0.0168, 1.3], color: 'vermilion', safe: false },

        // The number in a white roundel low on the door, across the sweep's
        // edge so it reads against both colors.
        { id: 'roundel-left', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.4241, 0.388, 0.4092, 0.19], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-left-edge', mirror: true, treatment: 'ring', panel: 'left_mid', at: [0.4241, 0.388, 0.4092, 0.19], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.4713, 0.413, 0.3148, 0.14], rotate: 'auto', text: '{number}', color: 'indigo', scale: 0.767, weight: 900 },

        // The driver under it, with the flag they race under ahead of the
        // name. Mirrored, the flag would keep to the front of the car on both
        // sides, which on the right puts it after the name: the right flank's
        // text runs the other way along its panel, so it is placed there by
        // hand, past the name's start.
        { id: 'flag-left', treatment: 'decal', image: 'flag-jp', panel: 'left_mid', at: [0.85, 0.675, 0.086, 0.06], rotate: 'auto' },
        { id: 'flag-right', treatment: 'decal', image: 'flag-jp', panel: 'right_mid', at: [0.064, 0.1, 0.086, 0.06], rotate: 'auto' },
        { id: 'driver-left', mirror: true, treatment: 'text', panel: 'left_mid', at: [0.8466, 0.215, 0.0924, 0.45], rotate: 'auto', text: '{driver}', color: 'white', weight: 800, tracking: 0.1, anchor: 'start' },

        // The team, large along the top of the rear haunch, where a
        // three-quarter view and a camera above the track see it squarely.
        { id: 'team-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.099, 0.408, 0.107, 0.355], rotate: 'auto', text: '{team}', color: 'indigo', weight: 900, tracking: 0.14 },

        // A secondary sponsor on the rear quarter, over the arch.
        { id: 'sponsor-b-left', mirror: true, treatment: 'text', panel: 'left_rear', at: [0.525, 0.463, 0.08, 0.217], rotate: 'auto', text: 'HALCYON', color: 'indigo', weight: 800 },

        // The primary sponsor on the bonnet, white in the spine, across the
        // car so it reads from in front of it.
        { id: 'sponsor-bonnet', treatment: 'text', panel: 'centre_front', at: [0.39, 0.67, 0.22, 0.13], rotate: 0, text: 'ORBIT FUELS', color: 'white', weight: 900, tracking: 0.08 },

        // The sweep round the tail, under the same pinstripe, and the team in
        // white on it, for the car you are following.
        { id: 'tail-sweep', treatment: 'fill', panel: 'centre_tail', at: [0, 0.52, 1, 0.48], color: 'indigo', safe: false },
        { id: 'tail-pin', treatment: 'stripe', panel: 'centre_tail', at: [0, 0.47, 1, 0.05], color: 'vermilion', safe: false },
        { id: 'team-tail', treatment: 'text', panel: 'centre_tail', at: [0.404, 0.53, 0.192, 0.21], text: '{team}', color: 'white', weight: 900, tracking: 0.14, rotate: 'auto' },

        // The number again on the boot lid, for the cameras above the track:
        // the car has no roof to carry it.
        { id: 'roundel-boot', treatment: 'ring', panel: 'centre_tail_lower', at: [0.375, 0.235, 0.25, 0.53], radius: 0.25, width: 0.5, color: 'white' },
        { id: 'roundel-boot-edge', treatment: 'ring', panel: 'centre_tail_lower', at: [0.375, 0.235, 0.25, 0.53], radius: 0.47, width: 0.05, color: 'indigo' },
        { id: 'number-boot', treatment: 'text', panel: 'centre_tail_lower', at: [0.405, 0.3, 0.19, 0.4], rotate: 'auto', text: '{number}', color: 'indigo', scale: 0.767, weight: 900 },
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
