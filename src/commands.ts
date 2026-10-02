import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Decider } from "./judge/decider.ts";
import { setPersistedJudgeModel } from "./judge/config.ts";
import {
  type PairActor,
  bannerMessage,
  phaseOf,
} from "./machine.ts";
import type { DecisionStore } from "./decisions/store.ts";
import type { TodoStore } from "./todos/store.ts";
import { type TodoAction, TodoListComponent } from "./todos/list.ts";
import { type DecisionAction, DecisionListComponent } from "./decisions/list.ts";

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
