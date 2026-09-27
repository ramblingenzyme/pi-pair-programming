import { assign, createActor, setup, type Actor, type SnapshotFrom, type Subscription } from "xstate";
import type { Effort, Phase } from "./rules.ts";

export const RESUME_TOOL = "resume_work";
export const CHECKPOINT_TOOL = "request_checkpoint";
const BANNER = "pair-phase-banner";
// The rules of the whole workflow, appended to the system prompt on every turn.
// Banners then only name the phase and what to do now, instead of repeating these into the history.
export const PROTOCOL = `# Pair programming

You work in phases a human moves you through. Each turn starts with a [PHASE: ...] banner saying where you are.

- DESIGN: read-only. Explore with the user until they ask for a plan (see below). Then write a concrete plan: files to
  change, what changes, how you will verify.
- BUILD: implement the approved plan.
- CHECKPOINT: read-only. Summarize for review, then discuss the work with the user. From a refine checkpoint, you can continue refining or go back to building.
- PROPOSE: read-only. Propose what, if anything, is worth compressing and why, and what you would leave alone. Then discuss it with the user.
- REFINE: carry out the agreed compression without changing behaviour, in rounds you verify by running the tests.

In read-only phases (DESIGN, CHECKPOINT, PROPOSE) you cannot edit or write files. Bash is read-only. Do not call edit, write, or mutating bash commands; they will be blocked. Call ${RESUME_TOOL} to propose moving to a working phase.

In DESIGN and in discussions, work as a thinking partner: capture the user's ideas, explore the codebase to answer
questions of feasibility and correctness, and say what you find. Do not produce an execution plan, and do not ask for
approval, until the user asks for one. In a discussion, do not repeat the summary or proposal whole.

When the user asks to go on (build the plan, resume, or start the agreed refinement), call ${RESUME_TOOL}; the user
confirms before anything changes.

In BUILD, call ${CHECKPOINT_TOOL} when a human should look before you continue. In REFINE, call it when a round is
done, or as soon as anything fails; do not fix a failure forward.

Compression here means semantic compression: removing duplication that already exists in the working code, so each
piece says only what is unique to it. It is not making code shorter, and not adding abstractions for cases that do
not exist yet. Measure it by the total cost to a reader and maintainer.`;

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
	| { type: "CHECKPOINT" }
	| { type: "DISCUSS" }
	/** From IDLE it starts a task; the task text says what to look at. From a checkpoint it needs none. */
	| { type: "REFINE"; task?: string }
	| { type: "CONTINUE" }
	/** From a refine checkpoint, go back to BUILD instead of REFINE. */
	| { type: "RESUME_BUILD" }
	| { type: "DONE" };

// Where the agent has handed something over and it is the user's move: a one-time selector, then
// discussion once the user starts talking.
const review = {
	tags: ["readOnly", "review"],
	initial: "review",
	states: {
		review: { on: { DISCUSS: "discuss" } },
		discuss: { tags: "discussing" },
	},
} as const;

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
				REFINE: { target: "task.PROPOSE", actions: "startRefineTask" },
			},
		},
		task: {
			initial: "DESIGN",
			on: { DONE: { target: "IDLE", actions: "clearTask" } },
			states: {
				DESIGN: { tags: ["readOnly", "discussing"], on: { CONTINUE: "BUILD" } },
				BUILD: { entry: "enterBuild", tags: "working", on: { WRITE: { actions: "countWrite" }, CHECKPOINT: "CHECKPOINT" } },
				CHECKPOINT: {
					...review,
					on: {
						CONTINUE: [{ guard: "refining", target: "REFINE" }, { target: "BUILD" }],
						RESUME_BUILD: { target: "BUILD", actions: "enterBuild" },
						PLAN: "DESIGN",
						REFINE: "PROPOSE",
					},
				},
				// Behaviour-preserving compression. It starts by agreeing what is worth compressing.
				PROPOSE: { ...review, entry: "enterRefine", on: { CONTINUE: "REFINE" } },
				REFINE: { tags: "working", on: { CHECKPOINT: "CHECKPOINT" } },
			},
		},
	},
});

export type PairSnapshot = SnapshotFrom<typeof pairMachine>;

/**
 * Interface for accessing the pair state machine actor.
 * Hides the xstate Actor implementation details and provides a stable API.
 */
export interface PairActor {
	getSnapshot(): PairSnapshot;
	send(event: PairEvent): void;
	subscribe(observer: (snapshot: PairSnapshot) => void): Subscription;
	getPersistedSnapshot(): PairSnapshot;
	start(): void;
	stop(): void;
	reset(snapshot?: PairSnapshot): void;
}

/**
 * Implementation of PairActor that wraps an xstate Actor.
 * Allows resetting the actor with a new snapshot (e.g., on session reload).
 * Subscriptions survive resets by tracking observers and re-subscribing to the new actor.
 */
export class PairActorImpl implements PairActor {
	private actor: Actor<typeof pairMachine>;
	private subscriptions = new Map<(snapshot: PairSnapshot) => void, Subscription>();

	constructor(snapshot?: PairSnapshot) {
		this.actor = snapshot
			? createActor(pairMachine, { snapshot })
			: createActor(pairMachine);
	}

	getSnapshot(): PairSnapshot {
		return this.actor.getSnapshot();
	}

	send(event: PairEvent): void {
		this.actor.send(event);
	}

	subscribe(observer: (snapshot: PairSnapshot) => void): Subscription {
		const sub = this.actor.subscribe(observer);
		this.subscriptions.set(observer, sub);

		return {
			unsubscribe: () => {
				const currentSub = this.subscriptions.get(observer);
				if (currentSub) {
					currentSub.unsubscribe();
					this.subscriptions.delete(observer);
				}
			},
		};
	}

	getPersistedSnapshot(): PairSnapshot {
		return this.actor.getPersistedSnapshot() as PairSnapshot;
	}

	start(): void {
		this.actor.start();
	}

	stop(): void {
		this.actor.stop();
	}

	reset(snapshot?: PairSnapshot): void {
		this.stop();
		this.actor = snapshot
			? createActor(pairMachine, { snapshot })
			: createActor(pairMachine);

		// Re-subscribe all observers to the new actor
		for (const [observer] of this.subscriptions) {
			const newSub = this.actor.subscribe(observer);
			this.subscriptions.set(observer, newSub);
		}
	}
}

export function phaseOf(snapshot: PairSnapshot): Phase {
	if (snapshot.value === "IDLE") return "IDLE";
	const inner = (snapshot.value as { task: Phase | Partial<Record<Phase, string>> }).task;
	return typeof inner === "string" ? inner : (Object.keys(inner)[0] as Phase);
}

export function isReadOnly(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("readOnly");
}

/** CHECKPOINT or PROPOSE: the agent has handed something over for the user. */
export function isReview(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("review");
}

/** Making changes the agent may hand over for review: BUILD or REFINE. */
export function isWorking(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("working");
}

/** Talking things through: DESIGN, or a checkpoint or refinement proposal after the one-time selector. */
export function isDiscussing(snapshot: PairSnapshot): boolean {
	return snapshot.hasTag("discussing");
}

// When a mutating call hits a read-only phase, the block reason names the phase the agent
// would land in via resume_work. DESIGN always targets BUILD; CHECKPOINT targets BUILD or
// REFINE depending on whether we're mid-refinement; PROPOSE targets REFINE.
export function readOnlyTargetPhase(snapshot: PairSnapshot): string | undefined {
	switch (phaseOf(snapshot)) {
		case "DESIGN":
			return "BUILD";
		case "CHECKPOINT":
			return snapshot.context.refining ? "REFINE" : "BUILD";
		case "PROPOSE":
			return "REFINE";
		default:
			return undefined;
	}
}

// Stopping is restated here rather than left to PROTOCOL: tool gating cannot stop the agent talking,
// and the latest instruction is the one it follows.
export function banner(snapshot: PairSnapshot): string {
	const { task, effort } = snapshot.context;
	const taskLine = task ? `\nTask: ${task}` : "";
	switch (phaseOf(snapshot)) {
		case "DESIGN":
			return `[PHASE: DESIGN]${taskLine}
${effort === "complex" ? "Explore the affected code thoroughly before any plan. " : ""}No execution plan until the user asks for one.`;
		case "BUILD":
			return `[PHASE: BUILD]${taskLine}
Implement the plan.`;
		case "CHECKPOINT":
			if (isDiscussing(snapshot)) return `[PHASE: CHECKPOINT — DISCUSSION]${taskLine}`;
			return `[PHASE: CHECKPOINT]${taskLine}
Stop. Summarize what changed and where, what is verified and how, what is still open. Then wait.`;
		case "PROPOSE":
			if (isDiscussing(snapshot)) return `[PHASE: PROPOSE — DISCUSSION]${taskLine}`;
			return `[PHASE: PROPOSE]${taskLine}
Propose, then stop and wait: nothing changes until you and the user agree.`;
		case "REFINE":
			return `[PHASE: REFINE]${taskLine}
Carry out the agreed refinement.`;
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
