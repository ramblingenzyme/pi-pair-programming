import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Actor, createActor } from "xstate";
import { type Decider, RuleDecider, SELF_REPORT } from "./decider.ts";
import { LlmDecider } from "./llm-decider.ts";
import {
	type PairSnapshot,
	isApplyingRefinement,
	isDiscussing,
	isReadOnly,
	pairMachine,
	phaseOf,
	restorable,
} from "./machine.ts";
import {
	WRITE_TOOLS,
	isDestructive,
	isMutating,
	isThrashing,
	midRunCheckpoint,
	deciderMayPass,
} from "./rules.ts";

const STATE_ENTRY = "pair-state";
// Fast and cheap: judgment calls sit on the agent's critical path. Thinking stays off by leaving
// `reasoning` unset, which pi sends as thinking: disabled for DeepSeek-format providers.
const JUDGE = { provider: "opencode-go", model: "deepseek-v4-flash" };
// A judgment call that takes longer than this is worth less than the rules' instant answer.
const DECIDER_TIMEOUT_MS = 20_000;
const BANNER = "pair-phase-banner";
const JUDGE_ENTRY = "pair-judge";
const RESUME_TOOL = "resume_work";
const CHECKPOINT_TOOL = "request_checkpoint";
const DISCUSS_HINT = "Discussing the checkpoint. /continue resumes building, /done ends the task.";

export default function pairProgrammer(pi: ExtensionAPI) {
	let actor: Actor<typeof pairMachine> = createActor(pairMachine);
	let session: ExtensionContext | undefined;
	let lastUserText = "";

	pi.registerFlag("pair-rules", {
		description: `Use keyword rules instead of ${JUDGE.model} for pair-programmer judgment calls`,
		type: "boolean",
		default: false,
	});

	const rules = new RuleDecider();
	const decider: Decider = new LlmDecider(async (systemPrompt, user) => {
		const model = session?.modelRegistry.find(JUDGE.provider, JUDGE.model);
		if (pi.getFlag("pair-rules") || !session || !model) throw new Error("no judge model");
		const response = await session.modelRegistry.complete(
			model,
			{ systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{
				signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS),
				sessionId: `${session.sessionManager.getSessionId()}:pair-judge`,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? response.stopReason);
		}
		return response.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	}, rules, (trace) => pi.appendEntry(JUDGE_ENTRY, trace));

	const phase = () => phaseOf(actor.getSnapshot());
	const context = () => actor.getSnapshot().context;

	function applyPhase(snapshot: PairSnapshot): void {
		const current = phaseOf(snapshot);
		const managed = new Set([...WRITE_TOOLS, RESUME_TOOL, CHECKPOINT_TOOL]);
		pi.setActiveTools([
			...pi.getActiveTools().filter((t) => !managed.has(t)),
			...(isReadOnly(snapshot) ? [] : WRITE_TOOLS),
			...(isDiscussing(snapshot) ? [RESUME_TOOL] : []),
			...(isApplyingRefinement(snapshot) ? [CHECKPOINT_TOOL] : []),
		]);
		const { effort } = snapshot.context;
		const exit = current === "CHECKPOINT" ? " · /continue or /done" : "";
		session?.ui.setStatus("pair", `${current}${effort ? ` · ${effort}` : ""}${exit}`);
	}

	function bannerEntry(): SessionBoundaryDraft {
		return { type: "custom_message", customType: BANNER, content: banner(actor.getSnapshot()), display: false };
	}

	pi.on("session_start", async (_event, ctx) => {
		session = ctx;
		const saved = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === STATE_ENTRY)
			.pop() as { data?: PairSnapshot } | undefined;
		actor.stop();
		actor = createActor(pairMachine, { snapshot: restorable(saved?.data) });
		let lastMode: string | undefined;
		actor.subscribe((snapshot) => {
			pi.appendEntry(STATE_ENTRY, actor.getPersistedSnapshot());
			const mode = JSON.stringify(snapshot.value);
			if (mode === lastMode) return;
			lastMode = mode;
			applyPhase(snapshot);
		});
		actor.start();
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.startsWith("/")) return;
		lastUserText = event.text;
		if (phase() === "IDLE") {
			actor.send({ type: "TASK", task: event.text, effort: await decider.classifyEffort(event.text) });
		} else if (phase() === "CHECKPOINT" && !isDiscussing(actor.getSnapshot())) {
			// Typing at a checkpoint is discussing it, however the user got here (Esc, resume, or never chose).
			actor.send({ type: "DISCUSS" });
			ctx.ui.notify(DISCUSS_HINT, "info");
		}
	});

	pi.on("before_agent_start", async () => {
		if (!context().task) return;
		return { message: { customType: BANNER, content: banner(actor.getSnapshot()), display: false } };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (isReadOnly(actor.getSnapshot()) && isMutating(command)) {
				return { block: true, reason: `${phase()} phase is read-only. Blocked: ${command}` };
			}
			if (isDestructive(command)) {
				if (!ctx.hasUI) return { block: true, reason: "Destructive command blocked (no UI to confirm)" };
				const choice = await ctx.ui.select(`Destructive command:\n\n  ${command}\n\nAllow?`, ["No", "Yes"]);
				if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
			}
			return;
		}

		if (!WRITE_TOOLS.has(event.toolName)) return;
		// Tools are already removed in read-only phases; this catches calls planned before the removal landed.
		if (isReadOnly(actor.getSnapshot())) return { block: true, reason: `${phase()} phase is read-only.` };
		if (isThrashing(new Map(context().writesPerFile))) {
			return { block: true, reason: "Checkpoint required before further writes." };
		}
		actor.send({ type: "WRITE", path: (event.input as { path: string }).path });
	});

	pi.on("turn_end", async (event) => {
		// Refining must not change behaviour, so a failure there is a bug, not something to fix forward:
		// the reverse of BUILD, where a failure means the agent is mid-fix (see midRunCheckpoint).
		if (isApplyingRefinement(actor.getSnapshot()) && event.toolResults.some((r) => r.isError)) {
			actor.send({ type: "CHECKPOINT" });
			return { entries: [bannerEntry()], continue: true };
		}
		const { task, writesPerFile } = context();
		// A turn without tool calls is the agent finishing; agent_before_settle reviews that.
		if (phase() !== "BUILD" || !task || writesPerFile.length === 0 || event.toolResults.length === 0) return;
		const counts = new Map(writesPerFile);
		const text = assistantText(event.message);
		const verdict = midRunCheckpoint(
			isThrashing(counts) !== undefined,
			event.toolResults.some((r) => r.isError),
		);
		if (verdict === "defer") return;
		if (
			verdict === "ask-decider" &&
			!(await decider.shouldCheckpoint({
				task,
				filesTouched: counts.size,
				writesSinceCheckpoint: [...counts.values()].reduce((a, b) => a + b, 0),
				selfReportedCheckpoint: SELF_REPORT.test(text),
				lastAssistantText: text,
			}))
		) {
			return;
		}
		actor.send({ type: "CHECKPOINT" });
		return { entries: [bannerEntry()], continue: true };
	});

	// Human gates: DESIGN → BUILD and a settled BUILD → done. The Decider may pass a gate on clear
	// cases that deciderMayPass allows; otherwise a person decides. A BUILD run that settles on its own is
	// finished work, so it gets the checkpoint review directly: its final message already is the summary.
	pi.on("agent_before_settle", async (event, ctx) => {
		const { task, effort, writesPerFile } = context();
		if (event.outcome !== "completed" || !task) return;
		const counts = new Map(writesPerFile);
		// A refinement started from IDLE has no effort: nothing about it was classified, so nothing auto-passes.
		const canSkip = async (gate: "plan" | "finish") =>
			effort !== undefined &&
			deciderMayPass(gate, effort, counts) &&
			(await decider.canSkipReview({
				gate,
				task,
				effort,
				filesTouched: counts.size,
				lastAssistantText: lastAssistantText(event.context.contextMessages),
			}));

		if (phase() === "DESIGN") {
			if (await canSkip("plan")) {
				ctx.ui.notify("Plan auto-approved", "info");
			} else {
				if (!ctx.hasUI) return;
				const choice = await ctx.ui.select("Plan ready?", ["Keep designing", "Approve and build"]);
				if (choice !== "Approve and build") return;
			}
			actor.send({ type: "APPROVE" });
			return { entries: [bannerEntry()], continue: true };
		}

		// Agreeing what is worth compressing is the point of proposing, so it is always the user's call.
		if (phase() === "REFINE" && !isApplyingRefinement(actor.getSnapshot())) {
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select("Refinement agreed?", ["Keep discussing", "Agree and refine"]);
			if (choice !== "Agree and refine") return;
			actor.send({ type: "AGREE" });
			return { entries: [bannerEntry()], continue: true };
		}

		if (phase() === "REFINE") actor.send({ type: "CHECKPOINT" });

		if (phase() === "BUILD") {
			if (await canSkip("finish")) {
				ctx.ui.notify("Task auto-finished", "info");
				actor.send({ type: "DONE" });
				return;
			}
			actor.send({ type: "CHECKPOINT" });
		}

		// Offered once per checkpoint. Typing a message moves to discuss (see the input hook), after which
		// the selector stays away so the conversation can run; /continue and /done leave.
		if (phase() === "CHECKPOINT" && !isDiscussing(actor.getSnapshot()) && ctx.hasUI) {
			const continueLabel = context().refining ? "Continue refining" : "Continue building";
			const choice = await ctx.ui.select("Checkpoint review", [
				"Discuss",
				continueLabel,
				"Propose refinements",
				"Task done",
			]);
			if (choice === continueLabel || choice === "Propose refinements") {
				actor.send({ type: choice === continueLabel ? "CONTINUE" : "REFINE" });
				return { entries: [bannerEntry()], continue: true };
			}
			if (choice === "Task done") {
				actor.send({ type: "DONE" });
				return;
			}
			ctx.ui.notify(DISCUSS_HINT, "info");
		}
	});

	// Compaction can drop the per-prompt banner; the phase itself is unaffected.
	// ponytail: compaction runs pi's default summary. Deciding what is safe to forget means returning
	// a custom CompactionResult from session_before_compact via a Decider call — the Jev-era slice.
	pi.on("session_compact", async () => {
		if (context().task) pi.sendMessage({ customType: BANNER, content: banner(actor.getSnapshot()), display: false });
	});

	pi.registerCommand("phase", {
		description: "Show the pair-programmer phase and task",
		handler: async (_args, ctx) => {
			const { effort, task } = context();
			ctx.ui.notify(`${phase()} · effort ${effort ?? "-"} · task ${task ?? "(none)"}`, "info");
		},
	});

	// The agent can only propose leaving a checkpoint; the user's confirm is the approval. A tool call is
	// the agent's claim that the user asked, which is self-report and can come from misreading or injection.
	pi.registerTool({
		name: RESUME_TOOL,
		label: "Resume work",
		description:
			"Propose leaving the checkpoint discussion to resume building or refining. Call only when the user has asked to continue. The user must confirm.",
		parameters: Type.Object({
			reason: Type.String({ description: "What the user said that asks to resume" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isDiscussing(actor.getSnapshot())) throw new Error("Not in a checkpoint discussion.");
			if (!ctx.hasUI) throw new Error("No one can confirm here; stay in the discussion.");
			const confirmed = await ctx.ui.confirm(
				context().refining ? "Resume refining?" : "Resume building?",
				`You said: "${lastUserText}"\n\nAgent's reading: ${params.reason}`,
			);
			if (!confirmed) {
				const text = "The user did not confirm. Stay in the discussion; do not propose resuming again unless they ask.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			actor.send({ type: "CONTINUE" });
			return { content: [{ type: "text", text: banner(actor.getSnapshot()) }], details: undefined };
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
			if (!isApplyingRefinement(actor.getSnapshot())) throw new Error("Not refining.");
			actor.send({ type: "CHECKPOINT" });
			return { content: [{ type: "text", text: banner(actor.getSnapshot()) }], details: undefined };
		},
	});

	pi.registerCommand("continue", {
		description: "Leave a checkpoint and resume building or refining",
		handler: async (_args, ctx) => {
			if (phase() !== "CHECKPOINT") {
				ctx.ui.notify(`Nothing to continue: phase is ${phase()}`, "info");
				return;
			}
			actor.send({ type: "CONTINUE" });
			pi.sendMessage({ customType: BANNER, content: banner(actor.getSnapshot()), display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand("plan", {
		description: "Plan before building: between tasks, /plan <task>; or at a checkpoint to re-plan",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (phase() === "IDLE") {
				if (!task) {
					ctx.ui.notify("Usage: /plan <task>", "info");
					return;
				}
				actor.send({ type: "PLAN", task, effort: await decider.classifyEffort(task) });
			} else if (phase() === "CHECKPOINT") {
				actor.send({ type: "PLAN" });
			} else {
				ctx.ui.notify(`Planning starts between tasks or at a checkpoint, not during ${phase()}`, "info");
				return;
			}
			pi.sendMessage({ customType: BANNER, content: banner(actor.getSnapshot()), display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand("refine", {
		description: "Propose refinements: between tasks, /refine <what to look at>; or at a checkpoint",
		handler: async (args, ctx) => {
			const what = args.trim();
			if (phase() === "IDLE") {
				actor.send({ type: "REFINE", task: what || "Refine the code as it stands" });
			} else if (phase() === "CHECKPOINT") {
				actor.send({ type: "REFINE" });
			} else {
				ctx.ui.notify(`Refining starts between tasks or at a checkpoint, not during ${phase()}`, "info");
				return;
			}
			pi.sendMessage({ customType: BANNER, content: banner(actor.getSnapshot()), display: false }, { triggerTurn: true });
		},
	});

	pi.registerCommand("done", {
		description: "End the current task; the next prompt starts a new one",
		handler: async () => {
			actor.send({ type: "DONE" });
		},
	});
}

function banner(snapshot: PairSnapshot): string {
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
Carry out the refinement agreed with the user. It must not change behaviour. Work in rounds you can verify,
running the tests after each. Call ${CHECKPOINT_TOOL} when a round is done, or as soon as anything fails;
do not fix a failure forward.`;
			}
			return `[PHASE: REFINE — PROPOSE]${taskLine}
Edit and write tools are removed; bash is read-only. Look at the code as it stands and propose what, if
anything, is worth compressing and why, and what you would leave alone. Then stop and wait: the user and
you agree on what to change before anything changes.`;
		case "IDLE":
			return "[PHASE: IDLE]";
	}
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function lastAssistantText(messages: AgentMessage[]): string {
	const last = messages.findLast((m) => m.role === "assistant");
	return last ? assistantText(last) : "";
}
