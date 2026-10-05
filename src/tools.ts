import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type PairActor,
  banner,
  isDiscussing,
  isReview,
  isWorking,
  phaseOf,
} from "./machine.ts";
import type { DecisionStore } from "./decisions/store.ts";

export function registerTools(
  pi: ExtensionAPI,
  actor: PairActor,
  decisions: DecisionStore,
  lastUserText: () => string,
): void {
  const context = () => actor.getSnapshot().context;
  const bannerText = () => banner(actor.getSnapshot(), decisions.getState().decisions);

  // Two phase-specific tools, both always present (stable for prompt caching).
  // `propose`: in discussion phases, propose moving on (user confirms).
  // `checkpoint`: in working phases, request a checkpoint for review.
  pi.registerTool({
    name: "propose",
    label: "Propose moving on",
    description:
      "In discussion phases (DESIGN, CHECKPOINT — DISCUSSION, PROPOSE — DISCUSSION), propose moving on. The user confirms.",
    parameters: Type.Object({
      reason: Type.String({ description: "What you're proposing" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = actor.getSnapshot();
      const phase = phaseOf(snapshot);

      if (!isDiscussing(snapshot)) {
        if (phase === "VIBE" || phase === "IDLE") {
          throw new Error("No phase to propose from.");
        }
        if (isReview(snapshot)) {
          throw new Error(
            "Wait for the user to respond before proposing. Summarize and stop.",
          );
        }
        throw new Error(`Cannot propose in ${phase} phase.`);
      }

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
    },
  });

  pi.registerTool({
    name: "checkpoint",
    label: "Request checkpoint",
    description:
      "In working phases (BUILD, REFINE), request a checkpoint for review. The agent stops and summarizes for the user.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why you're requesting a checkpoint" }),
    }),
    async execute(_toolCallId, _params) {
      const snapshot = actor.getSnapshot();
      const phase = phaseOf(snapshot);

      if (!isWorking(snapshot)) {
        if (phase === "VIBE" || phase === "IDLE") {
          throw new Error("No phase to checkpoint from.");
        }
        throw new Error(`Cannot checkpoint in ${phase} phase.`);
      }

      actor.send({ type: "CHECKPOINT" });
      return { content: [{ type: "text", text: bannerText() }], details: undefined };
    },
  });

  pi.registerTool({
    name: "record_decision",
    label: "Record decision",
    description:
      "Record decisions whenever they're made. Specify who made the decision (you or the user).",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision made" }),
      alternatives: Type.Array(Type.String(), {
        description: "Alternatives considered",
      }),
      maker: Type.Union([Type.Literal("user"), Type.Literal("agent")], {
        description: "Who made this decision: 'user' or 'agent'",
      }),
    }),
    async execute(_toolCallId, params) {
      const added = decisions.add(params.decision, params.alternatives, params.maker);
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
