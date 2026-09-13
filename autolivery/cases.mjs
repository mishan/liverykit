/**
 * A critic's verdict, scored against what a person said about the same picture.
 *
 * The critic's mistakes were most of what the runs cost. It failed rounds on a
 * roundel that was whole, on a stripe the car's own vents interrupt, and it
 * passed a Gulf livery with a pink stripe in it. Each of those is a picture and
 * a person's verdict on it, and a prompt change can be tried against all of
 * them with the local model, for nothing, before a paid run finds out.
 *
 * An expectation names words to look for, as case-insensitive patterns:
 *
 *   notCutOff   nothing matching is in cut_off (it is whole)
 *   cutOff      something matching is in cut_off
 *   flagged     something matching is in cut_off or unreadable
 *   notFlagged  nothing matching is in either
 *   missing     a requirement matching is marked not present
 *   present     every requirement matching is marked present, and there is one
 *   palette_ok  the verdict's palette_ok is this
 *   passes      the gate would pass the verdict, or not
 */

import { passes } from './loop.mjs';

const matches = (text, pattern) => new RegExp(pattern, 'i').test(String(text ?? ''));

export function score(v, expect = {}) {
  if (!v || v.error) return [`no verdict: ${v?.error ?? 'nothing came back'}`];
  const cut = v.cut_off ?? [];
  const faint = v.unreadable ?? [];
  const reqs = v.requirements ?? [];
  const flagged = [...cut.map((c) => c.what), ...faint.map((u) => u.what)];
  const fails = [];
  for (const w of expect.notCutOff ?? []) {
    const said = cut.find((c) => matches(c.what, w));
    if (said) fails.push(`called /${w}/ cut off ("${said.what}"), and it is whole`);
  }
  for (const w of expect.cutOff ?? []) {
    if (!cut.some((c) => matches(c.what, w))) fails.push(`did not call /${w}/ cut off`);
  }
  for (const w of expect.flagged ?? []) {
    if (!flagged.some((t) => matches(t, w))) fails.push(`did not flag /${w}/ as cut off or unreadable`);
  }
  for (const w of expect.notFlagged ?? []) {
    const said = flagged.find((t) => matches(t, w));
    if (said) fails.push(`flagged /${w}/ ("${said}"), and it is fine`);
  }
  for (const w of expect.missing ?? []) {
    if (!reqs.some((r) => !r.present && matches(r.asked, w))) fails.push(`did not say /${w}/ is missing`);
  }
  for (const w of expect.present ?? []) {
    const about = reqs.filter((r) => matches(r.asked, w));
    if (!about.length) fails.push(`listed no requirement matching /${w}/`);
    else if (about.some((r) => !r.present)) fails.push(`said /${w}/ is not there, and it is`);
  }
  if (typeof expect.palette_ok === 'boolean' && v.palette_ok !== expect.palette_ok) {
    fails.push(`answered palette_ok ${v.palette_ok}; a person says ${expect.palette_ok}`);
  }
  if (typeof expect.passes === 'boolean' && passes(v) !== expect.passes) {
    fails.push(`the gate would ${passes(v) ? 'pass' : 'fail'} this; a person would ${expect.passes ? 'pass' : 'fail'} it`);
  }
  return fails;
}
