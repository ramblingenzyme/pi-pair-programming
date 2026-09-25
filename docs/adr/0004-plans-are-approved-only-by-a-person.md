# 4. Plans are approved only by a person

**Status:** accepted. Amends ADR 2.

## Decision

DESIGN is a discussion, not a plan-and-wait step. The agent explores the code with you, captures ideas and answers questions of feasibility and correctness. It writes an execution plan only when you ask for one.

Leaving DESIGN works like leaving any discussion: the agent proposes it with `resume_work` and you confirm, or you type `/continue`. Nothing at the end of a turn asks "Plan ready?", and the Decider can no longer approve a plan. `deciderMayPass` covers only auto-finishing a trivial task.

## Alternatives

- **A turn-end plan gate.** The previous design. It fired after every DESIGN turn, so every exploratory answer came with an approval prompt and pushed the agent towards writing a plan each round.
- **A `STATUS: plan-ready` line that fires the gate.** Mirrors the old BUILD checkpoint line. It keeps approval in deterministic code, but it's another text protocol, and the agent still decides when a plan exists.
- **Keep Decider approval inside `resume_work`.** This keeps small standard plans passing in print mode, but then an agent's tool call plus a second model's verdict would move past a human gate with no person involved, which is what ADR 2 rules out.

## Consequences

- In print mode, standard and complex tasks stop in DESIGN. Only trivial tasks, which skip DESIGN, can run to completion unattended.
- `resume_work` is offered wherever the `discussing` tag is, and DESIGN carries that tag.
