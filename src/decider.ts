import type { Effort } from "./rules.ts";

// The judgment calls at each phase transition. Hard rules in rules.ts have already run;
// an implementation only sees the ambiguous middle.
export interface Decider {
  classifyEffort(task: string): Promise<Effort>;
  /** Called at a BUILD turn boundary that no hard rule forced. */
  shouldCheckpoint(signals: CheckpointSignals): Promise<boolean>;
  /**
   * Whether a task whose BUILD run settled can finish without asking. Only called when
   * deciderMayPass allows. Mid-run checkpoints
   * never come here; the Decider already chose them.
   */
  canSkipReview(signals: ReviewSignals): Promise<boolean>;
}

export interface CheckpointSignals {
  task: string;
  filesTouched: number;
  writesSinceCheckpoint: number;
  lastAssistantText: string;
}

export interface ReviewSignals {
  task: string;
  effort: Effort;
  filesTouched: number;
  lastAssistantText: string;
}

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
