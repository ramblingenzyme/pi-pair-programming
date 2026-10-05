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
            const selected = state.todos[this.listState.index!];
            if (selected) {
              this.onDone({ action: "select", text: selected.text });
            }
            break;
          }
          case " ":
            this.todos.toggle(this.listState.index!);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "a":
            this.onDone({ action: "add" });
            break;
          case "d":
            this.listState = enterDeleteMode(this.listState);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          default: {
            const newState = handleNavigation(key, this.listState, state.todos.length);
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
            this.listState = cancelDeleteMode(this.listState);
            this.cachedLines = undefined;
            this.tui.requestRender();
            break;
          case "d": {
            this.todos.remove(this.listState.index!);
            const newState = this.todos.getState();
            this.listState = confirmDelete(this.listState, newState.todos.length);
            this.cachedLines = undefined;
            this.tui.requestRender();
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
    const state = this.todos.getState();

    lines.push("");
    lines.push(renderHeader(th, "Todos", width));
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

      const selectedIndex =
        this.listState.mode === "focused" || this.listState.mode === "pendingDelete"
          ? this.listState.index
          : undefined;

      for (const [i, todo] of state.todos.entries()) {
        lines.push(renderListItem(th, i, selectedIndex, todo.done, todo.text, width));
      }
    }

    lines.push("");
    const customHelp =
      this.listState.mode === "focused"
        ? th.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · a add · d delete · Esc unselect")
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
