import type { Effort } from "../rules.ts";

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
