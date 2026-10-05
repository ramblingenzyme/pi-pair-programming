import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { type ListState, normalizeKey } from "../ui/list-state.ts";
import type { Decision, DecisionStore } from "./store.ts";

export type DecisionAction =
  | { action: "select"; decision: Decision; id: string }
  | { action: "cancel" };

export type DecisionFilterMode = "agent" | "user" | "all";

export class DecisionListComponent {
  private decisions: DecisionStore;
  private theme: Theme;
  private tui: TUI;
  private onDone: (result: DecisionAction) => void;
  private listState: ListState;
  private filterMode: DecisionFilterMode = "agent";
  private cachedWidth?: number;
  private cachedLines?: string[];

  private getFilteredDecisions(): Decision[] {
    const allDecisions = this.decisions.getState().decisions;
    if (this.filterMode === "all") return allDecisions;
    return allDecisions.filter((d) => d.maker === this.filterMode);
  }

  private cycleFilterMode(): void {
    this.filterMode = this.filterMode === "agent" ? "user" : this.filterMode === "user" ? "all" : "agent";
    const newFilteredDecisions = this.getFilteredDecisions();
    this.listState = newFilteredDecisions.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  constructor(decisions: DecisionStore, theme: Theme, tui: TUI, onDone: (result: DecisionAction) => void) {
    this.decisions = decisions;
    this.theme = theme;
    this.tui = tui;
    this.onDone = onDone;
    const filteredDecisions = this.getFilteredDecisions();
    this.listState = filteredDecisions.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    const filteredDecisions = this.getFilteredDecisions();

    switch (this.listState.mode) {
      case "focused": {
        switch (key) {
          case "escape":
          case "ctrl+c":
            this.onDone({ action: "cancel" });
            break;
          case "return": {
            const selected = filteredDecisions[this.listState.index];
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
            if (this.listState.index < filteredDecisions.length - 1) {
              this.listState = { mode: "focused", index: this.listState.index + 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case " ": {
            const decision = filteredDecisions[this.listState.index];
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
          case "tab":
            this.cycleFilterMode();
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
          case "tab":
            this.cycleFilterMode();
            break;
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
            const decision = filteredDecisions[this.listState.index];
            if (decision) {
              this.decisions.remove(decision.id);
              const newFilteredDecisions = this.getFilteredDecisions();
              if (newFilteredDecisions.length === 0) {
                this.listState = { mode: "empty" };
              } else {
                const newIndex = Math.min(this.listState.index, newFilteredDecisions.length - 1);
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
    const filteredDecisions = this.getFilteredDecisions();

    lines.push("");
    const title = th.fg("accent", ` Decisions (${this.filterMode}) `);
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 13)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (filteredDecisions.length === 0) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No decisions recorded yet.")}`, width),
      );
    } else {
      const unaddressed = filteredDecisions.filter((d) => !d.addressed).length;
      const total = filteredDecisions.length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${unaddressed}/${total} addressed`)}`, width));
      lines.push("");

      for (const [i, decision] of filteredDecisions.entries()) {
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
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Tab switch view · Esc exit")}`,
          width),
      );
    } else {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Tab switch view · Esc exit")}`,
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
