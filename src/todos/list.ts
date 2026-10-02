import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { type ListState, normalizeKey } from "../ui/list-state.ts";
import type { TodoStore } from "./store.ts";

export type TodoAction = { action: "select"; text: string } | { action: "add" } | { action: "cancel" };

export class TodoListComponent {
  private todos: TodoStore;
  private theme: Theme;
  private tui: TUI;
  private onDone: (result: TodoAction) => void;
  private listState: ListState;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(todos: TodoStore, theme: Theme, tui: TUI, onDone: (result: TodoAction) => void) {
    this.todos = todos;
    this.theme = theme;
    this.tui = tui;
    this.onDone = onDone;
    const state = todos.getState();
    this.listState = state.todos.length > 0 ? { mode: "focused", index: 0 } : { mode: "empty" };
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    const state = this.todos.getState();

    switch (this.listState.mode) {
      case "focused": {
        switch (key) {
          case "escape":
          case "ctrl+c":
            this.onDone({ action: "cancel" });
            break;
          case "return": {
            const selected = state.todos[this.listState.index];
            if (selected) {
              this.onDone({ action: "select", text: selected.text });
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
            if (this.listState.index < state.todos.length - 1) {
              this.listState = { mode: "focused", index: this.listState.index + 1 };
              this.cachedLines = undefined;
              this.tui.requestRender();
            }
            break;
          case " ":
            this.todos.toggle(this.listState.index);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "a":
            this.onDone({ action: "add" });
            break;
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
          case "a":
            this.onDone({ action: "add" });
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
          case "d":
            this.todos.remove(this.listState.index);
            const newState = this.todos.getState();
            if (newState.todos.length === 0) {
              this.listState = { mode: "empty" };
            } else {
              const newIndex = Math.min(this.listState.index, newState.todos.length - 1);
              this.listState = { mode: "focused", index: newIndex };
            }
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
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
    const state = this.todos.getState();

    lines.push("");
    const title = th.fg("accent", " Todos ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (state.todos.length === 0) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No todos yet. Use /todo <text> to add one.")}`, width),
      );
    } else {
      const done = state.todos.filter((t) => t.done).length;
      const total = state.todos.length;
      lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
      lines.push("");

      for (const [i, todo] of state.todos.entries()) {
        const selected =
          (this.listState.mode === "focused" || this.listState.mode === "pendingDelete") &&
          i === this.listState.index;
        const prefix = selected ? th.fg("accent", "▸ ") : "  ";
        const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
        const num = th.fg("accent", `#${i + 1}`);
        const text = todo.done
          ? th.fg("dim", th.strikethrough(todo.text))
          : selected
            ? th.fg("text", todo.text)
            : th.fg("muted", todo.text);
        lines.push(truncateToWidth(`${prefix}${check} ${num} ${text}`, width));
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
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc unselect")}`,
          width),
      );
    } else {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc exit")}`,
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
