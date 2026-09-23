import type { Effort, ReviewGate } from "./rules.ts";

// The judgment calls at each phase transition. Hard rules in rules.ts have already run;
// an implementation only sees the ambiguous middle.
export interface Decider {
	classifyEffort(task: string): Promise<Effort>;
	/** Called at a BUILD turn boundary that no hard rule forced. */
	shouldCheckpoint(signals: CheckpointSignals): Promise<boolean>;
	/**
	 * Whether a human gate can be passed without asking: auto-approving a plan, or auto-finishing a
	 * task whose BUILD run settled. Only called for gates deciderMayPass allows. Mid-run checkpoints
	 * never come here; the Decider already chose them.
	 */
	canSkipReview(signals: ReviewSignals): Promise<boolean>;
}

export interface CheckpointSignals {
	task: string;
	filesTouched: number;
	writesSinceCheckpoint: number;
	/** The agent claimed it wants review. Weak evidence: never sufficient on its own. */
	selfReportedCheckpoint: boolean;
	lastAssistantText: string;
}

export interface ReviewSignals {
	gate: ReviewGate;
	task: string;
	effort: Effort;
	filesTouched: number;
	/** The plan for "plan", the agent's final message for "finish". */
	lastAssistantText: string;
}

const FILE_PATH = /[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|md|json|ya?ml|toml|css|html|sh)\b/g;

// ponytail: keyword/length heuristics standing in for Jev. Replace with a JevDecider
// behind this same interface once the tracer's phase flow is proven.
export class RuleDecider implements Decider {
	async classifyEffort(task: string): Promise<Effort> {
		if (/\b(refactor|redesign|architect|migrat|across|every|all (the )?files)\b/i.test(task)) return "complex";
		if (task.length < 120 && /\b(typo|rename|bump|fix (a |the )?(typo|import)|one[- ]line)\b/i.test(task)) return "trivial";
		return "standard";
	}

	async shouldCheckpoint(s: CheckpointSignals): Promise<boolean> {
		const substantial = s.filesTouched >= 3 || s.writesSinceCheckpoint >= 6;
		return substantial || (s.selfReportedCheckpoint && s.writesSinceCheckpoint >= 2);
	}

	async canSkipReview(s: ReviewSignals): Promise<boolean> {
		if (s.gate === "finish") return s.filesTouched <= 1;
		const filesNamed = new Set(s.lastAssistantText.match(FILE_PATH) ?? []).size;
		return filesNamed <= 2 && s.lastAssistantText.split("\n").length <= 30;
	}
}
