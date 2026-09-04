// ---------------------------------------------------------------------------
// Turning a kn5 model into geometry the renderers can draw: the whole car,
// grouped by which texture paints each part.
//
// Lives in engine/ rather than ui/ because both the fitting editor (which
// draws it in WebGL) and the CLI build (which rasterises it in Node, for a
// preview.jpg and for `render_car`/`render_view`) need the same grouping —
// and the CLI has no business importing an HTTP server to get it.
// ---------------------------------------------------------------------------

import { meshesUsingTexture, vertex, triangles, blends, additive, trustworthyDiffuse, detailLayer, isGlass, damageOnly, motionBlurOnly } from './kn5.mjs';
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
  // Tangents travel for the same reason normals did: without one there is no
  // frame to interpret a normal map in, and a normal map is what carries the
  // grain of a material — the nap of alcantara, the weave of carbon. They were
  // already in the kn5, sitting behind the UVs, being skipped.
  const tangents = [];
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
        tangents.push(v.tx, v.ty, v.tz);
        for (const [k, n] of [[0, v.x], [1, v.y], [2, v.z]]) {
          if (n < lo[k]) lo[k] = n;
          if (n > hi[k]) hi[k] = n;
        }
      }
      for (const [a, b, c] of triangles(model, mesh)) indices.push(base + a, base + b, base + c);
    }
    if (indices.length > start) {
      // The material's OWN lighting constants, carried so the viewer can stop
      // lighting a seat like a wing.
      //
      // Taken from whichever material contributes the most triangles here. A
      // group is one texture and usually one material, but "usually" is not
      // "always", and averaging constants across materials would invent a
      // surface that none of them describe.
      const weight = new Map();
      for (const m of meshes) {
        weight.set(m.materialId, (weight.get(m.materialId) ?? 0) + (m.indexCount ?? 0));
      }
      let dominant = null;
      let most = -1;
      for (const [id, n] of weight) if (n > most) { most = n; dominant = id; }
      const props = model.materials?.[dominant]?.props ?? {};
      const num = (v) => (Number.isFinite(v) ? v : null);

      // Whether this group composites, taken from the MATERIAL rather than from
      // the texture. A group is one draw call and one texture, and in practice
      // one shader — but `some` rather than `every`, because a blended mesh
      // drawn in the opaque pass is a black slab and an opaque one drawn in the
      // blended pass merely sorts oddly. Wrong in the cheaper direction.
      const blend = meshes.some((m) => blends(model.materials?.[m.materialId]?.shader));
      groups.push({
        ...group, start, count: indices.length - start, blend,
        // `null` for anything the material does not state, so the viewer keeps
        // its own default rather than lighting the part as pure black.
        light: {
          ambient: num(props.ksAmbient),
          diffuse: num(props.ksDiffuse),
          specular: num(props.ksSpecular),
          exponent: num(props.ksSpecularEXP),
        },
        add: blend && additive(group.file),
        // A narrower question than `blend`: a number plate composites too but
        // is not glass, and should not go mirror-bright at a grazing angle.
        glass: blend && meshes.some((m) => isGlass(model.materials?.[m.materialId]?.shader)),
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
  // Which sheets are shading rather than artwork, as the PROFILE records it.
  // See profilegen for how the fact is arrived at and why it is a recorded
  // choice. The viewer used to decide this from the filename at draw time,
  // which worked on this car and would have failed quietly on the next one.
  const bakes = new Set();
  for (const t of Object.values(profile.textures ?? {})) {
    if (t?.bake && typeof t.file === 'string') bakes.add(t.file.toLowerCase());
  }

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
  // Damage-only overlays (DAMAGE_GLASS_*, shader ksBrokenGlass): excluded here
  // rather than left for isGlass to shade, because at zero damage — the only
  // state this project can render — the correct picture has no crack mesh in
  // it at all, textured or bare. See damageOnly's own comment.
  // Motion-blur rims (EXT_RIM_BLUR_*): excluded for the same reason and on the
  // same terms as the damage glass above — the game swaps them in by wheel
  // speed, a livery preview is a car at rest, and drawing them anyway puts a
  // streak disc over the wheel and z-fights the design's rim paint. See
  // motionBlurOnly's own comment.
  //
  // And the SECOND COCKPIT, which is not a mesh to drop but a choice to carry.
  //
  // A car of this kind ships its interior twice: COCKPIT_HR for the driver's
  // camera and COCKPIT_LR for every external one, occupying the same space and
  // swapped by whichever camera is live. Drawing both puts every interior
  // surface a fraction of a millimetre from its own duplicate, which the depth
  // buffer cannot separate — the dashboard and the tub come out as a hard-edged
  // checkerboard that reads as a broken material rather than as z-fighting.
  //
  // Both are kept and TAGGED, and each renderer picks by camera, because the
  // game's answer depends on the camera too. Dropping LR outright — which this
  // did first — fixes the cockpit and quietly breaks the view through the
  // windows: outside the car the game shows LR, and LR is where this car's
  // `interior` role lives. `Cockpit_LR_Colour.dds` is on no other mesh, so a
  // design painting the interior was left with nothing to paint it on.
  //
  // `null` for every mesh on a car that ships one cockpit or none, which the
  // renderers read as "draw this whatever the camera".
  const cockpitLod = (m) => {
    const path = m.path ?? '';
    if (/(^|\/)COCKPIT_HR(\/|$)/i.test(path)) return 'HR';
    if (/(^|\/)COCKPIT_LR(\/|$)/i.test(path)) return 'LR';
    return null;
  };

  const drawn = (m) => !claimed.has(m) && !carHides.has(m.name)
    && !damageOnly(model.materials?.[m.materialId]?.shader)
    && !motionBlurOnly(m.name);

  for (const { role, file } of files) {
    const meshes = meshesUsingTexture(model, file).filter(drawn);
    for (const m of meshes) claimed.add(m);
    // Split by cockpit, because a group is one draw call and a renderer has to
    // be able to leave one of the two out. A painted role spanning both — this
    // car's steering wheel does — becomes two groups wearing the same texture,
    // which costs a draw call and keeps the choice available.
    const byLod = new Map();
    for (const m of meshes) {
      const lod = cockpitLod(m);
      if (!byLod.has(lod)) byLod.set(lod, []);
      byLod.get(lod).push(m);
    }
    for (const lod of [...byLod.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
      emit(byLod.get(lod), { role, file, lod });
    }
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
    const mat = model.materials?.[m.materialId];
    // `null` when the shader's diffuse is not a plausible standalone image —
    // see trustworthyDiffuse. The mesh still gets a group and still gets
    // drawn, just without a texture to claim for it, same as any other part
    // this project cannot supply artwork for.
    const file = trustworthyDiffuse(mat?.shader) ? (mat?.slots?.txDiffuse ?? null) : null;

    // But "the diffuse is not the surface" and "the surface is unknowable" are
    // different claims, and the second one cost this car its whole cockpit:
    // door cards, instrument surround and rollcage trim are MultiMap parts, so
    // every one of them fell in here as flat grey next to a painted interior,
    // which reads as a checkerboard and was reported as exactly that. Their
    // material knows better — see `detailLayer` — and says the part is a bake
    // times a tiling material.
    //
    // Deliberately NOT folded into `file`. Both renderers read `file` as "this
    // one sheet IS the surface", so putting an occlusion bake there would have
    // the software rasteriser draw a door card as a greyscale photograph of
    // its own shadows. A renderer that cannot composite two layers should get
    // the grey, and does.
    const detail = file === null ? detailLayer(mat) : null;
    if (detail) detail.bake = bakes.has(detail.diffuse.toLowerCase());

    // Keyed by what gets DRAWN rather than by the diffuse alone: two materials
    // tiling different details over the same bake — this car's carbon door
    // cards and its brushed-metal instrument surround do exactly that — are
    // two surfaces and cannot share one draw call.
    const lod = cockpitLod(m);
    const key = detail
      ? ['detail', detail.diffuse, detail.detail, detail.mult,
        detail.normal ?? '', detail.normalBlend, lod ?? ''].join('\u0000')
      : ['file', file ?? '', lod ?? ''].join('\u0000');
    if (!leftover.has(key)) {
      leftover.set(key, {
        meshes: [],
        group: detail ? { role: null, file, detail, lod } : { role: null, file, lod },
      });
    }
    leftover.get(key).meshes.push(m);
  }
  // Sorted by that key, for the reason the file sort had before it: group order
  // should not depend on mesh order in the archive, so a test can say what it
  // expects.
  for (const key of [...leftover.keys()].sort()) {
    const { meshes, group } = leftover.get(key);
    // Named on the `hide` list: not emitted at all, so it is not drawn, not
    // fetched, and not counted as unpainted geometry. Checked against the
    // detail pair's own diffuse as well, now that a group can wear a sheet its
    // `file` does not name — hiding a texture and then finding a part still
    // wearing it is precisely the bug this list exists to prevent.
    const wears = group.file ?? group.detail?.diffuse ?? null;
    if (wears && hidden.has(String(wears).toLowerCase())) continue;
    // `role: null` still means "the design does not paint this", which is what
    // the viewer keys its grey off. `file` is new, and says what to draw instead
    // when the car itself can supply it.
    emit(meshes, group);
  }

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    normals: Float32Array.from(normals),
    tangents: Float32Array.from(tangents),
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
