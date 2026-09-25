# 5. Agent checkpoint requests are trusted in BUILD

**Status:** accepted. Amends ADR 2.

## Decision

`request_checkpoint` is offered in BUILD as well as REFINE, and a call stops the agent for review in either. The `STATUS: checkpoint-requested` line, and the Decider's `selfReportedCheckpoint` signal it fed, are removed.

The Decider still decides the checkpoints the agent doesn't ask for.

## Alternatives

- **Keep self-report as weak evidence in BUILD.** The previous design, meant to stop an agent from checkpointing every few edits to hand off responsibility. It contradicted ADR 2's own rule that claims adding oversight are trusted as-is. The line was also only read on turns that made tool calls, which is the case where a request to stop makes the least sense.

## Consequences

- The agent has one way to ask for review in both working phases.
- If the agent over-checkpoints in BUILD, a limit belongs in `rules.ts` (see ADR 1), not a return to text signals.
