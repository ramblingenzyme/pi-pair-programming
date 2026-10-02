import type { Effort } from "../rules.ts";
import type { CheckpointSignals, Decider, ReviewSignals } from "./decider.ts";

// ponytail: keyword/length heuristics standing in for Jev. Replace with a JevDecider
// behind this same interface once the tracer's phase flow is proven.
export class RuleDecider implements Decider {
  async classifyEffort(task: string): Promise<Effort> {
    if (/\b(refactor|redesign|architect|migrat|across|every|all (the )?files)\b/i.test(task))
      return "complex";
    if (
      task.length < 120 &&
      /\b(typo|rename|bump|fix (a |the )?(typo|import)|one[- ]line)\b/i.test(task)
    )
      return "trivial";
    return "standard";
  }

  async shouldCheckpoint(s: CheckpointSignals): Promise<boolean> {
    return s.filesTouched >= 3 || s.writesSinceCheckpoint >= 6;
  }

  async canSkipReview(s: ReviewSignals): Promise<boolean> {
    return s.filesTouched <= 1;
  }
}
