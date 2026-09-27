import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { registerCommands, registerTools } from "./commands.ts";
import { type Decider, RuleDecider } from "./decider.ts";
import { buildFooter } from "./footer.ts";
import { LlmDecider } from "./llm-decider.ts";
import { TodoStore } from "./todos.ts";
import {
	type PairActor,
	type PairEvent,
	type PairSnapshot,
	PairActorImpl,
	bannerMessage,
	isDiscussing,
	isReadOnly,
	isWorking,
	phaseOf,
	readOnlyTargetPhase,
	restorable,
	CHECKPOINT_TOOL,
	PROTOCOL,
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
// A judgment call that takes longer than this is worth less than the rules' instant answer.
const DECIDER_TIMEOUT_MS = 20_000;
const JUDGE_ENTRY = "pair-judge";
const DISCUSS_HINT = "Discussing. /continue moves on, /done ends the task.";
const CONFIG_FILE = "pair-programming.json";

// Session-scoped override, persisted across sessions via /judge-model
let judgeModelOverride: string | undefined;

function getPersistedJudgeModel(): string | undefined {
	try {
		const path = join(getAgentDir(), CONFIG_FILE);
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return data.judgeModel;
	} catch {
		return undefined;
	}
}

export function setPersistedJudgeModel(model: string | undefined): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = join(dir, CONFIG_FILE);
		const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
		if (model === undefined) {
			delete data.judgeModel;
		} else {
			data.judgeModel = model;
		}
		writeFileSync(path, JSON.stringify(data, null, 2));
	} catch {
		// Silent fail — persistence is best-effort
	}
}

export default function pairProgrammer(pi: ExtensionAPI) {
	const actor: PairActor = new PairActorImpl();
	const todos = new TodoStore();
	let session: ExtensionContext | undefined;
	let lastUserText = "";
	let footerRequestRender: (() => void) | undefined;

	todos.attach(pi);
	judgeModelOverride = getPersistedJudgeModel();

	pi.registerFlag("pair-rules", {
		description: "Use keyword rules instead of the LLM judge for pair-programmer judgment calls",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("pair-judge-model", {
		description: "Model for pair-programmer judgment calls (format: provider/model-id)",
		type: "string",
	});

	function resolveJudgeModel(): any {
		// Resolution order: persisted setting → CLI flag → user's current model
		const override = judgeModelOverride ?? (pi.getFlag("pair-judge-model") as string | undefined);
		if (override) {
			const [provider, modelId] = override.split("/");
			return session?.modelRegistry.find(provider, modelId);
		}
		return session?.model;
	}

	const rules = new RuleDecider();
	const decider: Decider = new LlmDecider(async (systemPrompt, user) => {
		const model = resolveJudgeModel();
		if (pi.getFlag("pair-rules") || !session || !model) throw new Error("no judge model");
		
		// Thinking off: explicit for Anthropic, implicit for others
		const options: any = {
			signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS),
			sessionId: `${session.sessionManager.getSessionId()}:pair-judge`,
		};
		if (model.api === "anthropic-messages") {
			options.thinkingEnabled = false;
		}
		
		const response = await session.modelRegistry.complete(
			model,
			{ systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			options,
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
		const managed = new Set([RESUME_TOOL, CHECKPOINT_TOOL]);
		pi.setActiveTools([
			...pi.getActiveTools().filter((t) => !managed.has(t)),
			...(isDiscussing(snapshot) ? [RESUME_TOOL] : []),
			...(isWorking(snapshot) ? [CHECKPOINT_TOOL] : []),
		]);
		// Trigger footer re-render to reflect phase change
		footerRequestRender?.();
	}

	function bannerEntry(): SessionBoundaryDraft {
		return { type: "custom_message", ...msg() };
	}

	function moveOn(event: PairEvent) {
		actor.send(event);
		return { entries: [bannerEntry()], continue: true };
	}

	/** True when the finish gate auto-ended the task, so settling stops here rather than checkpointing. */
	async function finishGate(ctx: ExtensionContext, canFinish: () => Promise<boolean>): Promise<boolean> {
		if (!(await canFinish())) return false;
		ctx.ui.notify("Task auto-finished", "info");
		actor.send({ type: "DONE" });
		return true;
	}

	// Offered once per checkpoint; typing moves to discuss (see the input hook), after which the
	// selector stays away so the conversation can run; /continue and /done leave.
	async function checkpointMenu(ctx: ExtensionContext) {
		if (phase() !== "CHECKPOINT" || isDiscussing(actor.getSnapshot()) || !ctx.hasUI) return;
		const options = ["Discuss"];
		if (context().refining) {
			options.push("Continue refining", "Continue building");
		} else {
			options.push("Continue building");
		}
		options.push("Propose refinements", "Task done");
		const choice = await ctx.ui.select("Checkpoint review", options);
		switch (choice) {
			case "Continue refining":
				return moveOn({ type: "CONTINUE" });
			case "Continue building":
				return moveOn({ type: "RESUME_BUILD" });
			case "Propose refinements":
				return moveOn({ type: "REFINE" });
			case "Task done":
				actor.send({ type: "DONE" });
				return;
		}
		ctx.ui.notify(DISCUSS_HINT, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		session = ctx;
		todos.load(ctx);
		const saved = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === STATE_ENTRY)
			.pop() as { data?: PairSnapshot } | undefined;
		actor.reset(restorable(saved?.data));
		let lastMode: string | undefined;
		actor.subscribe((snapshot) => {
			pi.appendEntry(STATE_ENTRY, actor.getPersistedSnapshot());
			const mode = JSON.stringify(snapshot.value);
			if (mode === lastMode) return;
			lastMode = mode;
			applyPhase(snapshot);
		});
		actor.start();

		// Install custom footer
		const { factory, requestRender } = buildFooter(actor, todos, ctx);
		footerRequestRender = requestRender;
		ctx.ui.setFooter(factory);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.startsWith("/")) return;
		lastUserText = event.text;
		if (phase() === "IDLE") {
			actor.send({ type: "TASK", task: event.text, effort: await decider.classifyEffort(event.text) });
		} else if (actor.getSnapshot().can({ type: "DISCUSS" })) {
			// Typing at a review is discussing it, however the user got here (Esc, resume, never chose).
			actor.send({ type: "DISCUSS" });
			ctx.ui.notify(DISCUSS_HINT, "info");
		}
	});

	// PROTOCOL goes in whether or not there is a task: toggling it would change the system prompt,
	// and so the cached prefix of the whole conversation, at every task boundary.
	pi.on("before_agent_start", async (event) => {
		const systemPrompt = `${event.systemPrompt}\n\n${PROTOCOL}`;
		return context().task ? { message: msg(), systemPrompt } : { systemPrompt };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (isReadOnly(actor.getSnapshot()) && isMutating(command)) {
				const target = readOnlyTargetPhase(actor.getSnapshot());
				return { block: true, reason: `${phase()} phase is read-only. Call ${RESUME_TOOL} to propose moving to ${target}.` };
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
		if (isReadOnly(actor.getSnapshot())) {
			const target = readOnlyTargetPhase(actor.getSnapshot());
			return { block: true, reason: `${phase()} phase is read-only. Call ${RESUME_TOOL} to propose moving to ${target}.` };
		}
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
		if (phase() === "REFINE" && event.toolResults.some((r) => r.isError)) {
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
				lastAssistantText: text,
			}))
		) {
			return;
		}
		return moveOn({ type: "CHECKPOINT" });
	});

	// Human gates: what settling means depends on the phase. DESIGN and a refinement proposal just
	// wait; the agent leaves them through resume_work, which the user confirms. Settling mid-run lands
	// at a checkpoint review, unless the Decider may auto-finish a BUILD run that settled on its own.
	// The checkpoint menu is offered at most once per checkpoint.
	pi.on("agent_before_settle", async (event, ctx) => {
		const { task, effort } = context();
		if (event.outcome !== "completed" || !task) return;
		// A refinement started from IDLE has no effort: nothing about it was classified, so nothing auto-passes.
		const counts = writeCounts();
		const canFinish = async () =>
			effort !== undefined &&
			deciderMayPass(effort, counts) &&
			(await decider.canSkipReview({
				task,
				effort,
				filesTouched: counts.size,
				lastAssistantText: lastAssistantText(event.context.contextMessages),
			}));

		// Mid-run work lands at a checkpoint, so the agent pauses for review; BUILD may end the whole
		// task instead when its finish gate auto-approves. The checkpoint menu follows either way.
		if (phase() === "REFINE") {
			actor.send({ type: "CHECKPOINT" });
		} else if (phase() === "BUILD") {
			if (await finishGate(ctx, canFinish)) return;
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

	registerCommands(pi, actor, decider, todos, () => session, () => judgeModelOverride, (v) => { judgeModelOverride = v; });
	registerTools(pi, actor, todos, () => lastUserText);
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function lastAssistantText(messages: AgentMessage[]): string {
	const last = messages.findLast((m) => m.role === "assistant");
	return last ? assistantText(last) : "";
}
