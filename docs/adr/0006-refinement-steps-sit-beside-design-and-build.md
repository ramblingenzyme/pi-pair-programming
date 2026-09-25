# 6. Refinement steps sit beside DESIGN and BUILD

**Status:** accepted. Amends ADR 3.

## Decision

REFINE's `propose` and `apply` substates are now sibling states under `task`: PROPOSE (read-only, with `review` and `discuss`) and REFINE. The single shared CHECKPOINT and its `refining` flag stay.

Every step of both workflows now sits at the same depth. Nesting refinement one level deeper made it look like part of a task rather than a workflow of its own.

## Alternatives

- **Two separate flows.** IMPLEMENT (DESIGN → BUILD → BUILD_CHECKPOINT) and REFINE_FLOW (PROPOSE → REFINE → REFINE_CHECKPOINT). This removes the `refining` flag, but adds a second checkpoint, a second checkpoint banner and a helper for "either checkpoint". The flows cross into each other anyway.

## Consequences

- Snapshots saved in the old shape fail `restorable` and start fresh in IDLE.
