import { assign, setup, type SnapshotFrom } from "xstate";
import type { Effort, Phase } from "./rules.ts";

export const RESUME_TOOL = "resume_work";
export const CHECKPOINT_TOOL = "request_checkpoint";
const BANNER = "pair-phase-banner";
// What "compression" means here. Without it the refine banners only name the word, and the model
// fills it in with terseness or speculative abstraction.
const COMPRESSION = `Compression here means semantic compression: removing duplication that already exists in the
working code, so each piece says only what is unique to it. It is not making code shorter, and not adding
abstractions for cases that do not exist yet. Measure it by the total cost to a reader and maintainer.`;

export interface PairContext {
	task?: string;
	effort?: Effort;
	/** Writes since BUILD was last entered; entries rather than a Map so snapshots persist as JSON. */
	writesPerFile: [string, number][];
	/** Whether the current checkpoint came from REFINE, so CONTINUE returns there rather than to BUILD. */
	refining: boolean;
}

export type PairEvent =
	| { type: "TASK"; task: string; effort: Effort }
	/** Like TASK but always plans first, whatever the effort. From a checkpoint it re-plans and needs no task. */
	| { type: "PLAN"; task?: string; effort?: Effort }
	| { type: "WRITE"; path: string }
	| { type: "APPROVE" }
	| { type: "CHECKPOINT" }
	| { type: "DISCUSS" }
	/** From IDLE it starts a task; the task text says what to look at. From a checkpoint it needs none. */
	| { type: "REFINE"; task?: string }
	| { type: "AGREE" }
	| { type: "CONTINUE" }
	| { type: "DONE" };

export const pairMachine = setup({
	types: { context: {} as PairContext, events: {} as PairEvent },
	guards: {
		trivial: ({ event }) => event.type === "TASK" && event.effort === "trivial",
		refining: ({ context }) => context.refining,
	},
	actions: {
		startTask: assign(({ event }) =>
			event.type === "TASK" || event.type === "PLAN" ? { task: event.task, effort: event.effort } : {},
		),
		startRefineTask: assign(({ event }) => (event.type === "REFINE" ? { task: event.task, effort: undefined } : {})),
		clearTask: assign({ task: undefined, effort: undefined }),
		enterBuild: assign({ writesPerFile: [], refining: false }),
		enterRefine: assign({ writesPerFile: [], refining: true }),
		countWrite: assign({
			writesPerFile: ({ context, event }) => {
				if (event.type !== "WRITE") return context.writesPerFile;
				const counts = new Map(context.writesPerFile);
				counts.set(event.path, (counts.get(event.path) ?? 0) + 1);
				return [...counts];
			},
		}),
	},
}).createMachine({
	id: "pair",
	initial: "IDLE",
	context: { writesPerFile: [], refining: false },
	states: {
		IDLE: {
			on: {
				TASK: [
					{ guard: "trivial", target: "task.BUILD", actions: "startTask" },
					{ target: "task.DESIGN", actions: "startTask" },
				],
				PLAN: { target: "task.DESIGN", actions: "startTask" },
				REFINE: { target: "task.REFINE", actions: "startRefineTask" },
			},
		},
		task: {
			initial: "DESIGN",
			on: { DONE: { target: "IDLE", actions: "clearTask" } },
			states: {
				DESIGN: { tags: "readOnly", on: { APPROVE: "BUILD" } },
				BUILD: { entry: "enterBuild", on: { WRITE: { actions: "countWrite" }, CHECKPOINT: "CHECKPOINT" } },
				CHECKPOINT: {
					tags: "readOnly",
					initial: "review",
					on: {
						CONTINUE: [{ guard: "refining", target: "REFINE.apply" }, { target: "BUILD" }],
						PLAN: "DESIGN",
						REFINE: "REFINE",
					},
					states: {
						review: { on: { DISCUSS: "discuss" } },
						discuss: { tags: "discussing" },
					},
				},
				// Behaviour-preserving compression. It starts by agreeing what is worth compressing.
				REFINE: {
					entry: "enterRefine",
					initial: "propose",
					states: {
						propose: {
							tags: "readOnly",
							initial: "review",
							on: { AGREE: "apply" },
							states: {
								review: { on: { DISCUSS: "discuss" } },
								discuss: { tags: "discussing" },
							},
						},
						apply: { on: { CHECKPOINT: "#pair.task.CHECKPOINT" } },
					},
				},
			},
		},
	},
});

export type PairSnapshot = SnapshotFrom<typeof pairMachine>;

export function phaseOf(snapshot: PairSnapshot): Phase {
	if (snapshot.value === "IDLE") return "IDLE";
	const inner = (snapshot.value as { task: Phase | Partial<Record<Phase, string>> }).task;
	return typeof inner === "string" ? inner : (Object.keys(inner)[0] as Phase);
}

export function isReadOnly(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("readOnly");
}

export function isApplyingRefinement(snapshot: PairSnapshot): boolean {
	return snapshot.matches({ task: { REFINE: "apply" } });
}

/** Talking over a checkpoint or a refinement proposal, after the one-time selector. */
export function isDiscussing(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("discussing");
}

export function isProposingRefinement(snapshot: PairSnapshot): boolean {
	return snapshot.matches({ task: { REFINE: "propose" } });
}

export function banner(snapshot: PairSnapshot): string {
	const { task, effort } = snapshot.context;
	const taskLine = task ? `\nTask: ${task}` : "";
	switch (phaseOf(snapshot)) {
		case "DESIGN":
			return `[PHASE: DESIGN]${taskLine}
Edit and write tools are removed; bash is read-only. ${
				effort === "complex" ? "Explore the affected code thoroughly before proposing anything. " : ""
			}Produce a concrete plan: files to change, what changes, how you will verify. Then stop and wait for approval.`;
		case "BUILD":
			return `[PHASE: BUILD]${taskLine}
Implement the approved plan. If you reach a point where a human should look before you continue, end your message with the line:
STATUS: checkpoint-requested`;
		case "CHECKPOINT":
			if (isDiscussing(snapshot)) {
				return `[PHASE: CHECKPOINT — DISCUSSION]${taskLine}
The review summary has been given. The user is now discussing the work with you: answer their questions and
talk through changes, but do not repeat the summary. Edit and write tools are removed; bash is read-only.
If the user asks to resume work, call ${RESUME_TOOL}; the user confirms before anything changes.`;
			}
			return `[PHASE: CHECKPOINT]${taskLine}
Stop building. Edit and write tools are removed. Summarize for review: what changed and where, what is verified and how, what is still open. Do not continue work until the user responds.`;
		case "REFINE":
			if (isApplyingRefinement(snapshot)) {
				return `[PHASE: REFINE]${taskLine}
${COMPRESSION}
Carry out the refinement agreed with the user. It must not change behaviour. Work in rounds you can verify,
running the tests after each. Call ${CHECKPOINT_TOOL} when a round is done, or as soon as anything fails;
do not fix a failure forward.`;
			}
			if (isDiscussing(snapshot)) {
				return `[PHASE: REFINE — DISCUSSING THE PROPOSAL]${taskLine}
${COMPRESSION}
The proposal has been given. The user is discussing it with you: answer, revise the proposal where they
push back, but do not repeat it whole. Edit and write tools are removed; bash is read-only. If the user
agrees to go ahead, call ${RESUME_TOOL}; the user confirms before anything changes.`;
			}
			return `[PHASE: REFINE — PROPOSE]${taskLine}
${COMPRESSION}
Edit and write tools are removed; bash is read-only. Look at the code as it stands and propose what, if
anything, is worth compressing and why, and what you would leave alone. Then stop and wait: the user and
you agree on what to change before anything changes.`;
		case "IDLE":
			return "[PHASE: IDLE]";
	}
}

export function bannerMessage(snapshot: PairSnapshot) {
	return { customType: BANNER, content: banner(snapshot), display: false };
}

/**
 * A persisted snapshot this machine can still restore, or undefined. Snapshots saved by an older
 * machine shape would otherwise pass createActor and crash asynchronously on start.
 */
export function restorable(saved: PairSnapshot | undefined): PairSnapshot | undefined {
	if (!saved) return undefined;
	try {
		pairMachine.resolveState({ value: saved.value, context: saved.context });
		return saved;
	} catch {
		return undefined;
	}
}
