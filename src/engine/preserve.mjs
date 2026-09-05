// ---------------------------------------------------------------------------
// Carrying hand-work across a regeneration.
//
// A car profile is mostly measurement, and measuring again is exactly what you
// want when a model is updated or the generator improves. But a profile is not
// ONLY measurement. Layered on top of it are decisions a model cannot express:
// a role renamed from `csw_png_png` to `rimFace`, an alias so a livery can say
// `flankLeft`, a texture deliberately painted at 256x256 when the model ships a
// 28x28 placeholder, a note explaining why something is left stock.
//
// Regeneration destroyed every one of those. It preserved `bind` and nothing
// else, which meant rebuilding a profile silently deleted 31 aliases, 4 role
// names, a size override, a leaveStock block and a page of notes — and the
// liveries that addressed them stopped resolving. Nobody noticed for a long
// time, because nobody regenerated a profile they had already tuned.
//
// The rule throughout: measurement wins where measurement has something to say,
// hand-work wins where it does not, and anything that cannot be carried across
// is reported by name rather than dropped quietly.
//
// THE SUBTLE ONE. Generated names get REUSED. Correcting the panel naming turned
// this car's `bodyRear.centre_mid` into `centre_rear` and handed the name
// `centre_mid` to a different island. An alias kept because its target name
// still existed then pointed at the wrong texels, resolved fine, built fine, and
// painted 43% of the rear bodywork in the wrong place with no error anywhere. So
// an alias is followed by RECTANGLE first and by name only as a fallback: an
// alias names texels, not a generated string.
// ---------------------------------------------------------------------------

/** Blocks that are pure human judgement, with nothing for a model to say. */
const HANDWRITTEN_BLOCKS = ['leaveStock', 'notes'];

const rectKey = (p) => (Array.isArray(p?.rect) ? p.rect.join(',') : null);

const dist = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  : 0);

/**
 * Carry a prior profile's hand-work onto a freshly generated one, in place.
 *
 * `bind` is deliberately NOT handled here — it has its own merge with its own
 * rule about human versus automatic sources, and folding it in would hide that
 * distinction behind a generic name.
 *
 * Returns a report of everything kept, moved or lost, so a caller can print it.
 * Nothing is logged from in here: a function that both decides and narrates is
 * two functions, and only one of them is testable.
 */
export function preserveHandwork(profile, prior, { skinsGiven = false } = {}) {
  const report = {
    roles: [], blocks: [], sizes: [], panels: [], aliases: 0, moved: [], gone: [],
    name: null, skinOnly: [], dangling: [],
  };
  if (!prior) return report;

  preserveDisplayName(profile, prior, report);
  preserveRoleNames(profile, prior, report);
  // BEFORE the panels and the aliases, both of which skip a role the profile
  // does not define — a role restored after them would come back bare.
  preserveSkinOnlyRoles(profile, prior, report, skinsGiven);
  preserveBlocks(profile, prior, report);
  preserveTextureSizes(profile, prior, report);
  preserveUnmeasuredPanels(profile, prior, report);
  preserveAliases(profile, prior, report);
  dropDanglingBindings(profile, report);
  return report;
}

/**
 * Roles only a skins folder knows about, when this run had no skins folder.
 *
 * A car's skins legitimately contain textures the model has never heard of: the
 * driver's helmet, suit and gloves are a separate kn5 under content/driver/ and
 * the pit crew is another again, and a car skin overrides all of them. The
 * generator files those as `sizeFrom: "skin"`, and its own comment says why —
 * dropping them silently stops painting the driver.
 *
 * Regenerating without `--skins` dropped them anyway, because there was nowhere
 * to see them from. That is not a measurement saying the role is gone; it is a
 * flag that was not passed, and the difference matters: the roles vanished, the
 * human-confirmed `bind` entries that named them were kept by the merge beside
 * this, and the profile that came out could not be LOADED at all —
 * `bind."crew" points at texture role "crew", which this profile does not
 * define`. A regeneration that writes a file nothing can open is the worst
 * shape this whole module exists to prevent.
 *
 * So when the run had no skins to look at, what the prior knew about them
 * stands. When it did have them and a role is gone, the skins no longer carry
 * that file and measurement wins, as everywhere else here.
 */
function preserveSkinOnlyRoles(profile, prior, report, skinsGiven) {
  if (skinsGiven) return;
  for (const [role, was] of Object.entries(prior.textures ?? {})) {
    if (was?.sizeFrom !== 'skin' || profile.textures?.[role]) continue;
    (profile.textures ??= {})[role] = structuredClone(was);
    const panels = prior.panels?.[role];
    if (panels && Object.keys(panels).length) (profile.panels ??= {})[role] = structuredClone(panels);
    else (profile.panels ??= {})[role] ??= {};
    report.skinOnly.push({ role, file: was.file });
  }
}

/**
 * A binding that survived everything above and still names nothing.
 *
 * `mergeBindings` keeps what a human confirmed, which is right, and it cannot
 * know whether the role that binding named is still here. Left in, the profile
 * does not load — so the binding goes, LOUDLY, rather than the file being
 * unopenable. Only ever reached when the role is genuinely gone: a role missing
 * because nobody passed `--skins` was put back a few lines up.
 */
function dropDanglingBindings(profile, report) {
  for (const [term, entry] of Object.entries(profile.bind ?? {})) {
    const roles = Array.isArray(entry?.roles) ? entry.roles : [];
    const kept = roles.filter((r) => profile.textures?.[r]);
    if (kept.length === roles.length) continue;
    const lost = roles.filter((r) => !profile.textures?.[r]);
    if (!kept.length) delete profile.bind[term];
    else profile.bind[term] = { ...entry, roles: kept };
    report.dangling.push({ term, roles: lost, source: entry?.source ?? 'auto' });
  }
}

/**
 * The car's display name.
 *
 * Nothing in a kn5 says "Abarth 500" — the name came from `--car-name` and
 * defaulted to the empty string, so regenerating without the flag replaced a
 * perfectly good name with nothing, and every profile that had been rebuilt
 * shipped with `"name": ""`. That is not an error anywhere: the CLI and the
 * editor both fall back to the id, so the car is quietly called
 * `rss_formula_rss_4` from then on.
 *
 * The generator now reads `ui/ui_car.json` beside the model, so a fresh run
 * usually arrives with a name of its own. This still matters for the cases it
 * cannot cover — a car unpacked without its `ui` folder, a screenshot-calibrated
 * profile, or a name a person preferred to the author's — and the order is the
 * same either way: an explicit `--car-name`, then the car's own name, then
 * whatever the prior profile said.
 */
function preserveDisplayName(profile, prior, report) {
  if (profile.name || !prior.name) return;
  profile.name = prior.name;
  report.name = prior.name;
}

/**
 * Role names are hand-chosen and liveries address them directly — `paint.body`,
 * `surfaces.rimFace` — so a fresh guess renames the very thing a design points
 * at. `guessRole` works from a filename and can only do so much with one called
 * `CSW.png.png`; a person renamed that role `rimFace` and rebuilding turned it
 * back into `csw_png_png`.
 *
 * Matched on the texture FILE, the one identifier the model actually fixes. A
 * prior name is reused only if nothing in the new profile has claimed it, so
 * this can rename but never collide.
 *
 * Everything that REFERS to a role has to move with it, and `bind` is the one
 * that is easy to forget because it is merged elsewhere. By the time this runs,
 * the merged table holds automatic entries naming the fresh role and human ones
 * naming the prior role — so rewriting `from` to `to` lands both on the same
 * name. Skip it and a renamed role leaves bindings pointing at a role that no
 * longer exists, which is not an error anywhere: `resolveTargets` reports the
 * surface as unbound and the car builds stock.
 */
function preserveRoleNames(profile, prior, report) {
  if (!prior.textures) return;
  const priorByFile = new Map();
  for (const [role, t] of Object.entries(prior.textures)) {
    if (t?.file) priorByFile.set(t.file.toLowerCase(), role);
  }

  const renames = [];
  for (const [role, t] of Object.entries(profile.textures ?? {})) {
    const want = priorByFile.get((t?.file ?? '').toLowerCase());
    if (!want || want === role || profile.textures[want]) continue;
    renames.push([role, want]);
  }

  for (const [from, to] of renames) {
    profile.textures[to] = profile.textures[from];
    delete profile.textures[from];
    for (const block of ['panels', 'adjacency', 'aliases']) {
      if (profile[block]?.[from] === undefined) continue;
      profile[block][to] = profile[block][from];
      delete profile[block][from];
    }
    report.roles.push({ from, to });
  }

  // One pass over the whole table with every rename known, rather than a pass
  // per rename: rewriting the same entry twice is how a two-step rename lands on
  // the wrong role, and the collision guard above only rules that out today.
  const moved = new Map(renames);
  if (!moved.size) return;
  for (const entry of Object.values(profile.bind ?? {})) {
    if (!Array.isArray(entry?.roles)) continue;
    entry.roles = entry.roles.map((r) => moved.get(r) ?? r);
  }
}

/**
 * Whole blocks a model has no opinion about. Copied only if absent.
 *
 * Deep-copied, so the two profiles do not end up sharing the same objects. The
 * caller still holds `prior`, and a profile whose notes are literally the same
 * array as another profile's is a mutation waiting to travel somewhere nobody
 * looked for it.
 */
function preserveBlocks(profile, prior, report) {
  for (const key of HANDWRITTEN_BLOCKS) {
    if (prior[key] === undefined || profile[key] !== undefined) continue;
    profile[key] = structuredClone(prior[key]);
    report.blocks.push(key);
  }
}

/**
 * A hand-set texture size.
 *
 * A profile that overrides one records `modelSize` alongside it precisely so the
 * override stays distinguishable from the measurement. RSS4's rim face ships as
 * a 28x28 placeholder and was deliberately painted at 256x256, since UVs are
 * fractions and the detail is free. Regeneration overwrote it with 28x28, and
 * the build then failed outright — a blur sigma scaled to texture size came out
 * at 0.19 and the renderer rejected it. Loud, but only by luck.
 *
 * Kept only while the model still measures what it measured before. If the
 * model's own size has changed, the override was made against a different
 * texture and the fresh measurement wins.
 */
function preserveTextureSizes(profile, prior, report) {
  for (const [role, was] of Object.entries(prior.textures ?? {})) {
    const now = profile.textures?.[role];
    if (!now || !Array.isArray(was.modelSize)) continue;
    if (was.modelSize[0] !== now.width || was.modelSize[1] !== now.height) continue;
    if (was.width === now.width && was.height === now.height) continue;
    // Copied, not aliased. `prior` is a live object the caller still holds — the
    // parsed JSON it read off disk — and handing the same array to both profiles
    // means a later edit to one silently rewrites the other's record of what the
    // model measured, which is the one number here that must not drift.
    now.modelSize = [...was.modelSize];
    now.width = was.width;
    now.height = was.height;
    if (was.notes && !now.notes) now.notes = was.notes;
    report.sizes.push({ role, width: was.width, height: was.height, modelSize: now.modelSize });
  }
}

/**
 * Panels for a role the model yields nothing measurable for — below the coverage
 * threshold, or a texture belonging to a separate driver model that this kn5
 * does not contain. Those panels were written by hand, measurement has nothing
 * to say about them, and replacing them with an empty object deletes work in
 * exchange for nothing. A role that DID measure is left alone: there the
 * measurement is the better answer.
 */
function preserveUnmeasuredPanels(profile, prior, report) {
  for (const [role, was] of Object.entries(prior.panels ?? {})) {
    const count = Object.keys(was ?? {}).length;
    if (!count) continue;
    if (Object.keys(profile.panels?.[role] ?? {}).length) continue;
    if (!profile.textures?.[role]) continue;
    (profile.panels ??= {})[role] = structuredClone(was);
    report.panels.push({ role, count });
  }
}

/** Aliases, followed by rectangle. See the header — this is the one that bit. */
function preserveAliases(profile, prior, report) {
  if (!prior.aliases) return;
  const aliases = {};

  for (const [role, byName] of Object.entries(prior.aliases)) {
    const now = profile.panels?.[role] ?? {};
    for (const [alias, target] of Object.entries(byName)) {
      const was = prior.panels?.[role]?.[target];
      const key = rectKey(was);

      // No rectangle to follow — a hand-written panel with no geometry. Name is
      // all there is, so name is what gets checked.
      if (key === null) {
        if (now[target]) (aliases[role] ??= {})[alias] = target;
        else report.gone.push(`${role}.${alias} -> ${target}`);
        continue;
      }

      const sameRect = Object.entries(now).filter(([, p]) => rectKey(p) === key);
      if (!sameRect.length) { report.gone.push(`${role}.${alias} -> ${target}`); continue; }

      // The old name still on the right texels is the happy path.
      if (sameRect.some(([n]) => n === target)) { (aliases[role] ??= {})[alias] = target; continue; }

      // Several panels can share one rectangle — four wheels on one rim sheet.
      // The nearest centroid picks the instance the alias meant, with the name
      // as a tiebreak so the choice never depends on key order.
      const [name] = sameRect.length === 1 ? sameRect[0]
        : sameRect.slice().sort(([a, pa], [b, pb]) =>
          dist(pa.centroid3d, was.centroid3d) - dist(pb.centroid3d, was.centroid3d)
          || a.localeCompare(b))[0];
      (aliases[role] ??= {})[alias] = name;
      report.moved.push(`${role}.${alias}: ${target} -> ${name}`);
    }
  }

  report.aliases = Object.values(aliases).reduce((s, o) => s + Object.keys(o).length, 0);
  if (report.aliases) profile.aliases = aliases;
}

/** The report as lines a CLI can print, or an empty array when nothing moved. */
export function describeHandwork(report, source) {
  const out = [];
  if (report.name) out.push(`  kept the car name "${report.name}" from ${source} (pass --car-name to change it)`);
  if (report.roles.length) {
    out.push(`  kept ${report.roles.length} hand-chosen role name(s) from ${source}:`);
    for (const { from, to } of report.roles) out.push(`    ${from} -> ${to}`);
  }
  for (const b of report.blocks) out.push(`  kept hand-written "${b}" from ${source}`);
  for (const s of report.sizes) {
    out.push(`  kept hand-set size for ${s.role}: ${s.width}x${s.height} ` +
      `(the model says ${s.modelSize.join('x')})`);
  }
  if (report.panels.length) {
    out.push(`  kept hand-written panels for ${report.panels.length} role(s) the model ` +
      `measured nothing for: ${report.panels.map((p) => `${p.role} (${p.count})`).join(', ')}`);
  }
  if (report.aliases) out.push(`  kept ${report.aliases} alias(es) from ${source}`);
  if (report.moved.length) {
    out.push(`  ${report.moved.length} alias(es) followed their panel to a new generated name:`);
    for (const m of report.moved) out.push(`    ${m}`);
  }
  if (report.gone.length) {
    out.push(`  ${report.gone.length} alias(es) name a panel this model no longer has, and were dropped:`);
    for (const g of report.gone) out.push(`    ${g}`);
  }
  if (report.skinOnly.length) {
    out.push(`  kept ${report.skinOnly.length} role(s) only a skins folder knows about, ` +
      'because this run had none to look at:');
    for (const s of report.skinOnly) out.push(`    ${s.role}  (${s.file})`);
    out.push('    Pass --skins <car>/skins to measure them again instead.');
  }
  if (report.dangling.length) {
    out.push(`  ${report.dangling.length} binding(s) name a role this model no longer has, ` +
      'and were dropped — a profile that kept them could not be loaded at all:');
    for (const d of report.dangling) {
      out.push(`    ${d.term} -> ${d.roles.join(', ')}${d.source === 'human' ? '  (confirmed by hand — worth a look)' : ''}`);
    }
  }
  return out;
}
