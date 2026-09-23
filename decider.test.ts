import { describe, expect, it } from "expect-native";
import { RuleDecider } from "./decider.ts";

describe("RuleDecider", () => {
	const decider = new RuleDecider();

	it("classifies effort", async () => {
		await expect(decider.classifyEffort("fix the typo in README")).resolves.toBe("trivial");
		await expect(decider.classifyEffort("add a --json flag to the export command")).resolves.toBe("standard");
		await expect(decider.classifyEffort("refactor auth across all services")).resolves.toBe("complex");
	});

	it("never checkpoints on self-report alone", async () => {
		const base = { task: "t", filesTouched: 1, lastAssistantText: "", selfReportedCheckpoint: true };
		await expect(decider.shouldCheckpoint({ ...base, writesSinceCheckpoint: 1 })).resolves.toBe(false);
		await expect(decider.shouldCheckpoint({ ...base, writesSinceCheckpoint: 2 })).resolves.toBe(true);
	});

	it("auto-approves only small plans", async () => {
		const plan = { gate: "plan" as const, task: "t", filesTouched: 0 };
		const small = "Plan:\n1. Add subtract to math.js\n2. Test it in math.test.js";
		const wide = "Plan:\n1. a.ts\n2. b.ts\n3. c.ts";
		await expect(decider.canSkipReview({ ...plan, effort: "standard", lastAssistantText: small })).resolves.toBe(true);
		await expect(decider.canSkipReview({ ...plan, effort: "standard", lastAssistantText: wide })).resolves.toBe(false);
	});

	it("auto-finishes only single-file work", async () => {
		const finish = { gate: "finish" as const, task: "t", lastAssistantText: "done" };
		await expect(decider.canSkipReview({ ...finish, effort: "trivial", filesTouched: 1 })).resolves.toBe(true);
		await expect(decider.canSkipReview({ ...finish, effort: "trivial", filesTouched: 2 })).resolves.toBe(false);
	});
});
