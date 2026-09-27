// Hard deterministic rules. These run before any Decider and their verdicts are final;
// the Decider only ever sees the cases these leave open.

export type Phase = "IDLE" | "DESIGN" | "BUILD" | "CHECKPOINT" | "PROPOSE" | "REFINE";
export type Effort = "trivial" | "standard" | "complex";

export const WRITE_TOOLS = new Set(["edit", "write"]);

// Same file touched this many times since the last checkpoint means the agent is flailing, not iterating.
export const THRASH_LIMIT = 4;

const DESTRUCTIVE = [
	/\brm\s+(-\w*[rf]\w*|--recursive|--force)/i,
	/\bsudo\b/i,
	/\bgit\s+(push\s+.*(-f\b|--force)|reset\s+--hard|clean\s+-\w*f|checkout\s+--\s)/i,
	/\b(drop|truncate)\s+(table|database)\b/i,
	/\bdd\b.*\bof=/i,
	/\bmkfs\b/i,
	/\b(chmod|chown)\b.*\b777\b/i,
];

// Anything that can mutate the filesystem or the world. DESIGN and CHECKPOINT are read-only phases.
const MUTATING = [
	...DESTRUCTIVE,
	/\b(rm|rmdir|mv|cp|mkdir|touch|ln|tee|truncate|shred|chmod|chown)\b/i,
	/(^|[^<>&0-9])>(?!&)|>>/,
	/\bsed\s+(-\w*i|--in-place)/i,
	/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|ci|publish|link)\b/i,
	/\bpip3?\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|apply)\b/i,
];

export function isDestructive(command: string): boolean {
	return DESTRUCTIVE.some((p) => p.test(command));
}

export function isMutating(command: string): boolean {
	return MUTATING.some((p) => p.test(command));
}

export function isThrashing(writesPerFile: Map<string, number>): string | undefined {
	for (const [path, count] of writesPerFile) {
		if (count >= THRASH_LIMIT) return path;
	}
	return undefined;
}

// Mid-run checkpoint order: thrashing always stops the agent; a failed tool result means it is mid-fix,
// and stopping there only interrupts the fix (thrashing already bounds a fix that spirals).
export function midRunCheckpoint(thrashing: boolean, toolFailed: boolean): "force" | "defer" | "ask-decider" {
	if (thrashing) return "force";
	if (toolFailed) return "defer";
	return "ask-decider";
}

// Whether the Decider may auto-finish a task at all; anything else always goes to a person. Only a
// trivial task's result qualifies, and never one that hit the thrash limit. Plans are never
// auto-approved: approving one is the user's confirm of the agent's resume_work call.
export function deciderMayPass(effort: Effort, writesPerFile: Map<string, number>): boolean {
	return effort === "trivial" && isThrashing(writesPerFile) === undefined;
}
