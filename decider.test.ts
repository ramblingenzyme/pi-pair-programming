import { describe, expect, it } from "expect-native";
import { RuleDecider } from "./decider.ts";

describe("RuleDecider", () => {
	const decider = new RuleDecider();

	it("classifies effort", async () => {
		await expect(decider.classifyEffort("fix the typo in README")).resolves.toBe("trivial");
		await expect(decider.classifyEffort("add a --json flag to the export command")).resolves.toBe("standard");
		await expect(decider.classifyEffort("refactor auth across all services")).resolves.toBe("complex");
	});

	it("checkpoints once enough has changed", async () => {
		const base = { task: "t", lastAssistantText: "" };
		await expect(decider.shouldCheckpoint({ ...base, filesTouched: 2, writesSinceCheckpoint: 5 })).resolves.toBe(false);
		await expect(decider.shouldCheckpoint({ ...base, filesTouched: 3, writesSinceCheckpoint: 3 })).resolves.toBe(true);
		await expect(decider.shouldCheckpoint({ ...base, filesTouched: 1, writesSinceCheckpoint: 6 })).resolves.toBe(true);
	});

	it("auto-finishes only single-file work", async () => {
		const finish = { task: "t", lastAssistantText: "done" };
		await expect(decider.canSkipReview({ ...finish, effort: "trivial", filesTouched: 1 })).resolves.toBe(true);
		await expect(decider.canSkipReview({ ...finish, effort: "trivial", filesTouched: 2 })).resolves.toBe(false);
	});
});
