import type { RunResult } from "./execute";

/**
 * Week 3 "done when": every run ends with ONE clear outcome, at the top of report.md and on the screen.
 *
 *   SUCCESS               everything planned ran, the read-back was clean, the copy is saved
 *                         (automatic moves are allowed - you saw them and typed y - and are listed)
 *   BLOCKED               nothing was saved: the plan had a problem the code can't fix (a block cuts into the
 *                         model and sliding it up to 2 m doesn't clear it, an unknown item, ...), you stopped it,
 *                         a step failed in SketchUp, or the read-back found something wrong
 *   MAX_ATTEMPTS_REACHED  a limited retry gave up: the repair moved a block on all 3 tries and it still collides,
 *                         or the language model couldn't plan a change in its tries (then the rest ran)
 *   NOT RUN               --dry: plan only
 */
export type Outcome = "SUCCESS" | "BLOCKED" | "MAX_ATTEMPTS_REACHED" | "NOT RUN";

export type OutcomeInput = {
  planErrors: string[];
  repairsExhausted: boolean;
  moved: string[]; // "S1 0.87 m north (brief line 1)"
  modelGaveUp: { line: number; reason: string }[];
  notChecked?: string[]; // things the checks could not look at (e.g. a model with no building around the room)
  dry: boolean;
  declined: boolean;
  run: RunResult | null;
};

export function runOutcome(o: OutcomeInput): { outcome: Outcome; why: string[] } {
  const gaveUp = o.modelGaveUp.map((g) => `the language model could not plan change ${g.line} in its tries: ${g.reason}`);
  if (o.planErrors.length) {
    const errs = o.planErrors.slice(0, 3).concat(o.planErrors.length > 3 ? [`... and ${o.planErrors.length - 3} more`] : []);
    if (o.repairsExhausted) return { outcome: "MAX_ATTEMPTS_REACHED", why: ["the automatic repair moved a block on all 3 of its tries and it still cuts into the model; nothing ran", ...errs] };
    return { outcome: "BLOCKED", why: ["the plan has problems the code can't fix, so nothing ran", ...errs] };
  }
  if (o.dry) return { outcome: "NOT RUN", why: ["plan only (--dry)", ...gaveUp] };
  if (o.declined) return { outcome: "BLOCKED", why: ["you stopped it before anything ran"] };
  const run = o.run;
  if (!run) return { outcome: "BLOCKED", why: ["nothing ran"] };
  if (run.stoppedAt !== null) {
    const failed = run.results.find((r) => !r.ok);
    return { outcome: "BLOCKED", why: [`action ${run.stoppedAt} failed${failed ? `: ${failed.message}` : ""}; nothing was saved (close the open model WITHOUT saving)`] };
  }
  const moved = [...o.moved.map((m) => `moved automatically (you approved it): ${m}`), ...(o.notChecked ?? []).map((n) => `NOT CHECKED: ${n}`)];
  if (gaveUp.length) return { outcome: "MAX_ATTEMPTS_REACHED", why: [...gaveUp, `everything else ran and was saved: ${run.savedPath}`, ...moved] };
  return { outcome: "SUCCESS", why: [`all ${run.results.length} actions ran, the read-back was clean, saved ${run.savedPath}`, ...moved] };
}
