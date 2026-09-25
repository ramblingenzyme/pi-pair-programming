# 3. xstate phase machine with persisted snapshots

**Status:** accepted. Amended by ADR 6.

## Decision

The phases are an xstate v5 machine (`machine.ts`) with IDLE plus one `task` state containing DESIGN, BUILD, CHECKPOINT (with `review` and `discuss`) and REFINE (with `propose` and `apply`).

- **The hooks drive the machine.** Pi's hooks send it events and read its snapshot. One subscriber applies the side effects: tool gating, the status line and persistence.
- **Read-only is a state tag.** Whether writes are allowed is the xstate tag `readOnly`, not a list of phase names.
- **Snapshots persist in the session.** The persisted snapshot is written to the session as a `pair-state` entry on every change, and restored from the current branch on `session_start`.
- **Stale snapshots are dropped.** Snapshots from an older machine shape are rejected by `restorable()` and the session starts fresh. xstate accepts them at creation and then crashes asynchronously.

**The hooks keep the Decider calls.** They have to return a verdict synchronously (block, continue), so the machine only ever records the outcome.

**Compaction is not a state.** It happens to the session, not to the task. An earlier COMPRESS phase needed a history state to return from, and it cluttered the whole graph.

## Alternatives

- **Hand-rolled phase variable.** The first version used one. It worked, but the transitions were spread across hooks, invalid transitions weren't impossible, and nothing could draw the machine.
- **Decider calls as invoked actors.** xstate can run async work inside the machine. That doesn't fit hooks that must return a verdict, like `tool_call` blocks or `turn_end` continuations.
- **One checkpoint per working state.** Separate checkpoints inside BUILD and REFINE would avoid the `refining` flag guarding `CONTINUE`, but would duplicate the review/discuss states and the read-only tag.

## Consequences

- **Snapshot format:** the machine's state shape is persisted in session files. Changing it loses the saved state of sessions in progress; they restart in IDLE rather than crashing.
- **Dependency:** `xstate` is a runtime dependency, not one pi supplies.
- **Autolayout:** the xstate visualiser's autolayout draws this machine poorly. The structure is right; arrange it by hand.
