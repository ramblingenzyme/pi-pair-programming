import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DECISIONS_ENTRY = "pair-decisions";

export type DecisionMaker = "user" | "agent";

export interface Decision {
  id: string;
  decision: string;
  alternatives: string[];
  maker: DecisionMaker;
  timestamp: number;
  addressed: boolean;
}

export interface DecisionState {
  decisions: Decision[];
}

const empty: DecisionState = { decisions: [] };

/**
 * Reconstruct decision state from the last pair-decisions entry on the current branch.
 * Branch-aware: branching gives the correct state for that point in history.
 */
export function reconstructState(ctx: ExtensionContext): DecisionState {
  for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
    const entry = ctx.sessionManager.getBranch()[i];
    if (entry.type === "custom" && entry.customType === DECISIONS_ENTRY) {
      const data = (entry as { data?: DecisionState }).data;
      if (data) return data;
    }
  }
  return { ...empty, decisions: [] };
}

export function addDecision(
  state: DecisionState,
  decision: string,
  alternatives: string[],
  maker: DecisionMaker,
): { state: DecisionState; added: Decision } {
  const newDecision: Decision = {
    id: crypto.randomUUID(),
    decision,
    alternatives,
    maker,
    timestamp: Date.now(),
    addressed: false,
  };
  return {
    state: { decisions: [...state.decisions, newDecision] },
    added: newDecision,
  };
}

export function toggleAddressed(
  state: DecisionState,
  id: string,
): { state: DecisionState; toggled: Decision | undefined } {
  const decision = state.decisions.find((d) => d.id === id);
  if (!decision) return { state, toggled: undefined };
  const updated = state.decisions.map((d) =>
    d.id === id ? { ...d, addressed: !d.addressed } : d,
  );
  return {
    state: { ...state, decisions: updated },
    toggled: { ...decision, addressed: !decision.addressed },
  };
}

export function removeDecision(
  state: DecisionState,
  id: string,
): { state: DecisionState; removed: Decision | undefined } {
  const decision = state.decisions.find((d) => d.id === id);
  if (!decision) return { state, removed: undefined };
  return {
    state: { ...state, decisions: state.decisions.filter((d) => d.id !== id) },
    removed: decision,
  };
}

/**
 * Manages decision state with session persistence.
 * Reconstructs from session on start, persists after every change.
 */
export class DecisionStore {
  private state: DecisionState = { decisions: [] };
  private pi: ExtensionAPI | undefined;

  load(ctx: ExtensionContext): void {
    this.state = reconstructState(ctx);
  }

  attach(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  getState(): DecisionState {
    return this.state;
  }

  add(decision: string, alternatives: string[], maker: DecisionMaker): Decision {
    const { state, added } = addDecision(this.state, decision, alternatives, maker);
    this.state = state;
    this.persist();
    return added;
  }

  remove(id: string): Decision | undefined {
    const { state, removed } = removeDecision(this.state, id);
    this.state = state;
    this.persist();
    return removed;
  }

  toggleAddressed(id: string): Decision | undefined {
    const { state, toggled } = toggleAddressed(this.state, id);
    this.state = state;
    this.persist();
    return toggled;
  }

  clear(): void {
    this.state = { decisions: [] };
    this.persist();
  }

  count(): number {
    return this.state.decisions.length;
  }

  unaddressedCount(): number {
    return this.state.decisions.filter((d) => !d.addressed).length;
  }

  private persist(): void {
    this.pi?.appendEntry(DECISIONS_ENTRY, this.state);
  }
}
