import type { PairSnapshot } from "./machine.ts";
import { phaseOf } from "./machine.ts";

const WORKFLOW_CONTEXT = `This session uses a pair-programming workflow with explicit phases:
- DESIGN: read-only exploration and planning. Ends when the user approves a plan.
- BUILD: implementation. Checkpoints happen mid-run for human review.
- CHECKPOINT: read-only review. User can continue, re-plan, refine, or finish.
- PROPOSE: read-only refinement proposal. User agrees what to compress.
- REFINE: apply agreed compression. Checkpoint when done.
- IDLE: no active task.

The agent's current phase determines what tools are available and what it should be doing. Preserve this state so work can resume correctly.`;

/**
 * Build phase-aware custom instructions for pi's compaction summarizer.
 *
 * Pi's default summary captures goals, progress, and decisions but knows nothing
 * about the pair workflow. These instructions tell the summarizer to preserve
 * the machine state so work can resume in the correct phase.
 *
 * If `eventInstructions` is provided (from pi or another extension), it is
 * appended after our workflow context.
 */
export function buildCompactionInstructions(snapshot: PairSnapshot, eventInstructions?: string): string {
	const phase = phaseOf(snapshot);
	const { task, effort, writesPerFile, refining } = snapshot.context;

	const parts: string[] = [WORKFLOW_CONTEXT];

	if (phase === "IDLE" && !task) {
		parts.push("\nCurrent state: IDLE with no active task. The session may contain completed work from earlier.");
	} else {
		const stateLines: string[] = [`\nCurrent state:
- Phase: ${phase}`];
		if (task) stateLines.push(`- Task: ${task}`);
		if (effort) stateLines.push(`- Effort: ${effort}`);
		if (refining) stateLines.push("- Refining: yes (behaviour-preserving compression in progress)");

		if (writesPerFile.length > 0) {
			const writes = writesPerFile.map(([path, count]) => `${path} (${count})`).join(", ");
			stateLines.push(`- Writes since last checkpoint: ${writes}`);
		}

		parts.push(stateLines.join("\n"));
	}

	if (eventInstructions) {
		parts.push(`\nAdditional instructions: ${eventInstructions}`);
	}

	return parts.join("\n");
}
