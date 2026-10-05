import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { normalizeKey } from "../ui/list-state.ts";
import {
  type ListState,
  handleNavigation,
  enterDeleteMode,
  cancelDeleteMode,
  confirmDelete,
  renderListItem,
  renderHeader,
  renderFooter,
} from "../ui/list-utils.ts";
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
            const selected = filteredDecisions[this.listState.index!];
            if (selected) {
              this.onDone({
                action: "select",
                decision: selected,
                id: selected.id,
              });
            }
            break;
          }
          case " ": {
            const decision = filteredDecisions[this.listState.index!];
            if (decision) {
              this.decisions.toggleAddressed(decision.id);
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          }
          case "d":
            this.listState = enterDeleteMode(this.listState);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "tab":
            this.cycleFilterMode();
            break;
          default: {
            const newState = handleNavigation(key, this.listState, filteredDecisions.length);
            if (newState) {
              this.listState = newState;
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          }
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
            this.listState = cancelDeleteMode(this.listState);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "d": {
            const decision = filteredDecisions[this.listState.index!];
            if (decision) {
              this.decisions.remove(decision.id);
              const newFilteredDecisions = this.getFilteredDecisions();
              this.listState = confirmDelete(this.listState, newFilteredDecisions.length);
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
    lines.push(renderHeader(th, `Decisions (${this.filterMode})`, width));
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

      const selectedIndex =
        this.listState.mode === "focused" || this.listState.mode === "pendingDelete"
          ? this.listState.index
          : undefined;

      for (const [i, decision] of filteredDecisions.entries()) {
        lines.push(renderListItem(th, i, selectedIndex, decision.addressed, decision.decision, width));

        // Show alternatives only when selected and not addressed
        if (selectedIndex === i && !decision.addressed && decision.alternatives.length > 0) {
          const altsText = decision.alternatives.join(", ");
          lines.push(
            truncateToWidth(`       ${th.fg("dim", `alternatives: ${altsText}`)}`, width),
          );
        }
      }
    }

    lines.push("");
    const customHelp =
      this.listState.mode === "focused"
        ? th.fg("dim", "↑↓ j/k navigate · Enter revisit · Space toggle addressed · d delete · Tab switch view · Esc exit")
        : undefined;
    lines.push(renderFooter(th, this.listState.mode, width, customHelp));
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
