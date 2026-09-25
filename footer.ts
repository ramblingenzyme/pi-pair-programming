import { relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
	type PairActor,
	type PairSnapshot,
	isReview,
	phaseOf,
} from "./machine.ts";

/**
 * Compress a path fish-style: abbreviate parent directories to first letter, keep last full.
 * `/home/ramb/src/pi-pair-programming` → `~/s/pi-pair-programming`
 */
function compressPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);

	if (rel.startsWith("..") || rel === "") return cwd;

	const parts = rel.split(sep);
	if (parts.length <= 1) return `~/${rel}`;

	const compressed = parts.slice(0, -1).map((p) => p[0]).join(sep);
	return `~/${compressed}/${parts[parts.length - 1]}`;
}

/**
 * Format token count compactly: 1234 → 1.2k, 1234567 → 1.2M
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Compute token stats from session entries.
 */
function computeTokenStats(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0, output = 0, cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cost += m.usage.cost.total;
		}
	}
	return { input, output, cost };
}

/**
 * Get phase color based on state.
 */
function phaseColor(snapshot: PairSnapshot): "dim" | "accent" | "warning" {
	const phase = phaseOf(snapshot);
	if (phase === "IDLE") return "dim";
	if (isReview(snapshot)) return "warning";
	return "accent";
}

/**
 * Get thinking level color.
 */
function thinkingColor(level: string): "dim" | "accent" | null {
	if (level === "off" || level === "minimal" || level === "low") return "dim";
	if (level === "high" || level === "xhigh") return "accent";
	return null; // medium uses default color
}

/**
 * Get context percentage color based on usage level.
 */
function contextColor(percent: number | null): "dim" | "warning" | "error" {
	if (percent === null) return "dim";
	if (percent > 80) return "error";
	if (percent > 50) return "warning";
	return "dim";
}

/**
 * Build the custom footer factory for ctx.ui.setFooter().
 * Takes a PairActor to access the current state.
 */
export function buildFooter(
	actor: PairActor,
	ctx: ExtensionContext,
) {
	let requestRender: (() => void) | undefined;

	const factory = (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
		requestRender = () => tui.requestRender();
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				const snapshot = actor.getSnapshot();
				const phase = phaseOf(snapshot);
				const theme = ctx.ui.theme;

				// Build left side: PHASE • path (branch)
				const phaseText = theme.fg(phaseColor(snapshot), phase);
				const compressedPath = compressPath(ctx.sessionManager.getCwd());
				const branch = footerData.getGitBranch();
				const pathText = branch ? `${compressedPath} (${branch})` : compressedPath;
				const left = `${phaseText} ${theme.fg("dim", `• ${pathText}`)}`;
				const leftWidth = visibleWidth(left);

				// Build right side: model (thinking) • $cost • context%↑input ↓output
				const model = ctx.model?.id || "no-model";
				const thinking = ctx.thinkingLevel || "off";
				const stats = computeTokenStats(ctx);
				const contextUsage = ctx.getContextUsage();
				const contextPercent = contextUsage?.percent ?? null;
				const contextText = contextPercent !== null ? `${Math.round(contextPercent)}%` : "?";
				
				// Apply colors to right side components
				const modelText = theme.fg("accent", model);
				const thinkingColorName = thinkingColor(thinking);
				const thinkingText = thinkingColorName 
					? theme.fg(thinkingColorName, `(${thinking})`)
					: `(${thinking})`;
				const costText = `$${stats.cost.toFixed(3)}`;
				const contextTextColored = theme.fg(contextColor(contextPercent), contextText);
				const tokensText = theme.fg("dim", `↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)}`);
				
				const right = `${modelText} ${thinkingText} • ${costText} • ${contextTextColored} ${tokensText}`;
				const rightWidth = visibleWidth(right);

				// Try single line first
				const minPadding = 2;
				const totalWidth = leftWidth + minPadding + rightWidth;

				if (totalWidth <= width) {
					// Single line: left + padding + right
					const padding = " ".repeat(width - leftWidth - rightWidth);
					return [truncateToWidth(left + padding + right, width)];
				}

				// Two lines: left on line 1, right on line 2
				const line1 = truncateToWidth(left, width);
				const line2 = truncateToWidth(right, width);
				return [line1, line2];
			},
		};
	};

	return {
		factory,
		requestRender: () => requestRender?.(),
	};
}
