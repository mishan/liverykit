/**
 * A planner that designs nothing: it puts back what a real run drafted.
 *
 * Most of what changes in this project is the harness around the model — the
 * gate, fitment, the critic's prompt, the renders — and every one of those
 * was being tested by paying a model to design a livery from scratch. The
 * designs already exist. Replayed round by round against the current code,
 * with the local critic judging, a run costs nothing, and the only thing that
 * differs from the original is the thing being tested.
 *
 * A run records each round's draft and summary in result.json. One written
 * before that was recorded kept only its final draft, and replays as a single
 * round of it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Short fingerprints of the editor's working design and working fit, or null if
 * either could not be read. A draft is operations on both. The design alone was
 * fingerprinted at first, and an editor opened with another --fit took a run's
 * draft_fit operations onto a different fit and passed the check.
 */
export async function designDigest(mcp) {
  const read = async (tool) => {
    const r = await mcp.callTool(tool, {});
    const text = r.isError ? null : r.content?.[0]?.text;
    return text ? fingerprint(text) : null;
  };
  const design = await read('read_design');
  const fit = await read('read_fit');
  return design && fit ? { design, fit } : null;
}

/**
 * Whether the editor holds what a recorded run started from: `{ error }` if it
 * does not, `{ note }` if the record cannot say, `{}` if it does.
 *
 * A run recorded before the fit was fingerprinted holds the design's digest
 * alone, as a string. It is held to the design and said plainly to leave the
 * fit unchecked: refusing it would fail replays that may well be right, and
 * passing it without a word would claim a check nobody made.
 */
export function checkBase(recording, current) {
  const { dir, base } = recording;
  if (!base) {
    return { note: 'this run did not record the design it started from, so the replay cannot check the editor holds it' };
  }
  const recorded = typeof base === 'string' ? { design: base } : base;
  if (recorded.design !== current.design) {
    return { error: `the editor's working design is not the one ${dir} started from, so its operations would ` +
      'land on a different design. Open the livery that run was made against, as it was then.' };
  }
  if (typeof base === 'string') {
    return { note: 'this run recorded the design it started from but not the fit, so the replay cannot check ' +
      'the fit the editor holds is the one it was made against' };
  }
  if (recorded.fit !== current.fit) {
    return { error: `the editor's working fit is not the one ${dir} started from, so its fit operations would ` +
      'land on a different fit. Start the editor with the fit that run was made against, as it was then.' };
  }
  return {};
}

export async function loadRecording(dir) {
  const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  const history = result.history ?? [];
  if (history.length && history.every((h) => h.draft)) {
    return {
      dir,
      result,
      brief: result.brief,
      base: result.base,
      perRound: true,
      rounds: history.map((h) => ({ draft: h.draft, summary: h.summary ?? '' })),
    };
  }
  if (!result.draft) throw new Error(`${dir}/result.json holds no draft to replay`);
  return {
    dir,
    result,
    brief: result.brief,
    base: result.base,
    perRound: false,
    rounds: [{ draft: result.draft, summary: result.summary ?? '' }],
  };
}

export function createReplayPlanner(recording) {
  return {
    async round({ n, call }) {
      const r = recording.rounds[Math.min(n, recording.rounds.length) - 1];
      // Each round's draft is the whole of it, not what changed: start clean.
      await call('reset_draft', {});
      for (const [tool, key] of [['draft_design', 'design'], ['draft_fit', 'fit']]) {
        if (!r.draft[key]?.length) continue;
        const put = await call(tool, { [key]: r.draft[key] });
        // The end of the replay, said. A refusal used to be one ✗ in the log,
        // and the round went on to be judged on an empty draft and fail as
        // "the draft is empty", which is not what happened to it.
        if (put.isError) {
          throw new Error(`round ${n}: today's editor refuses the recorded ${tool}, so the run cannot be ` +
            `replayed from here: ${put.content?.[0]?.text ?? 'no reason given'}`);
        }
      }
      await call('finish_round', { summary: r.summary });
      return { summary: r.summary };
    },
  };
}
