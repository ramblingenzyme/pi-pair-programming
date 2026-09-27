# 1. Hard rules before a swappable Decider

**Status:** accepted

## Decision

Every phase-transition judgment goes through one `Decider` interface (`classifyEffort`, `shouldCheckpoint`, `canSkipReview`). Deterministic rules in `rules.ts` run before it and have the final say. The Decider is only asked about the cases the rules leave open.

The rules are:

- destructive-command confirmation;
- read-only enforcement;
- the 4-edit thrash limit;
- the mid-fix checkpoint deferral;
- which review gates may be passed without a person at all (`deciderMayPass`).

The implementations are `RuleDecider` (keyword heuristics) and `LlmDecider` (a model). Jev is the intended replacement. Any other Decider plugs in without touching the hooks or the machine.

When the LLM judge fails or answers outside the allowed words, it falls back to `RuleDecider`. The exception is the mid-run checkpoint question, where a failure means "don't interrupt".

## Alternatives

- **Classifier only.** Send every transition to the model. This was rejected because Jev's own published weaknesses are literal reading, distractor-heavy states and susceptibility to injection. Clear-cut cases like `rm -rf` or a sixth edit to one file shouldn't depend on those.
- **Rules only.** Keyword heuristics for everything. Kept as the fallback, but they misjudge the middle ground. In testing they classified "change the greeting from Hi to Hello" as standard and checkpointed healthy multi-file work.
- **Rules inside the Decider.** An earlier version kept "only trivial tasks may auto-finish" inside `RuleDecider`. Swapping in `LlmDecider` silently dropped the rule, and a standard multi-file task auto-finished. A rule that must survive a Decider swap has to live outside it.

## Consequences

- A new Decider only has to answer narrow closed questions. It can never widen what may pass without review.
- Every eligibility rule needs a home in `rules.ts` and a call in the hooks, not in a Decider.
- The Decider interface is the contract Jev will implement. Changing its shape means changing every implementation.
