import { describe, expect, it } from "expect-native";
import { createActor } from "xstate";
import { pairMachine, type PairSnapshot } from "./machine.ts";
import { buildCompactionInstructions } from "./compaction.ts";

function snapshotAt(phase: "IDLE" | "DESIGN" | "BUILD" | "CHECKPOINT" | "PROPOSE" | "REFINE"): PairSnapshot {
	const actor = createActor(pairMachine);
	actor.start();

	switch (phase) {
		case "IDLE":
			return actor.getSnapshot();
		case "DESIGN":
			actor.send({ type: "TASK", task: "add feature", effort: "standard" });
			return actor.getSnapshot();
		case "BUILD":
			actor.send({ type: "TASK", task: "fix typo", effort: "trivial" });
			return actor.getSnapshot();
		case "CHECKPOINT":
			actor.send({ type: "TASK", task: "fix typo", effort: "trivial" });
			actor.send({ type: "WRITE", path: "src/a.ts" });
			actor.send({ type: "WRITE", path: "src/a.ts" });
			actor.send({ type: "CHECKPOINT" });
			return actor.getSnapshot();
		case "PROPOSE":
			actor.send({ type: "REFINE", task: "compress helpers" });
			return actor.getSnapshot();
		case "REFINE":
			actor.send({ type: "REFINE", task: "compress helpers" });
			actor.send({ type: "CONTINUE" });
			return actor.getSnapshot();
	}
}

describe("buildCompactionInstructions", () => {
	it("includes workflow context in every output", () => {
		const result = buildCompactionInstructions(snapshotAt("BUILD"));
		expect(result).toContain("pair-programming workflow");
		expect(result).toContain("DESIGN");
		expect(result).toContain("BUILD");
		expect(result).toContain("CHECKPOINT");
	});

	it("reports IDLE with no task", () => {
		const result = buildCompactionInstructions(snapshotAt("IDLE"));
		expect(result).toContain("IDLE with no active task");
		expect(result).not.toContain("Phase: IDLE");
	});

	it("reports phase and task for active states", () => {
		const result = buildCompactionInstructions(snapshotAt("DESIGN"));
		expect(result).toContain("Phase: DESIGN");
		expect(result).toContain("Task: add feature");
		expect(result).toContain("Effort: standard");
	});

	it("reports writes since last checkpoint", () => {
		const result = buildCompactionInstructions(snapshotAt("CHECKPOINT"));
		expect(result).toContain("Phase: CHECKPOINT");
		expect(result).toContain("src/a.ts (2)");
	});

	it("reports refining state", () => {
		const result = buildCompactionInstructions(snapshotAt("REFINE"));
		expect(result).toContain("Phase: REFINE");
		expect(result).toContain("Refining: yes");
	});

	it("appends event instructions when provided", () => {
		const result = buildCompactionInstructions(snapshotAt("BUILD"), "focus on auth changes");
		expect(result).toContain("Additional instructions: focus on auth changes");
	});

	it("omits additional instructions section when none provided", () => {
		const result = buildCompactionInstructions(snapshotAt("BUILD"));
		expect(result).not.toContain("Additional instructions");
	});
});
