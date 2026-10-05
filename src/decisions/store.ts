
import { SessionStore } from "../store/session-store.ts";

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
export class DecisionStore extends SessionStore<DecisionState> {
  constructor() {
    super(DECISIONS_ENTRY, () => ({ decisions: [] }));
  }

  add(decision: string, alternatives: string[], maker: DecisionMaker): Decision {
    const { state, added } = addDecision(this.getState(), decision, alternatives, maker);
    this.setState(state);
    return added;
  }

  remove(id: string): Decision | undefined {
    const { state, removed } = removeDecision(this.getState(), id);
    this.setState(state);
    return removed;
  }

  toggleAddressed(id: string): Decision | undefined {
    const { state, toggled } = toggleAddressed(this.getState(), id);
    this.setState(state);
    return toggled;
  }

  count(): number {
    return this.getState().decisions.length;
  }

  unaddressedCount(): number {
    return this.getState().decisions.filter((d) => !d.addressed).length;
  }
}
