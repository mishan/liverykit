/**
 * Every round of a run on one page: the picture the gate judged, and why it
 * passed or failed, in the measurement's own words.
 *
 * The editor shows only the draft that passed, once a person has it in the
 * inbox. The story worth watching is the rounds before it — a number 6%
 * visible from trackside, moved to the door, measured again — and that was in
 * the terminal and in a folder of PNGs. This page sits beside the editor and
 * reloads itself while the run goes on. It is written from the same record as
 * result.json, so it says nothing the record does not, and it adopts, proposes
 * and saves nothing: the inbox and the Accept stay the editor's.
 */

import { basename } from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const list = (title, items) => (items.length
  ? `<h4>${esc(title)}</h4><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

/** A verdict's lists, one line each, in the order the gate reads them. */
function verdictHtml(title, v) {
  if (!v) return '';
  if (v.error) return `<h4>${esc(title)}</h4><p class="fail">could not judge: ${esc(v.error)}</p>`;
  const no = ['reads_at_distance', 'number_legible', 'palette_ok', 'matches_brief'].filter((k) => v[k] === false);
  return `<h4>${esc(title)}</h4>` +
    list('missing', (v.requirements ?? []).filter((r) => !r.present).map((r) => `${r.asked} (${r.where})`)) +
    list('cut off', (v.cut_off ?? []).map((c) => `${c.what} (${c.where})${c.id ? ` [${c.id}]` : ''}`)) +
    list('will not read', (v.unreadable ?? []).map((u) => `${u.what} (${u.where}; ${u.why})`)) +
    list('answered false', no) +
    list('measured whole, so not cut off', (v.overruled ?? []).map((c) => `${c.what} [${c.id}]`)) +
    list('notes', v.notes ?? []);
}

function roundHtml(h, { passedIn }) {
  const head = `<h2>Round ${h.round} — ${h.passed ? '<span class="pass">passed</span>'
    : h.submitted === false ? '<span class="fail">not submitted</span>' : '<span class="fail">failed</span>'}</h2>`;
  if (h.submitted === false) {
    return `<section>${head}${list('why', h.failures ?? [])}` +
      (h.said ? `<p class="said">it last said: ${esc(h.said)}</p>` : '') + '</section>';
  }
  const g = h.gates ?? {};
  const gates = ['render', 'fitment', 'critic']
    .map((k) => `<span class="${String(g[k]).startsWith('pass') ? 'pass' : 'fail'}">${k} ${esc(g[k])}</span>`)
    .join(' · ') + (h.secondLook ? ` · second look decided` : '');
  const pictures = (h.renders ?? []).map((p) => `<img src="${esc(encodeURI(basename(p)))}" alt="round ${h.round}">`).join('');
  const minor = (h.fitment?.minor ?? []).map((f) => `${f.kind}: ${f.why}`);
  return `<section class="${h.passed ? 'passed' : ''}${h.round === passedIn ? ' final' : ''}">${head}` +
    `<p class="gates">${gates}</p>` +
    (h.summary ? `<p class="summary">${esc(h.summary)}</p>` : '') +
    pictures +
    list('what failed it', h.failures ?? []) +
    verdictHtml('critic', h.critic) +
    (h.secondLook ? verdictHtml('second look, closer', h.secondLook) : '') +
    (minor.length ? `<details><summary>${minor.length} low finding(s), which fail nothing</summary>` +
      `<ul>${minor.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></details>` : '') +
    '</section>';
}

/**
 * The page for a run as it stands. `result` is what the loop saves as
 * result.json; `rounds` is how many it may take. While the run goes on the
 * page reloads itself every `refresh` seconds, and once it has finished it
 * stops, so a page left open on a second screen does not flicker all day.
 */
export function attemptsPage(result, { rounds = null, refresh = 3 } = {}) {
  const history = result.history ?? [];
  const running = !result.finished && !result.passed && !result.stopped;
  const status = result.passed
    ? `passed in round ${result.passedIn}` + (result.proposalId
      ? ' — in the editor\'s inbox, for a person to accept or discard'
      : result.proposalError ? ` — but the editor refused the proposal: ${result.proposalError}` : '')
    : result.stopped ? `stopped: ${result.stopped}`
      : running ? `round ${history.length + 1}${rounds ? ` of ${rounds}` : ''} in progress`
        : `did not pass in ${history.length} round(s)`;
  // Newest first, so the round that just landed is on screen without scrolling.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
${running ? `<meta http-equiv="refresh" content="${refresh}">\n` : ''}<title>autolivery — ${esc(status)}</title>
<style>
body { font: 15px/1.4 system-ui, sans-serif; background: #15171a; color: #e6e6e6; margin: 1.5em auto; max-width: 1400px; padding: 0 1em; }
h1 { font-size: 1.3em; margin: 0 0 .2em; } h2 { margin: 0 0 .3em; } h4 { margin: .8em 0 .2em; color: #aab; }
.brief { font-size: 1.15em; } .status { font-size: 1.1em; }
section { border: 1px solid #333; border-radius: 6px; padding: 1em; margin: 1em 0; }
section.passed { border-color: #3a7; }
img { width: 100%; display: block; margin: .6em 0; border-radius: 4px; }
.pass { color: #5c9; } .fail { color: #e76; } .said, .summary { color: #ccc; font-style: italic; }
ul { margin: .2em 0; padding-left: 1.3em; } details { color: #999; margin-top: .6em; }
</style></head><body>
<h1>autolivery</h1>
<p class="brief">${esc(result.brief)}</p>
<p class="status ${result.passed ? 'pass' : running ? '' : 'fail'}">${esc(status)}</p>
${history.slice().reverse().map((h) => roundHtml(h, result)).join('\n')}
</body></html>
`;
}
