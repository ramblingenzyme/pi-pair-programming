import { describe, expect, it } from "expect-native";
import { RuleDecider } from "./decider.ts";
import { deciderMayPass, isDestructive, isMutating, isThrashing, midRunCheckpoint } from "./rules.ts";

describe("isDestructive", () => {

	for (const command of ["rm -rf build", "sudo make install", "git push -f origin main", "git reset --hard HEAD~1"]) {
		it(`catches ${command}`, () => expect(isDestructive(command)).toBe(true));
	}
	for (const command of ["ls -la", "git status", "rm file.txt", "npm test"]) {
		it(`allows ${command}`, () => expect(isDestructive(command)).toBe(false));
	}
});

describe("isMutating", () => {
	for (const command of ["cat a.ts", "grep -rn foo .", "git log --oneline", "ls 2>&1", "cmd 2>/dev/null | head"]) {
		it(`allows ${command} in read-only phases`, () => expect(isMutating(command)).toBe(false));
	}
	for (const command of ["echo x > a.ts", "sed -i s/a/b/ f", "npm install left-pad", "git commit -m x", "mv a b"]) {
		it(`blocks ${command} in read-only phases`, () => expect(isMutating(command)).toBe(true));
	}
});

describe("isThrashing", () => {
	it("fires at the limit, not before", () => {
		expect(isThrashing(new Map([["a.ts", 3]]))).toBeUndefined();
		expect(isThrashing(new Map([["a.ts", 4]]))).toBe("a.ts");
	});
});

describe("midRunCheckpoint", () => {
	it("forces on thrashing even mid-fix, defers mid-fix otherwise, else asks the Decider", () => {
		expect(midRunCheckpoint(true, true)).toBe("force");
		expect(midRunCheckpoint(false, true)).toBe("defer");
		expect(midRunCheckpoint(false, false)).toBe("ask-decider");
	});
});

describe("deciderMayPass", () => {
	const none = new Map<string, number>();

	it("lets the Decider pass only a standard plan or a trivial result", () => {
		expect(deciderMayPass("plan", "standard", none)).toBe(true);
		expect(deciderMayPass("finish", "trivial", none)).toBe(true);
		expect(deciderMayPass("finish", "standard", none)).toBe(false);
		expect(deciderMayPass("plan", "complex", none)).toBe(false);
		expect(deciderMayPass("finish", "complex", none)).toBe(false);
	});

	it("never lets the Decider pass work that hit the thrash limit", () => {
		expect(deciderMayPass("finish", "trivial", new Map([["a.ts", 4]]))).toBe(false);
	});
});

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
