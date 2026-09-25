import { describe, expect, it } from "expect-native";
import { createActor } from "xstate";
import {
	type PairSnapshot,
	isDiscussing,
	isReadOnly,
	isWorking,
	pairMachine,
	phaseOf,
	restorable,
} from "./machine.ts";

function started() {
	const actor = createActor(pairMachine);
	actor.start();
	return actor;
}

const phase = (actor: ReturnType<typeof started>) => phaseOf(actor.getSnapshot());

describe("pairMachine", () => {
	it("routes trivial tasks straight to BUILD", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "fix typo", effort: "trivial" });
		expect(phase(actor)).toBe("BUILD");
	});

	it("routes everything else through DESIGN, which needs approval", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "add a flag", effort: "standard" });
		expect(phase(actor)).toBe("DESIGN");
		expect(isDiscussing(actor.getSnapshot())).toBe(true);
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "WRITE", path: "a.ts" });
		expect(phase(actor)).toBe("DESIGN");
		expect(actor.getSnapshot().context.writesPerFile).toEqual([]);
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("BUILD");
	});

	it("counts writes per file and resets them on CONTINUE", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "trivial" });
		actor.send({ type: "WRITE", path: "a.ts" });
		actor.send({ type: "WRITE", path: "a.ts" });
		actor.send({ type: "WRITE", path: "b.ts" });
		expect(actor.getSnapshot().context.writesPerFile).toEqual([
			["a.ts", 2],
			["b.ts", 1],
		]);
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("BUILD");
		expect(actor.getSnapshot().context.writesPerFile).toEqual([]);
	});

	it("DONE clears the task from any phase", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "complex" });
		actor.send({ type: "DONE" });
		expect(phase(actor)).toBe("IDLE");
		expect(actor.getSnapshot().context.task).toBeUndefined();
	});

	it("restores from a persisted snapshot", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "standard" });
		const restored = createActor(pairMachine, { snapshot: JSON.parse(JSON.stringify(actor.getPersistedSnapshot())) });
		restored.start();
		expect(phase(restored)).toBe("DESIGN");
		expect(restored.getSnapshot().context.task).toBe("t");
	});

	it("refuses snapshots from an older machine shape", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "trivial" });
		const current = actor.getPersistedSnapshot() as PairSnapshot;
		expect(restorable(current)).toBe(current);
		expect(restorable({ ...current, value: { session: "BUILD" } } as unknown as PairSnapshot)).toBeUndefined();
		expect(restorable(undefined)).toBeUndefined();
	});

	it("discusses inside CHECKPOINT and leaves it on CONTINUE or DONE", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "trivial" });
		actor.send({ type: "CHECKPOINT" });
		expect(isDiscussing(actor.getSnapshot())).toBe(false);
		actor.send({ type: "DISCUSS" });
		expect(phase(actor)).toBe("CHECKPOINT");
		expect(isDiscussing(actor.getSnapshot())).toBe(true);
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("BUILD");
		actor.send({ type: "CHECKPOINT" });
		expect(isDiscussing(actor.getSnapshot())).toBe(false);
		actor.send({ type: "DISCUSS" });
		actor.send({ type: "DONE" });
		expect(phase(actor)).toBe("IDLE");
	});

	it("refines by proposing read-only, then applying once agreed", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "trivial" });
		actor.send({ type: "WRITE", path: "a.ts" });
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "REFINE" });
		expect(phase(actor)).toBe("PROPOSE");
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		expect(actor.getSnapshot().context.writesPerFile).toEqual([]);
		actor.send({ type: "CHECKPOINT" });
		expect(phase(actor)).toBe("PROPOSE");
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("REFINE");
		expect(isReadOnly(actor.getSnapshot())).toBe(false);
	});

	it("continues a refinement checkpoint back into refining, and a build checkpoint into building", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "trivial" });
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "REFINE" });
		actor.send({ type: "CONTINUE" });
		actor.send({ type: "CHECKPOINT" });
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("REFINE");
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "DONE" });
		actor.send({ type: "TASK", task: "u", effort: "trivial" });
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("BUILD");
	});

	it("treats DESIGN and CHECKPOINT as read-only, BUILD and REFINE as working", () => {
		const actor = started();
		actor.send({ type: "TASK", task: "t", effort: "standard" });
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		expect(isWorking(actor.getSnapshot())).toBe(false);
		actor.send({ type: "CONTINUE" });
		expect(isReadOnly(actor.getSnapshot())).toBe(false);
		expect(isWorking(actor.getSnapshot())).toBe(true);
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "DISCUSS" });
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		expect(isWorking(actor.getSnapshot())).toBe(false);
		actor.send({ type: "REFINE" });
		actor.send({ type: "CONTINUE" });
		expect(isWorking(actor.getSnapshot())).toBe(true);
	});

	it("starts a refinement task straight from IDLE, without an effort", () => {
		const actor = started();
		actor.send({ type: "REFINE", task: "the store and formatter" });
		expect(phase(actor)).toBe("PROPOSE");
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		expect(actor.getSnapshot().context).toMatchObject({ task: "the store and formatter", refining: true });
		expect(actor.getSnapshot().context.effort).toBeUndefined();
		actor.send({ type: "CONTINUE" });
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "DONE" });
		expect(phase(actor)).toBe("IDLE");
	});

	it("plans first on PLAN, even for trivial work, and re-plans from a checkpoint", () => {
		const actor = started();
		actor.send({ type: "PLAN", task: "fix typo", effort: "trivial" });
		expect(phase(actor)).toBe("DESIGN");
		expect(actor.getSnapshot().context).toMatchObject({ task: "fix typo", effort: "trivial" });
		actor.send({ type: "CONTINUE" });
		actor.send({ type: "CHECKPOINT" });
		actor.send({ type: "PLAN" });
		expect(phase(actor)).toBe("DESIGN");
		expect(actor.getSnapshot().context.task).toBe("fix typo");
	});

	it("discusses a refinement proposal read-only, and agrees from the discussion", () => {
		const actor = started();
		actor.send({ type: "REFINE", task: "t" });
		expect(phase(actor)).toBe("PROPOSE");
		expect(isDiscussing(actor.getSnapshot())).toBe(false);
		actor.send({ type: "DISCUSS" });
		expect(isDiscussing(actor.getSnapshot())).toBe(true);
		expect(isReadOnly(actor.getSnapshot())).toBe(true);
		actor.send({ type: "CONTINUE" });
		expect(phase(actor)).toBe("REFINE");
		expect(isDiscussing(actor.getSnapshot())).toBe(false);
	});
});
