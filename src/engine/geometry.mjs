// ---------------------------------------------------------------------------
// Turning a kn5 model into geometry the renderers can draw: the whole car,
// grouped by which texture paints each part.
//
// Lives in engine/ rather than ui/ because both the fitting editor (which
// draws it in WebGL) and the CLI build (which rasterises it in Node, for a
// preview.jpg and for `render_car`/`render_view`) need the same grouping —
// and the CLI has no business importing an HTTP server to get it.
// ---------------------------------------------------------------------------

import { meshesUsingTexture, vertex, triangles, blends, additive } from './kn5.mjs';
import { cockpitEye } from './visibility.mjs';

/**
 * The WHOLE car, grouped by which texture paints each part.
 *
 * The per-role view is the right one while you are editing a surface — you are
 * looking at what you are painting. It is the wrong one for judging a design,
 * because a livery is not a texture, it is every texture at once, and a stripe
 * that meets the bodywork perfectly can still miss the sidepod beside it.
 *
 * Every mesh appears exactly once. A mesh whose texture the livery does not
 * paint goes into a group with no ROLE but with its FILE, one group per texture
 * — which is what lets the viewer draw the car's own artwork there, out of the
 * kn5, and fall back to flat grey only when it cannot. Leaving those meshes out
 * entirely would be worse than either: a car with holes in it reads as a broken
 * export rather than as an unpainted panel.
 *
 * They used to be ONE group and always grey. That is honest and it reads as a
 * bug: a grey rectangle across a door panel looks like a sticker somebody left
 * on, and it was reported as a fault twice.
 */
export function wholeModelGeometry(model, files, { livery = {}, profile = {} } = {}) {
  const positions = [];
  const uvs = [];
  // The surface normals were always in the kn5 and were always thrown away
  // here, so the viewer had nothing to light with and drew the raw texture. A
  // livery on an unlit slab does not look like a livery on a car, and you
  // cannot judge how artwork sits over a curve you cannot see.
  const normals = [];
  const indices = [];
  const groups = [];
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];

  const claimed = new Set();
  const emit = (meshes, group) => {
    const start = indices.length;
    for (const mesh of meshes) {
      const base = positions.length / 3;
      for (let i = 0; i < mesh.vertexCount; i++) {
        const v = vertex(model, mesh, i);
        positions.push(v.x, v.y, v.z);
        uvs.push(v.u, v.v);
        normals.push(v.nx, v.ny, v.nz);
        for (const [k, n] of [[0, v.x], [1, v.y], [2, v.z]]) {
          if (n < lo[k]) lo[k] = n;
          if (n > hi[k]) hi[k] = n;
        }
      }
      for (const [a, b, c] of triangles(model, mesh)) indices.push(base + a, base + b, base + c);
    }
    if (indices.length > start) {
      // Whether this group composites, taken from the MATERIAL rather than from
      // the texture. A group is one draw call and one texture, and in practice
      // one shader — but `some` rather than `every`, because a blended mesh
      // drawn in the opaque pass is a black slab and an opaque one drawn in the
      // blended pass merely sorts oddly. Wrong in the cheaper direction.
      const blend = meshes.some((m) => blends(model.materials?.[m.materialId]?.shader));
      groups.push({
        ...group, start, count: indices.length - start, blend,
        add: blend && additive(group.file),
      });
    }
  };

  // Surfaces the design explicitly does not want drawn.
  //
  // A GT3 car ships one set of number plate meshes per racing series and
  // renders them ALL — this Honda has eight on the left flank: IGT, IMSA and
  // two Blancpain variants, each with an emissive twin, stacked in one patch of
  // door. In the game a skin makes the unused ones transparent. Here they wore
  // their stock 32x32 black textures and were drawn over the plate the design
  // had just painted.
  //
  // This is a CHOICE, not something to infer. I tried inferring it from
  // geometry twice — first "unpainted things inside painted things", which hid
  // half the car because a group is a whole texture and the body's box encloses
  // the mirrors; then with a size-similarity test, which hid the hood lining
  // and the radiator. Bounding boxes cannot tell an alternate from a part, and
  // I had already written that conclusion down once while building the fitment
  // checker and then ignored it.
  //
  // So the design says which ones. `hide` is a list of texture roles, matched
  // by their file, and it means exactly what it says.
  //
  // Guarded, because a design is a file somebody edits by hand. `hide: 'imsa'`
  // is a string, and iterating a string yields characters — five roles named
  // i, m, s, a — while a profile entry whose `file` is not a string would throw
  // inside toLowerCase. Neither is worth a stack trace or a wrong car.
  const hidden = new Set();
  for (const role of Array.isArray(livery.hide) ? livery.hide : []) {
    const f = profile.textures?.[role]?.file;
    if (typeof f === 'string' && f) hidden.add(f.toLowerCase());
  }

  // And the meshes the CAR hides, by its own CSP config, as the profile
  // recorded them. These are skipped for painted surfaces too: a design that
  // paints a plate the game never draws is painting nothing, and the picture
  // should say so rather than show artwork on a part that does not exist in
  // the game. The build's report names the contradiction in words.
  const carHides = new Set(Object.keys(profile.hiddenByCar?.meshes ?? {}));
  const drawn = (m) => !claimed.has(m) && !carHides.has(m.name);

  for (const { role, file } of files) {
    const meshes = meshesUsingTexture(model, file).filter(drawn);
    for (const m of meshes) claimed.add(m);
    emit(meshes, { role, file });
  }
  // Whatever is left: glass, the number plates, the Lumirank panel, the mirrors.
  //
  // ONE GROUP PER TEXTURE, not one group for all of them. They used to be lumped
  // together and drawn flat grey, which is honest but reads as a bug — a grey
  // rectangle across a door panel looks like a sticker, not like "this part is
  // unpainted", and it was reported as a fault twice. Split by texture, each can
  // wear the car's OWN artwork, so the whole-car view shows the real car with
  // your livery on the parts your livery paints.
  //
  // Sorted, so the group order does not depend on mesh order in the file and a
  // test can say what it expects.
  const leftover = new Map();
  for (const m of (model.meshes ?? []).filter(drawn)) {
    const file = model.materials?.[m.materialId]?.slots?.txDiffuse ?? null;
    if (!leftover.has(file)) leftover.set(file, []);
    leftover.get(file).push(m);
  }
  for (const file of [...leftover.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
    // Named on the `hide` list: not emitted at all, so it is not drawn, not
    // fetched, and not counted as unpainted geometry.
    if (file && hidden.has(String(file).toLowerCase())) continue;
    // `role: null` still means "the design does not paint this", which is what
    // the viewer keys its grey off. `file` is new, and says what to draw instead
    // when the car itself can supply it.
    emit(leftover.get(file), { role: null, file });
  }

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    groups,
    bounds: { lo, hi },
    // Where a driver's eyes sit, for the cockpit view. Computed here rather
    // than left to the caller: it needs the raw kn5 meshes, which this is
    // already holding, and every caller of this function wants a camera
    // eventually. `null` when the model has nothing that looks like a
    // steering wheel — an open passenger view, or a car this project has
    // not seen before.
    cockpit: cockpitEye(model),
  };
}
