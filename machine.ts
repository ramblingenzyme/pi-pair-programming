import { assign, setup, type SnapshotFrom } from "xstate";
import type { Effort, Phase } from "./rules.ts";

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
						discuss: {},
					},
				},
				// Behaviour-preserving compression. It starts by agreeing what is worth compressing.
				REFINE: {
					entry: "enterRefine",
					initial: "propose",
					states: {
						propose: { tags: "readOnly", on: { AGREE: "apply" } },
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

export function isDiscussing(snapshot: PairSnapshot): boolean {
	return snapshot.matches({ task: { CHECKPOINT: "discuss" } });
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
