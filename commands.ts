import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Actor } from "xstate";
import type { Decider } from "./decider.ts";
import {
	type PairContext,
	type PairSnapshot,
	type pairMachine,
	banner,
	bannerMessage,
	isDiscussing,
	isProposingRefinement,
	phaseOf,
	CHECKPOINT_TOOL,
	RESUME_TOOL,
} from "./machine.ts";
import type { Phase } from "./rules.ts";

export function registerCommands(
	pi: ExtensionAPI,
	actor: Actor<typeof pairMachine>,
	decider: Decider,
): void {
	const phase = () => phaseOf(actor.getSnapshot());
	const context = () => actor.getSnapshot().context;

	// Routes a command that is valid in IDLE (with a task) or at a CHECKPOINT (without one),
	// and notifies the user when called in any other phase.
	async function idleOrCheckpoint(
		ctx: ExtensionContext,
		onIdle: () => Promise<void>,
		onCheckpoint: () => void,
		errorPrefix: string,
	): Promise<void> {
		const current = phase();
		if (current === "IDLE") {
			await onIdle();
		} else if (current === "CHECKPOINT") {
			onCheckpoint();
		} else {
			ctx.ui.notify(`${errorPrefix} starts between tasks or at a checkpoint, not during ${current}`, "info");
			return;
		}
		pi.sendMessage(bannerMessage(actor.getSnapshot()), { triggerTurn: true });
	}

	pi.registerCommand("phase", {
		description: "Show the pair-programmer phase and task",
		handler: async (_args, ctx) => {
			const { effort, task } = context();
			ctx.ui.notify(`${phase()} · effort ${effort ?? "-"} · task ${task ?? "(none)"}`, "info");
		},
	});

	pi.registerCommand("continue", {
		description: "Move on: leave a checkpoint to resume work, or agree a refinement proposal",
		handler: async (_args, ctx) => {
			if (isProposingRefinement(actor.getSnapshot())) {
				actor.send({ type: "AGREE" });
			} else if (phase() === "CHECKPOINT") {
				actor.send({ type: "CONTINUE" });
			} else {
				ctx.ui.notify(`Nothing to continue: phase is ${phase()}`, "info");
				return;
			}
			pi.sendMessage(bannerMessage(actor.getSnapshot()), { triggerTurn: true });
		},
	});

	pi.registerCommand("plan", {
		description: "Plan before building: between tasks, /plan <task>; or at a checkpoint to re-plan",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (phase() === "IDLE" && !task) {
				ctx.ui.notify("Usage: /plan <task>", "info");
				return;
			}
			await idleOrCheckpoint(
				ctx,
				async () => {
					actor.send({ type: "PLAN", task, effort: await decider.classifyEffort(task) });
				},
				() => {
					actor.send({ type: "PLAN" });
				},
				"Planning",
			);
		},
	});

	pi.registerCommand("refine", {
		description: "Propose refinements: between tasks, /refine <what to look at>; or at a checkpoint",
		handler: async (args, ctx) => {
			const what = args.trim();
			await idleOrCheckpoint(
				ctx,
				async () => {
					actor.send({ type: "REFINE", task: what || "Refine the code as it stands" });
				},
				() => {
					actor.send({ type: "REFINE" });
				},
				"Refining",
			);
		},
	});

	pi.registerCommand("done", {
		description: "End the current task; the next prompt starts a new one",
		handler: async (_args, ctx) => {
			if (phase() === "IDLE") {
				ctx.ui.notify("No active task to end.", "info");
				return;
			}
			actor.send({ type: "DONE" });
		},
	});
}

export function registerTools(
	pi: ExtensionAPI,
	actor: Actor<typeof pairMachine>,
	lastUserText: () => string,
): void {
	const context = () => actor.getSnapshot().context;
	const bannerText = () => banner(actor.getSnapshot());

	// The agent can only propose leaving a checkpoint; the user's confirm is the approval. A tool call is
	// the agent's claim that the user asked, which is self-report and can come from misreading or injection.
	pi.registerTool({
		name: RESUME_TOOL,
		label: "Resume work",
		description:
			"Propose leaving the discussion to move on: resume building or refining after a checkpoint, or start the agreed refinement. Call only when the user has asked to go on. The user must confirm.",
		parameters: Type.Object({
			reason: Type.String({ description: "What the user said that asks to go on" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isDiscussing(actor.getSnapshot())) throw new Error("Not in a discussion.");
			if (!ctx.hasUI) throw new Error("No one can confirm here; stay in the discussion.");
			const proposing = isProposingRefinement(actor.getSnapshot());
			const confirmed = await ctx.ui.confirm(
				proposing ? "Start the agreed refinement?" : context().refining ? "Resume refining?" : "Resume building?",
				`You said: "${lastUserText()}"\n\nAgent's reading: ${params.reason}`,
			);
			if (!confirmed) {
				const text = "The user did not confirm. Stay in the discussion; do not propose moving on again unless they ask.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			actor.send({ type: proposing ? "AGREE" : "CONTINUE" });
			return { content: [{ type: "text", text: bannerText() }], details: undefined };
		},
	});

	// Asking for review only adds oversight, so unlike resume_work the agent's call is trusted as-is.
	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Request checkpoint",
		description:
			"Stop refining and hand over for review. Call when a refinement round is finished and verified, or when anything fails.",
		parameters: Type.Object({
			reason: Type.String({ description: "Why: the round that finished, or what failed" }),
		}),
		async execute() {
			if (!actor.getSnapshot().matches({ task: { REFINE: "apply" } })) throw new Error("Not refining.");
			actor.send({ type: "CHECKPOINT" });
			return { content: [{ type: "text", text: bannerText() }], details: undefined };
		},
	});
}
