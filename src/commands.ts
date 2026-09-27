import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Decider } from "./decider.ts";
import { setPersistedJudgeModel } from "./judge-config.ts";
import {
	type PairActor,
	banner,
	bannerMessage,
	isDiscussing,
	isWorking,
	phaseOf,
	CHECKPOINT_TOOL,
	RESUME_TOOL,
} from "./machine.ts";
import type { TodoStore } from "./todos.ts";

type TodoAction =
	| { action: "select"; text: string }
	| { action: "add" }
	| { action: "cancel" };

type ListState =
	| { mode: "focused"; index: number }
	| { mode: "empty" }
	| { mode: "pendingDelete"; index: number };

class TodoListComponent {
	private todos: TodoStore;
	private theme: Theme;
	private onDone: (result: TodoAction) => void;
	private listState: ListState;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoStore, theme: Theme, onDone: (result: TodoAction) => void) {
		this.todos = todos;
		this.theme = theme;
		this.onDone = onDone;
		const state = todos.getState();
		this.listState = state.todos.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
	}

	handleInput(data: string): void {
		const key = this.normalizeKey(data);
		const state = this.todos.getState();
		
		switch (this.listState.mode) {
			case "focused": {
				switch (key) {
					case "escape":
					case "ctrl+c":
						this.onDone({ action: "cancel" })
						break;
					case "return": {
						const selected = state.todos[this.listState.index];
						if (selected) {
							this.onDone({ action: "select", text: selected.text });
						}
						break;
					}
					case "up":
					case "k":
						if (this.listState.index > 0) {
							this.listState = { mode: "focused", index: this.listState.index - 1 };
							this.cachedLines = undefined;
						}
						break;
					case "down":
					case "j":
						if (this.listState.index < state.todos.length - 1) {
							this.listState = { mode: "focused", index: this.listState.index + 1 };
							this.cachedLines = undefined;
						}
						break;
					case " ":
						this.todos.toggle(this.listState.index);
						this.cachedLines = undefined;
						break;
					case "a":
						this.onDone({ action: "add" });
						break;
					case "d":
						this.listState = { mode: "pendingDelete", index: this.listState.index };
						this.cachedLines = undefined;
						break;
				}
				break;
			}
			case "empty": {
				switch (key) {
					case "escape":
					case "ctrl+c":
						this.onDone({ action: "cancel" });
						return;
					case "a":
						this.onDone({ action: "add" });
						break;
				}
				break;
			}
			case "pendingDelete": {
				switch (key) {
					case "escape":
					case "ctrl+c":
						this.listState = { mode: "focused", index: this.listState.index };
						this.cachedLines = undefined;
						break;
					case "d":
						this.todos.remove(this.listState.index);
						const newState = this.todos.getState();
						if (newState.todos.length === 0) {
							this.listState = { mode: "empty" };
						} else {
							const newIndex = Math.min(this.listState.index, newState.todos.length - 1);
							this.listState = { mode: "focused", index: newIndex };
						}
						this.cachedLines = undefined;
						break;
				}
				break;
			}
		}
	}

	private normalizeKey(data: string): string {
		if (matchesKey(data, "escape")) return "escape";
		if (matchesKey(data, "ctrl+c")) return "ctrl+c";
		if (matchesKey(data, "return")) return "return";
		if (matchesKey(data, "up")) return "up";
		if (matchesKey(data, "down")) return "down";
		return data;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const state = this.todos.getState();

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (state.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Use /todo <text> to add one.")}`, width));
		} else {
			const done = state.todos.filter((t) => t.done).length;
			const total = state.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

			for (const [i, todo] of state.todos.entries()) {
				const selected = (this.listState.mode === "focused" || this.listState.mode === "pendingDelete") && i === this.listState.index;
				const prefix = selected ? th.fg("accent", "▸ ") : "  ";
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const num = th.fg("accent", `#${i + 1}`);
				const text = todo.done 
					? th.fg("dim", th.strikethrough(todo.text)) 
					: selected 
						? th.fg("text", todo.text) 
						: th.fg("muted", todo.text);
				lines.push(truncateToWidth(`${prefix}${check} ${num} ${text}`, width));
			}
		}

		lines.push("");
		if (this.listState.mode === "pendingDelete") {
			lines.push(truncateToWidth(`  ${th.fg("warning", "Press d again to confirm deletion · Esc cancel delete")}`, width));
		} else if (this.listState.mode === "focused") {
			lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc unselect")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc exit")}`, width));
		}
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function registerCommands(
	pi: ExtensionAPI,
	actor: PairActor,
	decider: Decider,
	todos: TodoStore,
	session: () => ExtensionContext | undefined,
	getJudgeModelOverride: () => string | undefined,
	setJudgeModelOverride: (v: string | undefined) => void,
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
		description: "Move on: approve the plan in DESIGN, leave a checkpoint to resume work, or agree a refinement proposal",
		handler: async (_args, ctx) => {
			if (!actor.getSnapshot().can({ type: "CONTINUE" })) {
				ctx.ui.notify(`Nothing to continue: phase is ${phase()}`, "info");
				return;
			}
			actor.send({ type: "CONTINUE" });
			pi.sendMessage(bannerMessage(actor.getSnapshot()), { triggerTurn: true });
		},
	});

	pi.registerCommand("design", {
		description: "Think it through before building: between tasks, /design <task>; or at a checkpoint to rethink",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (phase() === "IDLE" && !task) {
				ctx.ui.notify("Usage: /design <task>", "info");
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
				"Design",
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

	pi.registerCommand("todo", {
		description: "Add a todo or view the list: /todo <text> to add, /todo to view",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/todo requires interactive mode to view the list", "error");
					return;
				}
				await showTodoList(ctx);
				return;
			}
			const added = todos.add(text);
			const count = todos.getState().todos.length;
			ctx.ui.notify(`Added #${count}: ${added.text}`, "info");
		},
	});

	async function showTodoList(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const result = await ctx.ui.custom<TodoAction>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, (action) => done(action));
			});
			if (result.action === "cancel") return;
			if (result.action === "select") {
				const prompt = await ctx.ui.editor("Send as prompt", result.text);
				if (prompt) {
					pi.sendUserMessage(prompt);
				}
				return;
			}
			// action === "add"
			const newText = await ctx.ui.input("New todo");
			if (newText?.trim()) {
				const added = todos.add(newText.trim());
				const count = todos.getState().todos.length;
				ctx.ui.notify(`Added #${count}: ${added.text}`, "info");
			}
			// Loop back to show the updated list
		}
	}

	const formatModelList = () => {
		const s = session();
		if (!s) return [];
		return s.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
	};

	pi.registerCommand("judge-model", {
		description: "Show or set the model for pair-programmer judgment calls",
		getArgumentCompletions: (prefix) => {
			return formatModelList()
				.map((value) => ({ label: value, value }))
				.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			
			// Helper to apply a model choice
			const applyChoice = (choice: string) => {
				// Strip checkmark prefix if present
				const clean = choice.replace(/^✓ /, "");
				
				if (clean === "Default (session model)" || clean === "default") {
					setJudgeModelOverride(undefined);
					setPersistedJudgeModel(undefined);
					ctx.ui.notify("Judge model reset to default", "info");
					return true;
				}
				
				const s = session();
				const [provider, modelId] = clean.split("/");
				const model = s?.modelRegistry.find(provider, modelId);
				if (!model) {
					ctx.ui.notify(`Model not found: ${clean}`, "error");
					return false;
				}
				
				setJudgeModelOverride(clean);
				setPersistedJudgeModel(clean);
				ctx.ui.notify(`Judge model set to ${clean}`, "info");
				return true;
			};
			
			// No args → show menu
			if (!arg) {
				if (!ctx.hasUI) {
					ctx.ui.notify("No UI available. Usage: /judge-model provider/model-id", "error");
					return;
				}
				
				const models = formatModelList();
				if (models.length === 0) {
					ctx.ui.notify("No models available", "error");
					return;
				}
				
				// Determine current model
				const current = getJudgeModelOverride() ?? (pi.getFlag("pair-judge-model") as string | undefined);
				
				// Build menu with current first
				const options: string[] = [];
				if (current === undefined) {
					options.push("✓ Default (session model)");
					options.push(...models);
				} else {
					options.push(`✓ ${current}`);
					options.push("Default (session model)");
					options.push(...models.filter(m => m !== current));
				}
				
				const choice = await ctx.ui.select("Select judge model", options);
				if (!choice) return; // cancelled
				
				applyChoice(choice);
				return;
			}
			
			// Direct set or reset
			if (!arg.includes("/") && arg !== "default") {
				ctx.ui.notify("Usage: /judge-model [provider/model-id | default]", "error");
				return;
			}
			
			applyChoice(arg);
		},
	});
}

export function registerTools(
	pi: ExtensionAPI,
	actor: PairActor,
	todos: TodoStore,
	lastUserText: () => string,
): void {
	const context = () => actor.getSnapshot().context;
	const bannerText = () => banner(actor.getSnapshot());

	// The agent can only propose leaving a discussion; the user's confirm is the approval. A tool call is
	// the agent's claim that the user asked, which is self-report and can come from misreading or injection.
	pi.registerTool({
		name: RESUME_TOOL,
		label: "Resume work",
		description:
			"Propose moving on: build the plan from DESIGN, resume building or refining after a checkpoint, or start the agreed refinement. Call only when the user has asked to go on. The user must confirm.",
		parameters: Type.Object({
			reason: Type.String({ description: "What the user said that asks to go on" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isDiscussing(actor.getSnapshot())) throw new Error("Not in a discussion.");
			const designing = phaseOf(actor.getSnapshot()) === "DESIGN";
			if (!ctx.hasUI) throw new Error("No one can confirm here; stay where you are.");
			const proposing = phaseOf(actor.getSnapshot()) === "PROPOSE";
			const confirmed = await ctx.ui.confirm(
				designing
					? "Build this plan?"
					: proposing
						? "Start the agreed refinement?"
						: context().refining
							? "Resume refining?"
							: "Resume building?",
				`You said: "${lastUserText()}"\n\nAgent's reading: ${params.reason}`,
			);
			if (!confirmed) {
				const text = "The user did not confirm. Stay where you are; do not propose moving on again unless they ask.";
				return { content: [{ type: "text", text }], details: undefined };
			}
			actor.send({ type: "CONTINUE" });
			return { content: [{ type: "text", text: bannerText() }], details: undefined };
		},
	});

	// Asking for review only adds oversight, so unlike resume_work the agent's call is trusted as-is.
	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Request checkpoint",
		description:
			"Stop working and hand over for review. Call when a human should look before you continue: a refinement round is finished and verified, anything fails while refining, or building has reached a point worth reviewing.",
		parameters: Type.Object({
			reason: Type.String({ description: "Why: what is ready for review, or what failed" }),
		}),
		async execute() {
			if (!isWorking(actor.getSnapshot())) throw new Error("Not building or refining.");
			actor.send({ type: "CHECKPOINT" });
			return { content: [{ type: "text", text: bannerText() }], details: undefined };
		},
	});

}
