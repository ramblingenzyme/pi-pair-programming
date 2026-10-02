import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import type { Decider } from "./judge/decider.ts";
import type { DecisionStore } from "./decisions/store.ts";
import {
  type PairActor,
  type PairEvent,
  bannerMessage,
  isDiscussing,
  isReadOnly,
  phaseOf,
  readOnlyTargetPhase,
  PROTOCOL,
} from "./machine.ts";
import {
  WRITE_TOOLS,
  isDestructive,
  isMutating,
  isThrashing,
  midRunCheckpoint,
  deciderMayPass,
} from "./rules.ts";
import type { HookState } from "./session-hooks.ts";

const DISCUSS_HINT = "Discussing. /continue moves on, /done ends the task.";

export function registerTurnHooks(
  pi: ExtensionAPI,
  actor: PairActor,
  decider: Decider,
  decisions: DecisionStore,
  state: HookState,
): void {
  const phase = () => phaseOf(actor.getSnapshot());
  const context = () => actor.getSnapshot().context;
  const msg = () => bannerMessage(actor.getSnapshot(), decisions.getState().decisions);
  const writeCounts = () => new Map(context().writesPerFile);

  function bannerEntry(): SessionBoundaryDraft {
    return { type: "custom_message", ...msg() };
  }

  function moveOn(event: PairEvent) {
    actor.send(event);
    return { entries: [bannerEntry()], continue: true };
  }

  /** True when the finish gate auto-ended the task, so settling stops here rather than checkpointing. */
  async function finishGate(
    ctx: ExtensionContext,
    canFinish: () => Promise<boolean>,
  ): Promise<boolean> {
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
    const choice = await ctx.ui.select("Checkpoint review", options, { signal: ctx.signal });
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
    // Abort closes the menu without the user choosing; only a deliberate dismissal is "discussing".
    if (ctx.signal?.aborted) return;
    ctx.ui.notify(DISCUSS_HINT, "info");
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.startsWith("/")) return;
    state.lastUserText = event.text;
    if (phase() === "VIBE") return; // no auto-transitions in vibe mode
    if (phase() === "IDLE") {
      actor.send({
        type: "TASK",
        task: event.text,
        effort: await decider.classifyEffort(event.text),
      });
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

  async function proposePhaseChange(ctx: ExtensionContext, target: string): Promise<boolean> {
    if (!ctx.hasUI) return false;
    // Wired to the run's abort signal so a mid-dialog abort (e.g. a queued /continue) closes it
    // instead of leaving waitForIdle blocked on the open dialog.
    return ctx.ui.confirm(
      `Move to ${target}?`,
      `Mutating call blocked in ${phase()} phase. Move to ${target} to make changes?`,
      { signal: ctx.signal },
    );
  }

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      if (isReadOnly(actor.getSnapshot()) && isMutating(command)) {
        const target = readOnlyTargetPhase(actor.getSnapshot());
        const currentPhase = phase();
        if (!target) return { block: true, reason: `${currentPhase} phase is read-only.` };
        // A destructive call folds the phase move and the allowance into one confirm, so the
        // user isn't asked to move to a writable phase and then separately asked to allow the
        // same command. Every destructive command is mutating, so this always matches here.
        if (isDestructive(command)) {
          if (!ctx.hasUI)
            return { block: true, reason: `${currentPhase} phase is read-only.` };
          const choice = await ctx.ui.select(
            `Destructive command in ${currentPhase} phase:\n\n  ${command}\n\nMove to ${target} and allow?`,
            ["No", `Yes, move to ${target}`],
            { signal: ctx.signal },
          );
          if (choice !== `Yes, move to ${target}`)
            return { block: true, reason: `${currentPhase} phase is read-only.` };
          actor.send({ type: "CONTINUE" });
          return;
        }
        const moved = await proposePhaseChange(ctx, target);
        if (!moved) return { block: true, reason: `${currentPhase} phase is read-only.` };
        actor.send({ type: "CONTINUE" });
        return;
      }
      if (isDestructive(command)) {
        if (!ctx.hasUI)
          return { block: true, reason: "Destructive command blocked (no UI to confirm)" };
        // Wired to the run's abort signal so the dialog closes with the turn.
        const choice = await ctx.ui.select(
          `Destructive command:\n\n  ${command}\n\nAllow?`,
          ["No", "Yes"],
          { signal: ctx.signal },
        );
        if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
      }
      return;
    }

    if (!WRITE_TOOLS.has(event.toolName)) return;
    // Write tools are blocked in read-only phases via this hook.
    if (isReadOnly(actor.getSnapshot())) {
      const target = readOnlyTargetPhase(actor.getSnapshot());
      const currentPhase = phase();
      const moved = target ? await proposePhaseChange(ctx, target) : false;
      if (moved) {
        actor.send({ type: "CONTINUE" });
        // Phase moved; let the call through to the checks below
      } else {
        return { block: true, reason: `${currentPhase} phase is read-only.` };
      }
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
    if (
      phase() !== "BUILD" ||
      !task ||
      writesPerFile.length === 0 ||
      event.toolResults.length === 0
    )
      return;
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
  // wait; the agent leaves them through `propose`, which the user confirms. Settling mid-run lands
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
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function lastAssistantText(messages: AgentMessage[]): string {
  const last = messages.findLast((m) => m.role === "assistant");
  return last ? assistantText(last) : "";
}
