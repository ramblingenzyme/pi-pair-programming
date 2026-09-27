import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { LlmDecider } from "./llm-decider.ts";
import { type Decider, RuleDecider } from "./decider.ts";

const CONFIG_FILE = "pair-programming.json";
const JUDGE_ENTRY = "pair-judge";
// A judgment call that takes longer than this is worth less than the rules' instant answer.
const DECIDER_TIMEOUT_MS = 20_000;

// Session-scoped override, persisted across sessions via /judge-model
let judgeModelOverride: string | undefined;

export function getPersistedJudgeModel(): string | undefined {
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

export function getJudgeModelOverride(): string | undefined {
  return judgeModelOverride;
}

export function setJudgeModelOverride(v: string | undefined): void {
  judgeModelOverride = v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDecider(
  pi: ExtensionAPI,
  resolveModel: () => any,
  getSession: () => ExtensionContext | undefined,
): Decider {
  const rules = new RuleDecider();
  return new LlmDecider(
    async (systemPrompt, user) => {
      const model = resolveModel();
      const session = getSession();
      if (pi.getFlag("pair-rules") || !session || !model) throw new Error("no judge model");

      // Thinking off: explicit for Anthropic, implicit for others
      const options: Record<string, unknown> = {
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
    },
    rules,
    (trace) => pi.appendEntry(JUDGE_ENTRY, trace),
  );
}
