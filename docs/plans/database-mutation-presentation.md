# Keep content steady while edits commit

This living ExecPlan follows `docs/PLANS.md`. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current.

## Purpose / Big Picture

Dragging a Database Page, changing a Property, and undoing an edit must not insert a status section above the content and move the user's target. Routine work stays quiet. A fixed-size Workbench header control reveals delayed activity and explicit recovery without changing content geometry. Predictable edits remain visible until the authoritative result has actually rendered.

## Progress

- [x] (2026-09-06 05:35Z) Trace current history, Board, List, and LocalCommit owners and agree on the integrated direction.
- [x] (2026-09-06 06:16Z) Extract a shared receipt-fenced optimistic journal and migrate Board's existing lifecycle.
- [x] (2026-09-06 06:16Z) Unify Database history submission and predictable forward/reverse presentation across hosts; retain List's distinct occurrence authority.
- [x] (2026-09-06 06:16Z) Replace in-flow status sections with a read-only aggregate header control and explicit recovery.
- [x] (2026-09-06 06:35Z) Update owning specifications and run focused behavioral, native workflow, and semantic checks.
- [x] (2026-09-06 06:35Z) Review the final change and commit the completed implementation.

## Surprises & Discoveries

Board has an owner journal but mounted Database surfaces also keep their own drop overlay. List uses a single local overlay and a separate occurrence-window authority. Forward-only history submission leaves reverse operations outside the forward presentation lifecycle. The initiating command already admits its LocalCommit delivery before resolving; transport acknowledgement does not need replacement.

Local filtering and collapsed rows cannot supply List materialization proof: absent roots or anchors are not evidence of success. List proves the exact normalized ordered sibling run against raw authoritative occurrences, and a tail placement requires complete authority. Conversely, a later mutation may legitimately change a Board neighborhood after the original rank is committed; exact receipt resource revisions distinguish materialization and supersession from stale display.

Two mounts of one View can have independent canonical query sources. Sharing their render token lets a fresh mount retire another mount's still-needed preview. Each independent read source therefore has its own presentation owner; the shared List window can share a lifecycle because its canonical authority is actually shared.

## Decision Log

Use one reusable journal lifecycle with separate projection models. Board summary rows and List occurrence windows represent different authority and cannot be merged. Each owner supplies exact materialization proof and a subscribed React render acknowledgement. A committed receipt alone is insufficient.

Keep unknown-outcome operations frozen and retry the exact operation identity. A definitive rejection may roll back; response loss cannot prove rejection. Unsupported or insufficiently bounded predictions remain pending instead of duplicating Core's hierarchy or sorting solver.

Treat the shared journal as reusable lifecycle, not a global authority keyed only by View identity. Independent Property addresses compose independently. Exact receipt revisions can retire only the affected address, preserving outstanding portions of a batch. Explicit resource revocation retires local presentation without cancelling the durable command or restoring rows from a stale fallback.

Use a fixed-size global header action rather than changing per-surface height. The aggregate observes existing retained history owners without acquiring new editing leases or becoming another history authority. Ordinary pending work must not offer destructive reset actions.

## Context and Orientation

`src/renderer/lib/board-store.ts` owns Board's canonical bounded reads and current journal. `src/renderer/lib/database-view-drag-operations.ts` predicts accepted Board drop hints. `src/renderer/lib/surface-history/` owns serialized editing attempts, exact retry, and reversal recipes; `src/renderer/lib/content-interaction-history.ts` retains history by content authority. Database Board and List components adapt gestures to these Modules. List's occurrence-window owner retains its own hierarchy projection, which is not the Board row model. `src/renderer/components/workbench/workbench-runtime.tsx` contributes global header actions.

A receipt identifies a durable mutation. A LocalCommit is Core's atomic evidence of the mutation and projection effects. An optimistic journal retains local transforms until the exact canonical projection proves their result and React commits that canonical result. These are distinct milestones, potentially delivered in different orders.

## Plan of Work

### Milestone 1: shared lifecycle

Introduce `src/renderer/lib/receipt-fenced-optimistic-journal.ts` with identity-keyed attempts, conflict admission, unknown outcomes, receipt acknowledgement, canonical materialization, and render-token retirement. Migrate Board's existing lifecycle without replacing its query authority. Unit tests must cover acknowledgement before/after canonical data, render fencing, exact retry, and unrelated conflicting work.

### Milestone 2: Database presentation

Introduce a pure `src/renderer/lib/database-view-operation-projection.ts` compiler for bounded scalar edits, manual position runs, and `reverse_data_edit` recipes. Prediction is all-or-nothing; missing rows, missing anchors, or unsupported rules stay pending. Connect the Database history Adapter to a retained presentation owner for both forward and reverse submission. Remove duplicate component-local Board overlays and forward-only paths. Move List's overlay lifecycle into its occurrence-window owner while keeping normalized Core move outcomes authoritative. Freeze any projection-dependent gesture before admission and do not allow a new gesture to compile against an unresolved stale window.

### Milestone 3: stable activity and recovery

Replace in-flow history banners in Database and NFM surfaces with a fixed header control. Observe stable cached snapshots from retained history owners. Delay routine busy presentation; expose unknown and blocked work immediately, grouped by scope. Keep retry/check actions exact and reset explicitly confirmed only where safe. Add renderer tests for observation, delayed status, and recovery actions; native tests must exercise unchanged content geometry during actual edits.

### Milestone 4: proof and documentation

Update `docs/product-specs/database-pages-and-views-behavior.md`, `docs/product-specs/nfm-editor-structural-editing-behavior.md`, `docs/product-specs/workbench-shell.md`, and `docs/reliability/local-commit-and-projections.md` to describe the final behavior. Replace obsolete statements rather than adding chronology. Run focused owner/projection/renderer tests, native content-history and Database-history workflows, and the full semantic gate. Run the standard suite for the cross-cutting renderer owner refactor. Review errors for causality before expanding scope.

## Concrete Steps

Run all commands in `/Users/asc/repo/nodex`. Use `vp test run --config vitest.node.config.ts <focused-helper-test>` for pure helpers and `vp test run --config vitest.renderer.config.ts <focused-renderer-test>` for React behavior. Run native checks as `vp run test:e2e tests/e2e/database-surface-history.spec.ts` and `vp run test:e2e tests/e2e/content-interaction-history.spec.ts`, verifying their collection banners before waiting. Finish with `vp run typecheck` and `vp run test`; one successful semantic alias covers both types and lint. Record exact completed checks below as implementation settles.

## Validation and Acceptance

A drag and scalar edit produce immediate predictable display with no vertical content movement. Undo and redo use the same presentation lifecycle. Receipt arrival cannot remove an overlay before canonical materialization and subscribed render. A lost response retains the frozen attempt and exact retry; a definitive rejection removes only its own attempt. A missing anchor or incomplete projection never passes as exact proof. Unknown or blocked status is accessible from the header, while ordinary fast actions do not flash a banner. Tests must assert behavior, geometry, and authority contracts, not class names or source strings.

## Idempotence and Recovery

No storage migration or production Profile access is required. All native verification uses fresh disposable seeded Profiles through repository scripts. Do not operate already-running application windows or use computer automation. Test failures can be rerun with a fresh scenario. Preserve unrelated working-tree changes and commit only this task's verified implementation.

## Artifacts and Notes

Validation completed during implementation:

- Shared journal and Board owner: 78 focused Node tests passed.
- Final Board compiler/gesture boundary regressions: 39 Node tests passed, including exact resource supersession, bounded tails, and retained revocation dependencies.
- List ordered-run proof: 22 Node tests passed. Final List receipt-proof and window-owner suite: 24 passed, including remote neighborhood changes, exact View identity, and rejection of stale render snapshots for both predicted and pending-only work.
- Final Database surface and Workbench read-source/history renderer suites: 57 passed, act-clean.
- Header browser behavior: 6 passed. Header shell placement: 61 passed after updating the old two-button expectation for the new fixed action.
- `vp run test`: Unit 4,948, Effect 27, Core-client 1,064, and Main 1,056 passed. Renderer had 3,181 passes and the one obsolete header-action expectation above; its entire 61-test file passed after correction. The runner stopped at that failure, so `vp run test:integration` was run separately: 42 passed, two intentionally skipped.
- Final full semantic gate passed with zero warnings/errors across 4,272 files.
- `vp run test:e2e tests/e2e/database-surface-history.spec.ts tests/e2e/content-interaction-history.spec.ts`: the intended two tests were collected and both passed after the final edits. The native runner also completed the application build and renderer-bootstrap verification. Board Property edits and List drag/Undo/Redo kept content top movement within 0.5 CSS pixels; the recovery popover screenshot was visually reviewed.

No real Profile data was accessed. Native checks use disposable seeded Profiles. `CHANGELOG.md` is intentionally unchanged: this refines an Unreleased feature and its internal presentation lifecycle, without adding a separate released capability. The full release/source gate is not needed; no Core schema, packaging, or release-tooling source changed.

## Interfaces and Dependencies

The compiler accepts `DatabaseViewRenderModel` and readonly `DatabaseApplyOperationV2[]`, returning `apply(canonical)`, readonly `conflictKeys`, `predictable`, and an optional receipt acknowledgement hook. Its identity return is materialization evidence only when prediction was safely compiled and the exact bounded canonical context remains valid. The shared journal owns lifecycle only; semantic owners retain their projection proof and refresh behavior. Existing LocalCommit admission remains the only transport acknowledgement path. No new runtime dependency is required.

## Outcomes & Retrospective

Content geometry stays steady during edits. Forward operations and history replay now share receipt-fenced presentation lifecycles, while Board reads, List occurrences, and independent mounts retain their own authority. Fast work is quiet; delayed canonical repair and explicit recovery remain accessible from the fixed Workbench header.

The recurrence-prevention review produced executable guards for unknown retries, partial-batch supersession, incomplete tails, hidden List occurrences, independent read sources, revoked fallback rows, and stale render snapshots. Existing LocalCommit admission remains unchanged. No migration or new dependency was needed.

Revision note: Completed plan records the agreed presentation lifecycle, the authority boundaries found during review, and final validation evidence.
