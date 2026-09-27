import { describe, expect, it } from "expect-native";
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

	it("lets the Decider pass only a trivial result", () => {
		expect(deciderMayPass("trivial", none)).toBe(true);
		expect(deciderMayPass("standard", none)).toBe(false);
		expect(deciderMayPass("complex", none)).toBe(false);
	});

	it("never lets the Decider pass work that hit the thrash limit", () => {
		expect(deciderMayPass("trivial", new Map([["a.ts", 4]]))).toBe(false);
	});
});


