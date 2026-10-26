// ---------------------------------------------------------------------------
// Measuring a model's panels, for whichever generator is building a profile.
// ---------------------------------------------------------------------------

import { meshesWearing, meshTraits, SHEET_SPAN } from '../model.mjs';
import { findIslands, nameIslands, findMirrorPairs, findAdjacency, findSeams, islandOutline, carBounds } from './islands.mjs';
import { uvLayout } from './uvlayout.mjs';
import { computeSafeAreas, computeCockpitVisibility, carOccluders, tracksideOccluders, occupancyFor, occupancyGrid, nearIndex, blurTwins } from './visibility.mjs';
import { measureWheels } from './wheels.mjs';

/**
 * The panels of a model's paintable textures, measured: UV islands named by
 * where they sit on the object, their mirrors, neighbors and seams, tire
 * layouts, and — with `visibility` — how much of each is seen from outside
 * and from the driver's seat.
 *
 * Shared by every way a profile is generated, so a model measures the same
 * whichever generator asked. What the model's surroundings say — which way it
 * faces, where an eye sits, which meshes its game hides — is handed in, since
 * only the generator that knows the game can read it.
 *
 * `roleOf` maps each texture file to the role it is filed under, in the order
 * they are measured, and `textures` is the profile's own table, which gains
 * each measured texture's UV layout. `hidden` is a Map from the name of each
 * mesh the game hides to why. Returns the panels by role, and how many islands
 * straddle a sheet's edge, by texture.
 */
export function measurePanels(model, roleOf, textures, {
  axes, kind = 'car', eye = null, hidden = null, visibility = true,
  minPanelArea = 0.0015, minVertices = 40, minCoverage = 0.008, log = () => {},
} = {}) {
  // What can stand in front of paint: the same meshes `fitment` casts against,
  // so a panel's `visible` and the check that reads it agree. Every mesh used
  // to count here, and once the visibility cast learned to find a fitting
  // standing flush on the paint, the NSX's sixteen door plates — hidden by
  // its config, drawn by nothing — took its doors from 88% visible to 56%.
  const carHides = { hiddenByCar: { meshes: Object.fromEntries(hidden ?? []) } };
  const occluders = carOccluders(model, carHides);
  // Built once for the car, not once per texture: the grid and the index of
  // triangles depend on the car alone. From trackside, as the fitment check
  // casts, without the cockpit the game does not draw there or the glass it
  // sees through; the driver's-seat measurement below keeps every mesh.
  const prepared = visibility ? occupancyFor(model, { occluders: tracksideOccluders(model, carHides) }) : null;
  // The cockpit's too, at its own finer cells. Only the triangle index was
  // shared with it, and its grid was still rebuilt for every texture.
  const cockpitGrid = visibility && eye ? occupancyGrid(model, occluders, 0.02) : null;
  const cockpitNear = visibility && eye ? nearIndex(model, occluders) : null;
  // A motion-blur mesh is measured as the drawn one it is swapped with, found
  // by the node above it (see `blurTwins`). One whose twin could not be found
  // is measured against whatever is drawn in its place, and reads low for it,
  // so that is said wherever such a mesh carries a panel.
  const twinned = visibility ? blurTwins(model) : new Map();
  const unpaired = new Set(model.meshes
    .filter((m, i) => meshTraits(model, m).blur && !twinned.has(i)).map((m) => m.name));
  const coverage = coverageOf(model);

  // --- panels, per paintable texture ---
  // Decomposing every texture produces hundreds of panels for springs, bolts
  // and cable trim — all real, none paintable in any meaningful sense, and
  // collectively they bury the panels somebody actually wants. Only textures
  // carrying a real share of the car's geometry get decomposed.
  const totalCoverage = [...roleOf.keys()].reduce((s, t) => s + (coverage.get(t.toLowerCase()) ?? 0), 0) || 1;

  const panels = {};
  const straddling = new Map();
  // Measured once, from the whole car, and handed to every role. Naming is a
  // claim about where something sits on the CAR; deriving the extent per texture
  // makes it a claim about where it sits on that sheet, which is very nearly
  // no claim at all. See nameIslands.
  const bounds = carBounds(model);
  for (const [texName, role] of roleOf) {
    const share = (coverage.get(texName.toLowerCase()) ?? 0) / totalCoverage;
    if (share < minCoverage) { panels[role] = {}; continue; }

    const meshes = meshesWearing(model, texName);
    if (!meshes.length) { panels[role] = {}; continue; }

    // Before the islands, because on a tiled material they mostly do not
    // survive the filter below, and a sheet with no panels says nothing about
    // why it has none. See uvlayout.mjs. Textures under minCoverage never get
    // here, so for them the field is absent: not measured, not "unwrapped".
    const layout = uvLayout(model, meshes);
    if (layout && textures[role]) {
      textures[role].uvLayout = layout.layout;
      textures[role].uvInside = layout.inside;
      // Only when it is not where it belongs, so its presence is the finding.
      if (layout.tile[0] || layout.tile[1]) textures[role].uvTile = layout.tile;
    }

    const islands = findIslands(model, meshes, { minVertices });
    // `minPanelArea` is a share of the sheet's island area, and an island that
    // spans more than one sheet is not sheet: it repeats the image, and its UV
    // area counts every repeat. One 111-vertex strip on the mp412c's chassis
    // runs 1,222 sheets wide, carries 11,123 of the texture's 11,124 units of
    // UV area, and left the car's paint with one panel of 102 — measured 14%
    // visible on that one, so the classifier passed the paint over. Such
    // islands stay out of the total. A texture made of nothing else keeps the
    // old total, so a pure tiling material reads as it always did.
    const repeats = (i) => i.uv.u1 - i.uv.u0 > SHEET_SPAN || i.uv.v1 - i.uv.v0 > SHEET_SPAN;
    const onSheet = islands.filter((i) => !repeats(i)).reduce((s, i) => s + i.uvArea, 0);
    const total = onSheet || islands.reduce((s, i) => s + i.uvArea, 0) || 1;
    const keep = islands.filter((i) => i.uvArea / total >= minPanelArea);
    // An island that straddles a sheet boundary is drawn by the game wrapped
    // across the image's edge, and it is the one kind placeOnSheet cannot bring
    // back whole: its rect here stops at the edge, and one on another copy of
    // the sheet has none. placeOnSheet lists them over every island, and those
    // big enough for findIslands to measure are counted, to be said below.
    // Counted over `keep`, the ones with no panel went unsaid; counted at any
    // size, one brushed-metal sheet on the S14 Zenki buried them under 1,728.
    const across = meshes.flatMap((m) => m.straddlers ?? []).filter((n) => n >= minVertices).length;
    if (across) straddling.set(texName, across);
    nameIslands(keep, axes, bounds, kind);
    findMirrorPairs(keep, axes);
    const adj = findAdjacency(model, keep);
    // And HOW they touch: the map from each island's sheet to its neighbor's,
    // so artwork can be continued across the seam. See findSeams.
    const seams = findSeams(model, keep, adj);
    // Which islands are tire parts, and how each was unwrapped. A sidewall
    // rolled out as a strip and one laid out as a disc want different
    // artwork, and the texture cannot say which it is. See wheels.mjs.
    const wheels = measureWheels(model, keep);
    // Every drawn mesh occludes, not just the painted ones — a wheel hides
    // bodywork as effectively as bodywork does.
    if (visibility) {
      computeSafeAreas(model, keep, { prepared, log });
      // Visibility isn't a property of a surface, it's a property of a surface
      // and a place to stand. A cockpit-view driver stares at the tub and the
      // steering wheel all race — surfaces the trackside pass scores near zero.
      if (eye) computeCockpitVisibility(model, keep, { eye, occluders, near: cockpitNear, grid: cockpitGrid, log });
      const alone = [...new Set(keep.filter((i) => unpaired.has(i.mesh)).map((i) => i.mesh))];
      if (alone.length) {
        log(`  ! ${alone.join(', ')}: motion-blur mesh(es) with no drawn twin under a sibling node, ` +
            'so their panels are measured behind whatever is drawn in their place and may read low');
      }
      // An island on a mesh the car's own config hides is on nothing anybody
      // sees, whatever its rays say: the mesh is not drawn, and taken out of
      // the occluders, it measured clear, a place to paint the game never shows.
      for (const i of keep) {
        if (!hidden?.has(i.mesh)) continue;
        i.visibleFraction = 0;
        i.hidden = true;
        delete i.safe;
        if (i.cockpitFraction !== undefined) i.cockpitFraction = 0;
      }
      // Nor, from trackside, is an island in the cockpit the game draws only
      // from the driver's seat: outside, the other one is drawn instead. It
      // keeps what the seat sees of it, which is the whole of its audience.
      if (model.meshes.some((m) => meshTraits(model, m).lod === 'LR')) {
        for (const i of keep) {
          if (meshTraits(model, i.meshRef).lod !== 'HR') continue;
          i.visibleFraction = 0;
          delete i.safe;
        }
      }
    }

    log(`  ${role.padEnd(8)} ${texName.padEnd(26)} ${islands.length} islands, ${keep.length} above threshold`);

    panels[role] = {};
    for (const i of keep) {
      const p = {
        rect: i.rect,
        anisotropy: Math.round(i.anisotropy * 100) / 100,
        // How big one UV unit is on the car, in meters, along each axis. The
        // ratio above un-stretches a glyph; this says whether the glyph lands
        // 40 mm tall or 400, which is the question somebody placing artwork is
        // actually asking and the one thing a flat sheet can never answer.
        //
        // Meters, to three decimals — so millimeter precision, not millimeters.
        // A profile is read by people, and the sixth decimal of a figure
        // measured off a game model would be pretending.
        metresPerUv: i.metresPerUv ? i.metresPerUv.map(r3) : undefined,
        confidence: 'measured',
        source: { mesh: i.mesh, vertices: i.vertexCount },
        centroid3d: [r3(i.centroid.x), r3(i.centroid.y), r3(i.centroid.z)],
        // Where the island reaches on the car, as its box's min and max
        // corners. The centroid says where its vertices are densest, which is
        // the unwrapper's business; this says how far it runs, which is what
        // decides whether a flank is in the middle of the car. See tags.mjs.
        extent3d: [
          [r3(i.box3d.x0), r3(i.box3d.y0), r3(i.box3d.z0)],
          [r3(i.box3d.x1), r3(i.box3d.y1), r3(i.box3d.z1)],
        ],
        // Which way +u and +v travel across the car. Needed to mirror a
        // placement onto the opposite flank: `mirrorOf` is measured from
        // geometry and says nothing about how each island was laid out, and
        // two panels that are mirror images in 3D are very often unwrapped the
        // same way round in UV — or very often not.
        uAxis: i.uAxis ?? undefined,
        vAxis: i.vAxis ?? undefined,
      };
      // How far this island is rotated from upright, so artwork can read level
      // on a panel the unwrapper laid sideways. Omitted for near-horizontal
      // panels, where "up" has no meaning on the surface and any answer would be
      // rounding error.
      if (i.textRotation !== null && i.textRotation !== undefined) p.textRotation = i.textRotation;
      if (i.handed === 1 && i.uAxis && i.vAxis) p.reflected = true;
      if (i.safe) p.safe = i.safe;
      if (i.visibleFraction !== undefined) p.visible = i.visibleFraction;
      if (typeof i.bend === 'number') p.bend = i.bend;
      if (i.cockpitFraction !== undefined) p.visibleFromCockpit = i.cockpitFraction;
      if (i.hidden) p.hidden = true;
      if (i.tiled) { p.tiled = true; p.uvBounds = i.uvBounds; }
      if (i.mirrorOf) p.mirrorOf = i.mirrorOf;
      const touching = [...(adj.get(i.name) ?? [])].sort();
      if (touching.length) p.adjacent = touching;
      const wheel = wheels.get(i);
      if (wheel) p.wheel = wheel;
      const across = seams.get(i.name);
      if (across?.size) {
        p.seams = Object.fromEntries([...across].sort(([a], [b]) => a.localeCompare(b)));
      }
      // The island's actual shape, for clipping artwork that spans onto it.
      // Only where it has seams: an island nothing continues onto has no
      // use for it, and a profile is long enough.
      if (across?.size) {
        const outline = islandOutline(model, i);
        if (outline) p.outline = outline;
      }
      panels[role][i.name] = p;
    }
  }
  return { panels, straddling };
}

/**
 * How many vertices wear each texture as their paint, by lowercased name. Two
 * textures can both look like bodywork by name, and the one carrying it
 * should be measured first and get the plain role name.
 */
export function coverageOf(model) {
  const coverage = new Map();
  for (const mesh of model.meshes) {
    const t = meshTraits(model, mesh).diffuse?.toLowerCase();
    if (t) coverage.set(t, (coverage.get(t) ?? 0) + mesh.vertexCount);
  }
  return coverage;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
