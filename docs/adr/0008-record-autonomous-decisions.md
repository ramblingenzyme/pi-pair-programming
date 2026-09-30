# 8. Record autonomous decisions

**Status:** accepted.

## Decision

Added a `record_decision` tool for agents to record decisions made without user discussion or approval that have real impact on the outcome. The tool captures the decision itself and alternatives considered. Decisions are summarized at checkpoints in BUILD/REFINE phases, and mentioned at the next stopping point in VIBE mode.

## Reason

In vibe mode and sometimes in BUILD phases where plans weren't fully specified, the agent makes autonomous decisions. Without a way to record these, the user has no visibility into what was decided and why. This creates a transparency problem — the user can't review or understand the agent's reasoning after the fact, especially for decisions that affect behavior, change the approach, or impact what comes next.

The tool is specifically for decisions made *without* user discussion or approval. If the user already weighed in, the decision is already in the conversation history and doesn't need separate recording.

## Alternatives

- **Don't record decisions at all.** The user has no visibility into autonomous choices. They only discover them when reviewing the code, without context for why the decision was made.
- **Record all decisions.** Too noisy. Includes trivial choices (variable names, formatting) that don't need tracking.
- **Require explicit user approval for all decisions.** Defeats the purpose of autonomous work in vibe mode. The user explicitly chose to work without oversight.
- **Use code comments or a separate log file.** Comments clutter the code with process information. A separate log file is disconnected from the conversation context where the decision was made.

## Consequences

- The agent must be judicious about what counts as a "decision with real impact" — architectural choices, implementation approaches, interface designs, and trade-offs.
- The user gets visibility into autonomous choices at checkpoints or stopping points, with enough context (alternatives considered) to understand the reasoning.
- Creates a reviewable record that persists with the session.
- The agent needs to distinguish between collaborative decisions (already discussed) and autonomous ones. Recording a collaborative decision is noise.
