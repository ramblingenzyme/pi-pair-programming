# pi-pair-programming

A [pi](https://github.com/earendil-works/pi) extension that makes the agent work like a pair programmer: plan before building when the work deserves it, stop for review at sensible points, and compress code only after agreeing what to compress.

## Architecture

The extension is a phase machine driven by pi's hooks. One xstate machine tracks the workflow, hooks send it events and read its snapshot, and a subscriber applies side effects (tool gating, banners, persistence).

### Phase machine

States: **IDLE** → **DESIGN** → **BUILD** → **CHECKPOINT** → (optional **PROPOSE** → **REFINE** loop) / **VIBE**

- **IDLE**: Nothing tracked. Next prompt starts a task.
- **DESIGN**: Read-only exploration and planning. Ends when the user approves a plan.
- **BUILD**: Implementation. Checkpoints happen mid-run (judge decides or 4 writes to same file).
- **CHECKPOINT**: Read-only review. User can continue, re-plan, refine, or finish. From a refine checkpoint, user can also go back to building.
- **PROPOSE**: Read-only refinement proposal. User agrees what to compress.
- **REFINE**: Apply agreed compression. Checkpoint when done or on failure.
- **VIBE**: Override mode. No phase enforcement, no checkpoints, no read-only restrictions.

The workflow supports staged implementation: BUILD → CHECKPOINT → REFINE → CHECKPOINT → BUILD → DONE. After refining, you can continue refining or return to building.

Read-only is a state tag (`readOnly`), not a phase list. Edit/write tools are removed and bash is limited to non-mutating commands in read-only phases.

### Key files

- **`index.ts`**: Entry point: flag registration, extension wiring
- **`machine.ts`**: xstate phase machine, snapshot persistence, phase helpers
- **`tools.ts`**: Tool registration (`propose`, `checkpoint`, `record_decision`)
- **`commands.ts`**: Slash commands (`/design`, `/continue`, `/refine`, `/done`, `/phase`, `/judge-model`)
- **`rules.ts`**: Hard deterministic rules (destructive commands, read-only enforcement, thrash limit)
- **`session-hooks.ts`**: `session_start`, `session_before_compact`, `session_compact` hook registration
- **`turn-hooks.ts`**: `input`, `before_agent_start`, `tool_call`, `turn_end`, `agent_before_settle` hook registration
- **`src/judge/config.ts`**: Judge model resolution and session-scoped override persistence
- **`src/judge/decider.ts`**: Decider interface
- **`src/judge/llm-decider.ts`**: LLM judge for effort classification and checkpoint decisions
- **`src/judge/rule-decider.ts`**: Keyword-rule implementation
- **`footer.ts`**: Custom footer showing phase, effort, path, model, thinking level, cost, context usage
- **`compaction.ts`**: Phase-aware compaction instructions for pi's summarizer
- **`src/decisions/store.ts`**: Decision store and persistence
- **`src/decisions/list.ts`**: Decision list UI component
- **`src/todos/store.ts`**: Todo store and persistence
- **`src/todos/list.ts`**: Todo list UI component

### Extension points

- **Hooks**: `session_start`, `session_before_compact`, `session_compact`, `input`, `before_agent_start`, `tool_call`, `turn_end`, `agent_before_settle`
- **Tools**: `propose` (propose moving on in discussion phases), `checkpoint` (request checkpoint in working phases), `record_decision` (record autonomous decisions)
- **Commands**: `/design`, `/continue`, `/refine`, `/done`, `/phase`, `/judge-model`

## Development

```sh
pnpm test    # node:test with expect-native
pnpm check   # tsc
```

**Constraints:**

- Erasable TypeScript only: no enums, no constructor parameter properties
- `tsconfig.json` enforces `erasableSyntaxOnly`
- Node 22.19+ (pi's minimum)

## Documentation

When making changes that affect user-facing behavior, update both this file and `README.md`:

- **New or changed phases**: Update the phase descriptions and the phase table in README.md
- **New or changed commands**: Update the commands table in README.md
- **New or changed tools**: Update the agent tools section in README.md
- **New or changed flags**: Update the flags section in README.md
- **Install or setup changes**: Update the install section in README.md
- **Architecture changes**: Update the architecture section here and any affected sections in README.md

README.md is user-facing documentation; AGENTS.md is working instructions for agents. Keep them synchronized so neither becomes stale.

## Session state

Phase state persists as `pair-state` entries in the session file. Snapshots from older machine shapes are rejected by `restorable()` and sessions start fresh in IDLE.

Judge calls are recorded as `pair-judge` entries with the question, raw reply or error, and whether rules answered instead.

Autonomous decisions are recorded as `pair-decisions` entries. Todos are recorded as `pair-todos` entries. Both are branch-aware: branching gives the correct state for that point in history.

## ADRs

See `docs/adr/` for architectural decisions:

- [ADR 0001](docs/adr/0001-hard-rules-before-a-swappable-decider.md): Hard rules before a swappable decider
- [ADR 0002](docs/adr/0002-agent-claims-may-add-oversight-never-remove-it.md): Agent claims may add oversight, never remove it
- [ADR 0003](docs/adr/0003-xstate-phase-machine-with-persisted-snapshots.md): xstate phase machine with persisted snapshots
- [ADR 0004](docs/adr/0004-plans-are-approved-only-by-a-person.md): Plans are approved only by a person
- [ADR 0005](docs/adr/0005-agent-checkpoint-requests-are-trusted-in-build.md): Agent checkpoint requests are trusted in BUILD
- [ADR 0006](docs/adr/0006-refinement-steps-sit-beside-design-and-build.md): Refinement steps sit beside DESIGN and BUILD
- [ADR 0009](docs/adr/0009-two-phase-specific-tools.md): Two phase-specific tools (supersedes ADR 7)
- [ADR 0008](docs/adr/0008-record-autonomous-decisions.md): Record autonomous decisions
