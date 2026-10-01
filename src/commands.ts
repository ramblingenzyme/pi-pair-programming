import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
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
} from "./machine.ts";
import type { Decision, DecisionStore } from "./decisions.ts";
import type { TodoStore } from "./todos.ts";

type TodoAction = { action: "select"; text: string } | { action: "add" } | { action: "cancel" };
type DecisionAction =
  | { action: "select"; decision: Decision; index: number }
  | { action: "cancel" };

type ListState =
  | { mode: "focused"; index: number }
  | { mode: "empty" }
  | { mode: "pendingDelete"; index: number };

class TodoListComponent {
  private todos: TodoStore;
  private theme: Theme;
  private tui: TUI;
  private onDone: (result: TodoAction) => void;
  private listState: ListState;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(todos: TodoStore, theme: Theme, tui: TUI, onDone: (result: TodoAction) => void) {
    this.todos = todos;
    this.theme = theme;
    this.tui = tui;
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
            this.onDone({ action: "cancel" });
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
              this.tui.requestRender();
            }
            break;
          case "down":
          case "j":
            if (this.listState.index < state.todos.length - 1) {
              this.listState = { mode: "focused", index: this.listState.index + 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case " ":
            this.todos.toggle(this.listState.index);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "a":
            this.onDone({ action: "add" });
            break;
          case "d":
            this.listState = { mode: "pendingDelete", index: this.listState.index };
            this.cachedLines = undefined;
            this.tui.requestRender();
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
            this.tui.requestRender();
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
            this.tui.requestRender();
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
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (state.todos.length === 0) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No todos yet. Use /todo <text> to add one.")}`, width),
      );
    } else {
      const done = state.todos.filter((t) => t.done).length;
      const total = state.todos.length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
      lines.push("");

      for (const [i, todo] of state.todos.entries()) {
        const selected =
          (this.listState.mode === "focused" || this.listState.mode === "pendingDelete") &&
          i === this.listState.index;
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
      lines.push(
        truncateToWidth(
          `  ${th.fg("warning", "Press d again to confirm deletion · Esc cancel delete")}`,
          width,
        ),
      );
    } else if (this.listState.mode === "focused") {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc unselect")}`,
          width,
        ),
      );
    } else {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc exit")}`,
          width,
        ),
      );
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

class DecisionListComponent {
  private decisions: DecisionStore;
  private theme: Theme;
  private tui: TUI;
  private onDone: (result: DecisionAction) => void;
  private listState: ListState;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(decisions: DecisionStore, theme: Theme, tui: TUI, onDone: (result: DecisionAction) => void) {
    this.decisions = decisions;
    this.theme = theme;
    this.tui = tui;
    this.onDone = onDone;
    const state = decisions.getState();
    this.listState = state.decisions.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
  }

  handleInput(data: string): void {
    const key = this.normalizeKey(data);
    const state = this.decisions.getState();

    switch (this.listState.mode) {
      case "focused": {
        switch (key) {
          case "escape":
          case "ctrl+c":
            this.onDone({ action: "cancel" });
            break;
          case "return": {
            const selected = state.decisions[this.listState.index];
            if (selected) {
              this.onDone({
                action: "select",
                decision: selected,
                index: this.listState.index,
              });
            }
            break;
          }
          case "up":
          case "k":
            if (this.listState.index > 0) {
              this.listState = { mode: "focused", index: this.listState.index - 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case "down":
          case "j":
            if (this.listState.index < state.decisions.length - 1) {
              this.listState = { mode: "focused", index: this.listState.index + 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case " ":
            this.decisions.toggleAddressed(this.listState.index);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "d":
            this.listState = { mode: "pendingDelete", index: this.listState.index };
            this.cachedLines = undefined;
            this.tui.requestRender();
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
        }
        break;
      }
      case "pendingDelete": {
        switch (key) {
          case "escape":
          case "ctrl+c":
            this.listState = { mode: "focused", index: this.listState.index };
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "d":
            this.decisions.remove(this.listState.index);
            const newState = this.decisions.getState();
            if (newState.decisions.length === 0) {
              this.listState = { mode: "empty" };
            } else {
              const newIndex = Math.min(this.listState.index, newState.decisions.length - 1);
              this.listState = { mode: "focused", index: newIndex };
            }
            this.cachedLines = undefined;
            this.tui.requestRender();
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
    const state = this.decisions.getState();

    lines.push("");
    const title = th.fg("accent", " Decisions ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 13)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (state.decisions.length === 0) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No decisions recorded yet.")}`, width),
      );
    } else {
      const unaddressed = state.decisions.filter((d) => !d.addressed).length;
      const total = state.decisions.length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${unaddressed}/${total} addressed`)}`, width));
      lines.push("");

      for (const [i, decision] of state.decisions.entries()) {
        const selected =
          (this.listState.mode === "focused" || this.listState.mode === "pendingDelete") &&
          i === this.listState.index;
        const prefix = selected ? th.fg("accent", "▸ ") : "  ";
        const check = decision.addressed ? th.fg("success", "✓") : th.fg("dim", "○");
        const num = th.fg("accent", `#${i + 1}`);
        const text = decision.addressed
          ? th.fg("dim", th.strikethrough(decision.decision))
          : selected
            ? th.fg("text", decision.decision)
            : th.fg("muted", decision.decision);
        lines.push(truncateToWidth(`${prefix}${check} ${num} ${text}`, width));

        // Show alternatives only when selected and not addressed
        if (selected && !decision.addressed && decision.alternatives.length > 0) {
          const altsText = decision.alternatives.join(", ");
          lines.push(
            truncateToWidth(`       ${th.fg("dim", `alternatives: ${altsText}`)}`, width),
          );
        }
      }
    }

    lines.push("");
    if (this.listState.mode === "pendingDelete") {
      lines.push(
        truncateToWidth(
          `  ${th.fg("warning", "Press d again to confirm deletion · Esc cancel delete")}`,
          width,
        ),
      );
    } else if (this.listState.mode === "focused") {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Esc exit")}`,
          width,
        ),
      );
    } else {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Esc exit")}`,
          width,
        ),
      );
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
  decisions: DecisionStore,
  session: () => ExtensionContext | undefined,
  getJudgeModelOverride: () => string | undefined,
  setJudgeModelOverride: (v: string | undefined) => void,
): void {
  const phase = () => phaseOf(actor.getSnapshot());
  const context = () => actor.getSnapshot().context;

  // Abort any running agent turn so a command-triggered new turn doesn't bleed into it.
  async function abortRunningTurn(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }
  }

  // Routes a command that is valid in IDLE (with a task) or at a CHECKPOINT (without one),
  // and notifies the user when called in any other phase.
  async function idleOrCheckpoint(
    ctx: ExtensionCommandContext,
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
      ctx.ui.notify(
        `${errorPrefix} starts between tasks or at a checkpoint, not during ${current}`,
        "info",
      );
      return;
    }
    await abortRunningTurn(ctx);
    pi.sendMessage(bannerMessage(actor.getSnapshot(), decisions.getState().decisions), { triggerTurn: true });
  }

  pi.registerCommand("phase", {
    description: "Show the pair-programmer phase and task",
    handler: async (_args, ctx) => {
      const { effort, task } = context();
      ctx.ui.notify(`${phase()} · effort ${effort ?? "-"} · task ${task ?? "(none)"}`, "info");
    },
  });

  pi.registerCommand("continue", {
    description:
      "Move on: approve the plan in DESIGN, leave a checkpoint to resume work, or agree a refinement proposal",
    handler: async (_args, ctx) => {
      if (!actor.getSnapshot().can({ type: "CONTINUE" })) {
        ctx.ui.notify(`Nothing to continue: phase is ${phase()}`, "info");
        return;
      }
      await abortRunningTurn(ctx);
      actor.send({ type: "CONTINUE" });
      pi.sendMessage(bannerMessage(actor.getSnapshot(), decisions.getState().decisions), { triggerTurn: true });
    },
  });

  pi.registerCommand("design", {
    description:
      "Think it through before building: between tasks, /design <task>; or at a checkpoint to rethink",
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
    description:
      "Propose refinements: between tasks, /refine <what to look at>; or at a checkpoint",
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
      await abortRunningTurn(ctx);
      actor.send({ type: "DONE" });
    },
  });

  pi.registerCommand("vibe", {
    description: "Toggle vibe mode: no phase enforcement, work directly with the user",
    handler: async (_args, ctx) => {
      const snapshot = actor.getSnapshot();
      const isVibe = phaseOf(snapshot) === "VIBE";
      await abortRunningTurn(ctx);
      actor.send({ type: isVibe ? "VIBE_OFF" : "VIBE_ON" });
      ctx.ui.notify(isVibe ? "Vibe mode off" : "Vibe mode on", "info");
      pi.sendMessage(bannerMessage(actor.getSnapshot()), { triggerTurn: true });
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

  pi.registerCommand("decisions", {
    description: "View recorded decisions: /decisions to view, /decisions clear to clear",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "clear") {
        decisions.clear();
        ctx.ui.notify("Decisions cleared", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/decisions requires interactive mode to view the list", "error");
        return;
      }
      await showDecisionList(ctx);
    },
  });

  async function showDecisionList(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const result = await ctx.ui.custom<DecisionAction>((tui, theme, _kb, done) => {
        return new DecisionListComponent(decisions, theme, tui, (action) => done(action));
      });
      if (result.action === "cancel") return;
      if (result.action === "select") {
        const d = result.decision;
        const alts =
          d.alternatives.length > 0
            ? ` Alternatives considered: ${d.alternatives.join(", ")}.`
            : "";
        const prompt = `Walk me through decision #${result.index + 1}: ${d.decision}.${alts} Explain the reasoning so I can decide whether this still holds.`;
        pi.sendUserMessage(prompt);
        return;
      }
    }
  }

  async function showTodoList(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const result = await ctx.ui.custom<TodoAction>((tui, theme, _kb, done) => {
        return new TodoListComponent(todos, theme, tui, (action) => done(action));
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
        const current =
          getJudgeModelOverride() ?? (pi.getFlag("pair-judge-model") as string | undefined);

        // Build menu with current first
        const options: string[] = [];
        if (current === undefined) {
          options.push("✓ Default (session model)");
          options.push(...models);
        } else {
          options.push(`✓ ${current}`);
          options.push("Default (session model)");
          options.push(...models.filter((m) => m !== current));
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
  decisions: DecisionStore,
  lastUserText: () => string,
): void {
  const context = () => actor.getSnapshot().context;
  const bannerText = () => banner(actor.getSnapshot(), decisions.getState().decisions);

  // Unified yield tool: in discussion phases, propose moving on (user confirms); in working phases, request checkpoint.
  pi.registerTool({
    name: "yield",
    label: "Yield to user",
    description:
      "Yield to the user based on your current state. In discussion phases, propose moving on (user confirms). In working phases, request a checkpoint for review.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why you're yielding" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = actor.getSnapshot();
      const phase = phaseOf(snapshot);

      if (phase === "VIBE" || phase === "IDLE") {
        throw new Error("No phase to yield from.");
      }

      if (isDiscussing(snapshot)) {
        // Discussion phase: prompt user, send CONTINUE
        const designing = phase === "DESIGN";
        if (!ctx.hasUI) throw new Error("No one can confirm here; stay where you are.");
        const proposing = phase === "PROPOSE";
        const confirmed = await ctx.ui.confirm(
          designing
            ? "Build this plan?"
            : proposing
              ? "Start the agreed refinement?"
              : context().refining
                ? "Resume refining?"
                : "Resume building?",
          `You said: "${lastUserText()}"\n\nAgent's reading: ${params.reason}`,
          // Wire to the run's abort signal so a queued /continue etc. closes the dialog
          // instead of leaving waitForIdle blocked on it.
          { signal: ctx.signal },
        );
        if (!confirmed) {
          const text =
            "The user did not confirm. Stay where you are; do not propose moving on again unless they ask.";
          return { content: [{ type: "text", text }], details: undefined };
        }
        actor.send({ type: "CONTINUE" });
        return { content: [{ type: "text", text: bannerText() }], details: undefined };
      }

      if (isWorking(snapshot)) {
        // Working phase: send CHECKPOINT
        actor.send({ type: "CHECKPOINT" });
        return { content: [{ type: "text", text: bannerText() }], details: undefined };
      }

      throw new Error("Cannot yield from this state.");
    },
  });

  pi.registerTool({
    name: "record_decision",
    label: "Record decision",
    description:
      "Record autonomous decisions with real impact on the outcome — decisions you made without user discussion or approval that affect behavior, change the approach, or impact what comes next. Don't record trivial decisions or ones already discussed with the user.",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision made" }),
      alternatives: Type.Array(Type.String(), {
        description: "Alternatives considered",
      }),
    }),
    async execute(_toolCallId, params) {
      const added = decisions.add(params.decision, params.alternatives);
      const count = decisions.count();
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded decision #${count}: ${added.decision}`,
          },
        ],
        details: undefined,
      };
    },
  });
}
