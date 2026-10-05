import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type ListMode = "focused" | "empty" | "pendingDelete";

export interface ListState {
  mode: ListMode;
  index?: number;
}

/**
 * Handle navigation keys for a focused list.
 * Returns new state if changed, or undefined if no change.
 */
export function handleNavigation(
  key: string,
  state: ListState,
  itemCount: number,
): ListState | undefined {
  if (state.mode !== "focused") return undefined;

  switch (key) {
    case "up":
    case "k":
      if (state.index === undefined || state.index <= 0) return undefined;
      return { mode: "focused", index: state.index - 1 };

    case "down":
    case "j":
      if (state.index === undefined || state.index >= itemCount - 1) return undefined;
      return { mode: "focused", index: state.index + 1 };

    default:
      return undefined;
  }
}

/**
 * Enter delete confirmation mode.
 */
export function enterDeleteMode(state: ListState): ListState {
  if (state.mode !== "focused" || state.index === undefined) return state;
  return { mode: "pendingDelete", index: state.index };
}

/**
 * Cancel delete confirmation, returning to focused mode.
 */
export function cancelDeleteMode(state: ListState): ListState {
  if (state.mode !== "pendingDelete") return state;
  return { mode: "focused", index: state.index };
}

/**
 * Confirm deletion and adjust index if needed.
 * Returns new state after removal.
 */
export function confirmDelete(
  state: ListState,
  newItemCount: number,
): ListState {
  if (state.mode !== "pendingDelete" || state.index === undefined) return state;

  if (newItemCount === 0) {
    return { mode: "empty" };
  }

  const newIndex = Math.min(state.index, newItemCount - 1);
  return { mode: "focused", index: newIndex };
}

/**
 * Render a numbered list item with selection indicator, check mark, and text.
 */
export function renderListItem(
  theme: Theme,
  index: number,
  selectedIndex: number | undefined,
  isDone: boolean,
  text: string,
  width: number,
): string {
  const selected = selectedIndex === index;
  const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
  const check = isDone ? theme.fg("success", "✓") : theme.fg("dim", "○");
  const num = theme.fg("accent", `#${index + 1}`);
  const displayText = isDone
    ? theme.fg("dim", theme.strikethrough(text))
    : selected
      ? theme.fg("text", text)
      : theme.fg("muted", text);

  return truncateToWidth(`${prefix}${check} ${num} ${displayText}`, width);
}

/**
 * Render a header line with title and border.
 */
export function renderHeader(
  theme: Theme,
  title: string,
  width: number,
): string {
  const titleText = theme.fg("accent", ` ${title} `);
  const leftBorder = theme.fg("borderMuted", "─".repeat(3));
  const rightWidth = Math.max(0, width - titleText.length - 3);
  const rightBorder = theme.fg("borderMuted", "─".repeat(rightWidth));
  return truncateToWidth(leftBorder + titleText + rightBorder, width);
}

/**
 * Render footer help text based on current mode.
 */
export function renderFooter(
  theme: Theme,
  mode: ListMode,
  width: number,
  customHelp?: string,
): string {
  let help: string;

  if (mode === "pendingDelete") {
    help = theme.fg("warning", "Press d again to confirm deletion · Esc cancel delete");
  } else if (customHelp) {
    help = customHelp;
  } else {
    help = theme.fg("dim", "↑↓ j/k navigate · Enter select · Space toggle · d delete · Esc exit");
  }

  return truncateToWidth(`  ${help}`, width);
}
