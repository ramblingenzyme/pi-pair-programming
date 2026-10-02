import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildFooter } from "./footer.ts";
import { buildCompactionInstructions } from "./compaction.ts";
import {
  type PairActor,
  type PairSnapshot,
  bannerMessage,
  restorable,
} from "./machine.ts";
import type { DecisionStore } from "./decisions/store.ts";
import type { TodoStore } from "./todos/store.ts";

const STATE_ENTRY = "pair-state";

export interface HookState {
  session?: ExtensionContext;
  lastUserText: string;
  footerRequestRender?: () => void;
}

export function registerSessionHooks(
  pi: ExtensionAPI,
  actor: PairActor,
  todos: TodoStore,
  decisions: DecisionStore,
  state: HookState,
): void {
  function applyPhase(_snapshot: PairSnapshot): void {
    state.footerRequestRender?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    state.session = ctx;
    todos.load(ctx);
    decisions.load(ctx);
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

    const { factory, requestRender } = buildFooter(actor, todos, decisions, ctx);
    state.footerRequestRender = requestRender;
    ctx.ui.setFooter(factory);
  });

  // Pi's default compaction summary captures goals and progress but not the pair workflow.
  // We steer it with phase-aware custom instructions, then re-inject the banner after.
  pi.on("session_before_compact", async (event) => {
    const model = state.session?.model;
    if (!model || !state.session) throw new Error("no model for compaction");

    const auth = await state.session.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const headers = auth.headers
      ? (Object.fromEntries(Object.entries(auth.headers).filter(([, v]) => v !== null)) as Record<
          string,
          string
        >)
      : undefined;
    const instructions = buildCompactionInstructions(actor.getSnapshot(), event.customInstructions);
    return {
      compaction: await compact(
        event.preparation,
        model,
        auth.apiKey,
        headers,
        instructions,
        event.signal,
      ),
    };
  });

  pi.on("session_compact", async () => {
    if (actor.getSnapshot().context.task) pi.sendMessage(bannerMessage(actor.getSnapshot(), decisions.getState().decisions));
  });
}
