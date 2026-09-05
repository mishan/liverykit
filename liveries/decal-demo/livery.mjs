// A livery FOLDER: the design here, its images in decals/ beside it.
//
// It does nothing but place them, so the decal path can be looked at without a
// design's own artwork in the way.
//
// `sponsor.png` is a drawn placeholder. `flag.svg` is the flag of the United
// Nations, taken unmodified from the `flag-icons` package (MIT, and the flag
// artwork itself is public domain) — a real flag rather than an invented one,
// since a flag is the thing people actually reach for a decal to put on a car.
//
//   node bin/liverykit.mjs decal-demo --profile cars/rss_formula_rss_4.json
export default {
  name: 'Decal demo',
  folder: 'decal_demo',
  packs: ['core'],
  identity: { team: 'Decal Demo', driver: 'A. Driver', number: '85' },
  palette: { ink: '#0b0d12' },
  surfaces: {
    body: {
      background: 'ink',
      regions: [
        { id: 'sponsor-left', treatment: 'decal', image: 'sponsor', panel: 'flankLeft', once: true, at: [0.1, 0.4, 0.6, 0.2] },
        { id: 'sponsor-right', treatment: 'decal', image: 'sponsor', panel: 'flankRight', once: true, at: [0.1, 0.4, 0.6, 0.2] },
        { id: 'flag-nose', treatment: 'decal', image: 'flag', panel: 'nose', once: true, at: [0.3, 0.3, 0.4, 0.4] },
      ],
    },
  },
};
