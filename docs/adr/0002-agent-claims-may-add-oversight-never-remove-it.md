# 2. Agent claims may add oversight, never remove it

**Status:** accepted. Amended by ADR 4 and ADR 5.

## Decision

What the agent says about its own work is trusted according to which direction it moves oversight.

- **Claims that add oversight are trusted as-is.** `request_checkpoint` stops the agent for review with no confirmation. If it's wrong, the cost is one needless interruption.
- **Claims that remove oversight need a person.** `resume_work` ("the user asked me to continue") opens a confirmation dialog quoting your last message. The agent can propose leaving a checkpoint, but can't leave by itself.
- **Self-report as evidence is weak.** The `STATUS: checkpoint-requested` line in BUILD is one input to the Decider, never enough on its own.

Plan approval, agreeing a refinement, and leaving a checkpoint are human gates. The Decider may pass only the gates `deciderMayPass` allows (see ADR 1). No agent tool can pass any of them.

## Alternatives

- **Trust agent tool calls outright.** This is the simplest option, but a tool call is the agent's claim about what you said. A misreading ("sounds good, but what about the tests?") or text injected through files or tool output would move the agent past review with nobody deciding.
- **The Decider verifies the claim.** Have the judge check that your last message literally asks to resume. This was rejected because literal reading is on Jev's own list of weaknesses, and it puts an approval in the hands of a model.
- **Selector-only exits.** Show the review selector after every discussion reply. This interrupted every conversation, so it was replaced by commands (`/continue`, `/done`) plus the confirm-gated tool.

## Consequences

- Any new agent tool that changes phase has to be sorted into one of these two directions before it's built.
- In print mode, gates that remove oversight can't be passed: nobody is there to confirm.
