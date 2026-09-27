import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands, registerTools } from "./src/commands.ts";
import { PairActorImpl } from "./src/machine.ts";
import { TodoStore } from "./src/todos.ts";
import {
  createDecider,
  getJudgeModelOverride,
  getPersistedJudgeModel,
  setJudgeModelOverride,
} from "./src/judge-config.ts";
import { registerSessionHooks, type HookState } from "./src/session-hooks.ts";
import { registerTurnHooks } from "./src/turn-hooks.ts";

export default function pairProgrammer(pi: ExtensionAPI) {
  const actor = new PairActorImpl();
  const todos = new TodoStore();
  const state: HookState = { lastUserText: "" };

  todos.attach(pi);
  setJudgeModelOverride(getPersistedJudgeModel());

  pi.registerFlag("pair-rules", {
    description: "Use keyword rules instead of the LLM judge for pair-programmer judgment calls",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("pair-judge-model", {
    description: "Model for pair-programmer judgment calls (format: provider/model-id)",
    type: "string",
  });

  function resolveJudgeModel(): unknown {
    const override =
      getJudgeModelOverride() ?? (pi.getFlag("pair-judge-model") as string | undefined);
    if (override) {
      const [provider, modelId] = override.split("/");
      return state.session?.modelRegistry.find(provider, modelId);
    }
    return state.session?.model;
  }

  const decider = createDecider(pi, resolveJudgeModel, () => state.session);

  registerSessionHooks(pi, actor, todos, state);
  registerTurnHooks(pi, actor, decider, state);
  registerCommands(
    pi,
    actor,
    decider,
    todos,
    () => state.session,
    getJudgeModelOverride,
    setJudgeModelOverride,
  );
  registerTools(pi, actor, todos, () => state.lastUserText);
}
