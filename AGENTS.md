# pi-pair-programming

A [pi](https://github.com/earendil-works/pi) extension that makes the agent work like a pair programmer: plan before building when the work deserves it, stop for review at sensible points, and compress code only after agreeing what to compress.

## Architecture

The extension is a phase machine driven by pi's hooks. One xstate machine tracks the workflow, hooks send it events and read its snapshot, and a subscriber applies side effects (tool gating, banners, persistence).

### Phase machine

States: **IDLE** → **DESIGN** → **BUILD** → **CHECKPOINT** → (optional **PROPOSE** → **REFINE** loop)

- **IDLE**: Nothing tracked. Next prompt starts a task.
- **DESIGN**: Read-only exploration and planning. Ends when the user approves a plan.
- **BUILD**: Implementation. Checkpoints happen mid-run (judge decides or 4 writes to same file).
- **CHECKPOINT**: Read-only review. User can continue, re-plan, refine, or finish. From a refine checkpoint, user can also go back to building.
- **PROPOSE**: Read-only refinement proposal. User agrees what to compress.
- **REFINE**: Apply agreed compression. Checkpoint when done or on failure.

The workflow supports staged implementation: BUILD → CHECKPOINT → REFINE → CHECKPOINT → BUILD → DONE. After refining, you can continue refining or return to building.

Read-only is a state tag (`readOnly`), not a phase list. Edit/write tools are removed and bash is limited to non-mutating commands in read-only phases.

### Key files

- **`machine.ts`**: xstate phase machine, snapshot persistence, phase helpers
- **`commands.ts`**: Slash commands (`/design`, `/continue`, `/refine`, `/done`, `/phase`, `/judge-model`)
- **`index.ts`**: Entry point: flag registration, extension wiring
- **`rules.ts`**: Hard deterministic rules (destructive commands, read-only enforcement, thrash limit)
- **`session-hooks.ts`**: `session_start` and `session_compact` hook registration
- **`turn-hooks.ts`**: `input`, `before_agent_start`, `tool_call`, `turn_end`, `agent_before_settle` hook registration
- **`decider.ts`**: Decider interface and keyword-rule implementation
- **`llm-decider.ts`**: LLM judge for effort classification and checkpoint decisions
- **`judge-config.ts`**: Judge model resolution and session-scoped override persistence
- **`footer.ts`**: Custom footer showing phase, effort, path, model, thinking level, cost, context usage
- **`compaction.ts`**: Phase-aware compaction instructions for pi's summarizer
- **`decisions.ts`**: Autonomous decision recording and branch-aware state reconstruction
- **`todos.ts`**: Todo tracking and branch-aware state reconstruction

### Extension points

- **Hooks**: `session_start`, `input`, `before_agent_start`, `tool_call`, `turn_end`, `agent_before_settle`, `session_compact`
- **Tools**: `yield` (propose moving on in discussion phases, request checkpoint in working phases), `record_decision` (record autonomous decisions in working phases)
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

## Session state

Phase state persists as `pair-state` entries in the session file. Snapshots from older machine shapes are rejected by `restorable()` and sessions start fresh in IDLE.

Judge calls are recorded as `pair-judge` entries with the question, raw reply or error, and whether rules answered instead.

Autonomous decisions are recorded as `pair-decisions` entries. Todos are recorded as `pair-todos` entries. Both are branch-aware: branching gives the correct state for that point in history.

## ADRs

See `docs/adr/` for architectural decisions:

- Hard rules before a swappable decider
- Agent claims may add oversight, never remove it
- xstate phase machine with persisted snapshots
- Plans are approved only by a person
- Agent checkpoint requests are trusted in BUILD
- Refinement steps sit beside DESIGN and BUILD
- One yield tool across all phases
- Record autonomous decisions
