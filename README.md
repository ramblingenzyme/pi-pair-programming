# pi-pair-programming

A [pi](https://github.com/earendil-works/pi) extension that makes the agent work like a pair programmer: plan before building when the work deserves it, stop for review at sensible points, and compress code only after agreeing what to compress.

Pi ships no plan/review cycle. This extension adds one as a phase machine, enforced at the tool layer rather than by asking the model nicely.

## Install

Requires pi 0.87+ and Node 22.19+, pi's own minimum.

```sh
pnpm install
pi install ~/src/pi-pair-programming       # load in every session
pi -e ~/src/pi-pair-programming/index.ts   # or try it for one session
```

Judgment calls default to the user's current session model with thinking turned off. Override with `/judge-model` or `--pair-judge-model`. Without a usable model, or with `--pair-rules`, keyword rules make the calls instead.

## Phases

| Phase          | What the agent can do                                                                                                                                                               | How it ends                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **IDLE**       | Nothing is tracked.                                                                                                                                                                 | Your next prompt starts a task.                                                                          |
| **DESIGN**     | Read only: edit and write are removed, and bash is limited to non-mutating commands. It explores the code with you and captures ideas, and writes a plan only when you ask for one. | You approve the plan: the agent proposes it with `propose` and you confirm, or you type `/continue`. |
| **BUILD**      | Everything.                                                                                                                                                                         | A checkpoint, forced, judged, or requested by the agent; or the agent finishing.                         |
| **CHECKPOINT** | Read only. It summarises its work, then discusses it with you.                                                                                                                      | You continue, re-plan, refine, or finish. From a refine checkpoint, you can also go back to building.    |
| **PROPOSE**    | Read only. It proposes what is worth compressing, meaning duplication that already exists in the code, not terseness. You discuss the proposal the way you discuss a checkpoint.    | You agree to the proposal.                                                                               |
| **REFINE**     | It compresses what you agreed, without changing behaviour.                                                                                                                          | The agent calls `checkpoint`, or a failure stops it.                                             |
| **VIBE**       | Override mode. No phase enforcement, no checkpoints, no read-only restrictions. Work directly with the user.                                                                        | Toggle off to return to normal workflow.                                                    |

Each new prompt in IDLE is classified by effort. **Trivial** tasks go straight to BUILD. **Standard** and **complex** tasks start in DESIGN. For complex tasks the agent is told to explore the code before proposing a plan.

The rules of the whole workflow are appended to the system prompt. A short banner stating the current phase and what to do now goes to the model at the start of every prompt, again at every phase change, and again after compaction.

### Checkpoints

- **Mid-run in BUILD:** the judge decides whether enough has changed to deserve a look. Editing the same file 4 times forces a checkpoint whatever the judge says. No checkpoint happens on a turn where a tool failed, because the agent is presumably fixing it.
- **Mid-run in REFINE:** the reverse applies. A failed tool result forces a checkpoint at once, because a refactor that breaks something has a bug and shouldn't be fixed forward.
- **When a run finishes:** the review appears. The agent's last message serves as the summary.

At the review, choose **Discuss**, **Continue building** (or **Continue refining** and **Continue building** from a refine checkpoint), **Propose refinements**, or **Task done**. Typing a message instead starts a discussion, and the selector stays away until you leave with a command. The status line shows how to leave.

### Who decides what

- **Hard rules run first, and the judge can't override them.** These are destructive-command confirmation, read-only enforcement, the 4-edit limit, and which review gates the judge may pass at all.
- **The judge handles the ambiguous middle:** effort classification, and whether to stop for a mid-run checkpoint. It may also finish a trivial task without review.
- **You decide everything else:** approving plans, agreeing refinements, and leaving checkpoints. The agent can _propose_ moving on with `propose`, but you confirm it.

See [docs/adr](docs/adr) for the reasoning.

## Commands

| Command                            | Effect                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/design <task>`                   | Start a task in DESIGN whatever its effort. At a checkpoint, `/design` goes back to DESIGN.                             |
| `/refine [what]`                   | Start a refinement task. At a checkpoint, propose refinements to the current task.                                      |
| `/continue`                        | Move on: approve the plan in DESIGN, leave a checkpoint to resume building or refining, or agree a refinement proposal. |
| `/done`                            | End the current task.                                                                                                   |
| `/phase`                           | Show the phase, effort and task.                                                                                        |
| `/judge-model [provider/model-id]` | Show or set the model for judgment calls. `/judge-model default` resets.                                                |

Running `rm -rf`, `sudo`, `git push --force`, `git reset --hard` or similar asks for confirmation in every phase. In print mode, with no UI to confirm, those commands are blocked.

## Agent tools

These tools are always present in all phases except IDLE and VIBE:

- **`propose`**: in discussion phases (DESIGN, CHECKPOINT — DISCUSSION, PROPOSE — DISCUSSION), the agent proposes moving on and you confirm with your last message quoted. In review states (CHECKPOINT, PROPOSE before you respond), the agent summarizes and waits.
- **`checkpoint`**: in working phases (BUILD, REFINE), the agent requests a checkpoint for review when something is worth a look, after a refinement round, or when a refinement fails.
- **`record_decision`**: in working phases (BUILD, REFINE), the agent records decisions made without user discussion or approval that have real impact on the outcome. Decisions are summarized at the next checkpoint.

## Flags

- `--pair-rules`: use keyword rules instead of the LLM judge.
- `--pair-judge-model provider/model-id`: model for judgment calls (overridden by `/judge-model`).

## Unattended use

In print mode (`pi -p`) nobody can confirm anything. Gates that need you stop the run, including every plan, so standard and complex tasks stop in DESIGN. Trivial tasks skip DESIGN, and the judge may still finish them, so `pi -p` with this extension can edit files and close trivial tasks without a person involved.

## Inspecting decisions

- **Judge calls:** every call is recorded in the session file as a `pair-judge` entry, with the question, the raw reply or error, and whether the rules answered instead.
- **Phase state:** saved as `pair-state` entries, which is what resuming restores.
- **Autonomous decisions:** saved as `pair-decisions` entries, recording choices the agent made without user approval.
- **Todos:** saved as `pair-todos` entries.

```sh
grep -o '"customType":"pair-judge"[^}]*}' ~/.pi/agent/sessions/<project>/<session>.jsonl
```

## Compaction

The extension provides phase-aware instructions for pi's compaction summarizer, so that when a session is compacted the workflow state (phase, task, effort, write counts) is preserved and work can resume correctly.

## Development

```sh
pnpm test    # node:test with expect-native
pnpm check   # tsc
```

| File              | Contents                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `index.ts`        | Entry point: flag registration, extension wiring.                         |
| `machine.ts`      | The xstate phase machine, snapshot persistence, phase helpers.            |
| `rules.ts`        | Hard rules (destructive commands, read-only enforcement, thrash limit).   |
| `commands.ts`     | Slash commands (`/design`, `/continue`, `/refine`, `/done`, `/phase`, `/judge-model`). |
| `session-hooks.ts`| `session_start` and `session_compact` hook registration.                  |
| `turn-hooks.ts`   | `input`, `before_agent_start`, `tool_call`, `turn_end`, `agent_before_settle` hook registration. |
| `decider.ts`      | The `Decider` interface and the keyword-rule implementation.              |
| `llm-decider.ts`  | The LLM judge.                                                            |
| `judge-config.ts` | Judge model resolution and session-scoped override persistence.           |
| `footer.ts`       | Custom footer showing phase, effort, path, model, thinking level, cost, context usage. |
| `compaction.ts`   | Phase-aware compaction instructions for pi's summarizer.                  |
| `decisions.ts`    | Autonomous decision recording and branch-aware state reconstruction.      |
| `todos.ts`        | Todo tracking and branch-aware state reconstruction.                      |

The source must stay erasable TypeScript: no enums and no constructor parameter properties. `node --test` runs files through Node's type stripping, and `tsconfig.json` enforces this with `erasableSyntaxOnly`.
