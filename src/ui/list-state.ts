import { matchesKey } from "@earendil-works/pi-tui";

export type ListState =
  | { mode: "focused"; index: number }
  | { mode: "empty" }
  | { mode: "pendingDelete"; index: number };

export function normalizeKey(data: string): string {
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "ctrl+c")) return "ctrl+c";
  if (matchesKey(data, "return")) return "return";
  if (matchesKey(data, "up")) return "up";
  if (matchesKey(data, "down")) return "down";
  if (matchesKey(data, "tab")) return "tab";
  return data;
}
