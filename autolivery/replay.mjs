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

export async function loadRecording(dir) {
  const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  const history = result.history ?? [];
  if (history.length && history.every((h) => h.draft)) {
    return {
      dir,
      result,
      brief: result.brief,
      perRound: true,
      rounds: history.map((h) => ({ draft: h.draft, summary: h.summary ?? '' })),
    };
  }
  if (!result.draft) throw new Error(`${dir}/result.json holds no draft to replay`);
  return {
    dir,
    result,
    brief: result.brief,
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
