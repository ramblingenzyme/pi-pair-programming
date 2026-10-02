# 9. Two phase-specific tools, always present

**Status:** accepted. Supersedes ADR 7.

## Decision

Two phase-specific tools, `propose` and `checkpoint`, replace the unified `yield` tool. Both tools are always present in all phases except IDLE and VIBE:

- `propose`: in discussion phases (DESIGN, CHECKPOINT — DISCUSSION, PROPOSE — DISCUSSION), proposes moving on and the user confirms. Errors in review states with guidance to wait for the user.
- `checkpoint`: in working phases (BUILD, REFINE), requests a checkpoint for review. Errors outside working phases.

## Reason

The unified `yield` tool was confusing because it had to handle three different behaviors based on hidden substates (review vs discuss) that the agent couldn't directly observe. The agent would call `yield` after summarizing at CHECKPOINT, thinking it was done, but the tool would error because we were still in the review substate, not the discuss substate yet.

The agent needs clear, consistent tool behavior. Two tools with explicit purposes are easier to understand than one polymorphic tool that requires the agent to reason about hidden state.

## Alternatives

- **Keep the unified `yield` tool.** The tool's behavior depends on the current state, which requires the agent to understand the review/discuss substate distinction. This created confusion about when to call the tool.
- **Phase-gated tools (add/remove dynamically).** Works correctly but invalidates the prompt cache on every phase transition. The agent transitions between phases frequently (DESIGN → BUILD → CHECKPOINT → BUILD, etc.), and each transition that changed the tool set would blow the cache.
- **One tool with phase-dependent behavior.** Same as the original `yield` approach — the model sees the same tool set regardless of phase, but the tool dispatches internally based on the machine state.

## Consequences

- Both tools are always present (stable for prompt caching, preserving ADR 7's constraint).
- Each tool has a single, clear purpose that doesn't depend on hidden state.
- The agent can see in the banner which tool to use: review states say "Do not call `propose` yet", discuss states say "Use `propose` to move on".
- Errors guide the agent to the right tool when called in the wrong phase.
- ADR 2's distinction between "claims that add oversight" and "claims that remove oversight" still holds; it is two tools now instead of one.
