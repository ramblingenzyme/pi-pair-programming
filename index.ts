import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { type Actor, createActor } from "xstate";
import { registerCommands, registerTools } from "./commands.ts";
import { type Decider, RuleDecider } from "./decider.ts";
import { LlmDecider } from "./llm-decider.ts";
import {
	type PairEvent,
	type PairSnapshot,
	bannerMessage,
	isApplyingRefinement,
	isDiscussing,
	isProposingRefinement,
	isReadOnly,
	pairMachine,
	phaseOf,
	restorable,
	CHECKPOINT_TOOL,
	RESUME_TOOL,
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
const JUDGE_ENTRY = "pair-judge";
const DISCUSS_HINT = "Discussing. /continue moves on, /done ends the task.";
const SELF_REPORT = /^\s*STATUS:\s*checkpoint-requested\s*$/im;

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
	const msg = () => bannerMessage(actor.getSnapshot());
	const writeCounts = () => new Map(context().writesPerFile);

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
		const exit = current === "CHECKPOINT" || isProposingRefinement(snapshot) ? " · /continue or /done" : "";
		session?.ui.setStatus("pair", `${current}${effort ? ` · ${effort}` : ""}${exit}`);
	}

	function bannerEntry(): SessionBoundaryDraft {
		return { type: "custom_message", ...msg() };
	}

	function moveOn(event: PairEvent) {
		actor.send(event);
		return { entries: [bannerEntry()], continue: true };
	}

	// Each settle gate asks the human when the Decider cannot pass it, and returns the response
	// that lets the agent continue, or nothing when the turn should stop here.
	async function planGate(ctx: ExtensionContext, canSkip: (gate: "plan" | "finish") => Promise<boolean>) {
		if (await canSkip("plan")) {
			ctx.ui.notify("Plan auto-approved", "info");
		} else {
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select("Plan ready?", ["Keep designing", "Approve and build"]);
			if (choice !== "Approve and build") return;
		}
		return moveOn({ type: "APPROVE" });
	}

	/** True when the finish gate auto-ended the task, so settling stops here rather than checkpointing. */
	async function finishGate(
		ctx: ExtensionContext,
		canSkip: (gate: "plan" | "finish") => Promise<boolean>,
	): Promise<boolean> {
		if (!(await canSkip("finish"))) return false;
		ctx.ui.notify("Task auto-finished", "info");
		actor.send({ type: "DONE" });
		return true;
	}

	// Offered once per checkpoint; typing moves to discuss (see the input hook), after which the
	// selector stays away so the conversation can run; /continue and /done leave.
	async function checkpointMenu(ctx: ExtensionContext) {
		if (phase() !== "CHECKPOINT" || isDiscussing(actor.getSnapshot()) || !ctx.hasUI) return;
		const continueLabel = context().refining ? "Continue refining" : "Continue building";
		const choice = await ctx.ui.select("Checkpoint review", [
			"Discuss",
			continueLabel,
			"Propose refinements",
			"Task done",
		]);
		if (choice === continueLabel || choice === "Propose refinements") {
			return moveOn({ type: choice === continueLabel ? "CONTINUE" : "REFINE" });
		}
		if (choice === "Task done") {
			actor.send({ type: "DONE" });
			return;
		}
		ctx.ui.notify(DISCUSS_HINT, "info");
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
		} else if (
			(phase() === "CHECKPOINT" || isProposingRefinement(actor.getSnapshot())) &&
			!isDiscussing(actor.getSnapshot())
		) {
			// Typing at a checkpoint or proposal is discussing it, however the user got here (Esc, resume, never chose).
			actor.send({ type: "DISCUSS" });
			ctx.ui.notify(DISCUSS_HINT, "info");
		}
	});

	pi.on("before_agent_start", async () => {
		if (!context().task) return;
		return { message: msg() };
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
		if (isThrashing(writeCounts())) {
			return { block: true, reason: "Checkpoint required before further writes." };
		}
		if (phase() === "BUILD") {
			actor.send({ type: "WRITE", path: (event.input as { path: string }).path });
		}
	});

	pi.on("turn_end", async (event) => {
		// Refining must not change behaviour, so a failure there is a bug, not something to fix forward:
		// the reverse of BUILD, where a failure means the agent is mid-fix (see midRunCheckpoint).
		if (isApplyingRefinement(actor.getSnapshot()) && event.toolResults.some((r) => r.isError)) {
			return moveOn({ type: "CHECKPOINT" });
		}
		const { task, writesPerFile } = context();
		// A turn without tool calls is the agent finishing; agent_before_settle reviews that.
		if (phase() !== "BUILD" || !task || writesPerFile.length === 0 || event.toolResults.length === 0) return;
		const counts = writeCounts();
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
		return moveOn({ type: "CHECKPOINT" });
	});

	// Human gates: what settling means depends on the phase. DESIGN and a refinement proposal end
	// with a human gate before the agent resumes; settling mid-run lands at a checkpoint review.
	// The Decider may pass a gate deciderMayPass allows; a BUILD run that settles on its own skips
	// its gate. The checkpoint menu is offered at most once per checkpoint.
	pi.on("agent_before_settle", async (event, ctx) => {
		const { task, effort, writesPerFile } = context();
		if (event.outcome !== "completed" || !task) return;
		// A refinement started from IDLE has no effort: nothing about it was classified, so nothing auto-passes.
		const counts = writeCounts();
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

		// Turn-ending gates: each returns the continue response when approved, nothing when not.
		if (phase() === "DESIGN") return planGate(ctx, canSkip);

		// Mid-run work lands at a checkpoint, so the agent pauses for review; BUILD may end the whole
		// task instead when its finish gate auto-approves. The checkpoint menu follows either way.
		if (phase() === "REFINE" && isApplyingRefinement(actor.getSnapshot())) {
			actor.send({ type: "CHECKPOINT" });
		} else if (phase() === "BUILD") {
			if (await finishGate(ctx, canSkip)) return;
			actor.send({ type: "CHECKPOINT" });
		}

		return checkpointMenu(ctx);
	});

	// Compaction can drop the per-prompt banner; the phase itself is unaffected.
	// ponytail: compaction runs pi's default summary. Deciding what is safe to forget means returning
	// a custom CompactionResult from session_before_compact via a Decider call — the Jev-era slice.
	pi.on("session_compact", async () => {
		if (context().task) pi.sendMessage(msg());
	});

	registerCommands(pi, actor, decider);
	registerTools(pi, actor, () => lastUserText);
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function lastAssistantText(messages: AgentMessage[]): string {
	const last = messages.findLast((m) => m.role === "assistant");
	return last ? assistantText(last) : "";
}
