# 7. One yield tool across all phases

**Status:** accepted. Amends ADR 2, ADR 4, ADR 5.

## Decision

One `yield` tool replaces the two phase-specific tools (`resume_work` and `request_checkpoint`). It is present in all phases except IDLE and VIBE. What it does depends on the current state: in discussion phases (DESIGN, CHECKPOINT-discuss, PROPOSE-discuss) it proposes moving on and the user confirms; in working phases (BUILD, REFINE) it requests a checkpoint.

## Reason

Prompt cache efficiency. When the tool list changes between phases — tools added or removed — the model's prompt cache is invalidated. The agent transitions between phases frequently (DESIGN → BUILD → CHECKPOINT → BUILD, etc.), and each transition that changed the tool set would blow the cache.

## Alternatives

- **Keep separate tools but always present.** The agent might call `request_checkpoint` in DESIGN, which doesn't make sense. Either it errors (confusing) or it does something unexpected.
- **Keep separate tools, phase-gated.** Works correctly but invalidates the cache on every phase transition. This was the original approach.
- **One tool with phase-dependent behavior.** The model sees the same tool set regardless of phase. The tool dispatches internally based on the machine state.

## Consequences

- The tool's behavior is determined by the machine state at call time, not by which tool was called.
- The model doesn't need to know which tool to call in which phase — it calls `yield` and the state machine handles it.
- ADR 2's distinction between "claims that add oversight" and "claims that remove oversight" still holds; it is just one tool now instead of two.
