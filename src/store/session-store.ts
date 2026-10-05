import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Generic session-persisted store with branch-aware state reconstruction.
 * Subclasses provide typed operations on their specific state shape.
 */
export abstract class SessionStore<T> {
  private state: T;
  private pi: ExtensionAPI | undefined;
  private readonly entryType: string;
  private readonly emptyState: () => T;

  constructor(entryType: string, emptyState: () => T) {
    this.entryType = entryType;
    this.emptyState = emptyState;
    this.state = this.emptyState();
  }

  /**
   * Reconstruct state from the last matching entry on the current branch.
   * Branch-aware: branching gives the correct state for that point in history.
   */
  protected reconstructState(ctx: ExtensionContext): T {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === this.entryType) {
        const data = (entry as { data?: T }).data;
        if (data) return data;
      }
    }
    return this.emptyState();
  }

  load(ctx: ExtensionContext): void {
    this.state = this.reconstructState(ctx);
  }

  attach(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  getState(): T {
    return this.state;
  }

  protected setState(newState: T): void {
    this.state = newState;
    this.persist();
  }

  clear(): void {
    this.setState(this.emptyState());
  }

  protected persist(): void {
    this.pi?.appendEntry(this.entryType, this.state);
  }
}
