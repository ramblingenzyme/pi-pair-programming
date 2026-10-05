import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { type ListState, normalizeKey } from "../ui/list-state.ts";
import type { Decision, DecisionStore } from "./store.ts";

export type DecisionAction =
  | { action: "select"; decision: Decision; id: string }
  | { action: "cancel" };

export class DecisionListComponent {
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
    const agentDecisions = decisions.getState().decisions.filter((d) => d.maker === "agent");
    this.listState = agentDecisions.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    const agentDecisions = this.decisions.getState().decisions.filter((d) => d.maker === "agent");

    switch (this.listState.mode) {
      case "focused": {
        switch (key) {
          case "escape":
          case "ctrl+c":
            this.onDone({ action: "cancel" });
            break;
          case "return": {
            const selected = agentDecisions[this.listState.index];
            if (selected) {
              this.onDone({
                action: "select",
                decision: selected,
                id: selected.id,
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
            if (this.listState.index < agentDecisions.length - 1) {
              this.listState = { mode: "focused", index: this.listState.index + 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case " ": {
            const decision = agentDecisions[this.listState.index];
            if (decision) {
              this.decisions.toggleAddressed(decision.id);
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          }
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
          case "d": {
            const decision = agentDecisions[this.listState.index];
            if (decision) {
              this.decisions.remove(decision.id);
              const newAgentDecisions = this.decisions.getState().decisions.filter((d) => d.maker === "agent");
              if (newAgentDecisions.length === 0) {
                this.listState = { mode: "empty" };
              } else {
                const newIndex = Math.min(this.listState.index, newAgentDecisions.length - 1);
                this.listState = { mode: "focused", index: newIndex };
              }
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          }
        }
        break;
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;
    const agentDecisions = this.decisions.getState().decisions.filter((d) => d.maker === "agent");

    lines.push("");
    const title = th.fg("accent", " Decisions ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 13)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (agentDecisions.length === 0) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No decisions recorded yet.")}`, width),
      );
    } else {
      const unaddressed = agentDecisions.filter((d) => !d.addressed).length;
      const total = agentDecisions.length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${unaddressed}/${total} addressed`)}`, width));
      lines.push("");

      for (const [i, decision] of agentDecisions.entries()) {
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
          width),
      );
    } else if (this.listState.mode === "focused") {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Esc exit")}`,
          width),
      );
    } else {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Esc exit")}`,
          width),
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
