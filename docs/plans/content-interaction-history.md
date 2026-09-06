# Undo content in interaction order

This living ExecPlan follows `docs/PLANS.md`. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current.

## Purpose / Big Picture

After dragging Blocks from a Page into a Database Board or List, pressing Command-Z immediately must remove the promoted Pages and restore the original Blocks. Redo must restore the same identities. Typing before and after the transfer must undo in actual interaction order, without clicking another surface first. Page titles, Page bodies, and Database mutations share this content history; native input drafts, chat drafts, Canvas, and embedded file editors retain their own editing boundaries.

## Progress

- [x] (2026-09-06 03:03Z) Trace existing history ownership and reproduce the native drag/keyboard failure in one focused Electron test.
- [x] (2026-09-06 03:08Z) Choose one chronological owner with typed content bindings and authority-scoped window lifetime.
- [x] (2026-09-06 03:18Z) Implement typed bindings and cross-participant capture boundaries in the existing history engine.
- [x] (2026-09-06 03:28Z) Connect Page bodies, Page titles, and Database operations to the shared owner with explicit lifetime management; include hidden Document replay and invoking input restoration.
- [x] (2026-09-06 03:37Z) Replace Promotion Redo's whole-source revision guard with guarded affected-content validation, preserving unrelated source edits and allowing earlier history round trips; six focused Core tests pass.
- [x] (2026-09-06 03:39Z) Verify interleaving, native keyboard routing, exact redo identity, pending outcomes, and independent input boundaries; the native Electron regression passes without focus repair.
- [x] (2026-09-06 03:49Z) Update owning specifications and architecture, run final checks, and review the diff; changes are ready for the coordinated commit.

## Surprises & Discoveries

The baseline Electron test collects exactly one test and fails on the first keyboard Undo after native Block-to-Board drag: the promoted card remains while older source typing is undone. This establishes a chronology defect rather than a missing durable inverse.

Yjs merges native edits before its stack-added event. Its installed UndoManager calls `captureTransaction` before merging, making that callback the necessary place to split a typing group when another participant has acted. Remote updates and replay must not split or create local captures.

Page title edits use a separate Y.Text UndoManager. Merely combining Board and body shortcuts would leave titles on the wrong chronology. Retained document/editor leases already distinguish view unmount from resource disposal.

Native E2E now passes immediate Promotion Undo and Redo. Complete interleaving then exposes a Core conflict after older text is undone and redone: `Source Document changed after Promotion Undo`. The recipe compares the entire source head even when affected content is restored exactly. The Promotion replay boundary must guard affected roots and placement rather than reject unrelated source revisions. A temporary focus trace also proved native drag leaves DOM focus on body with a retained editor selection; after shared Undo, the connected invoking editor must reclaim unclaimed focus so the next Redo reaches content history. Later explicit focus choices still win.

## Decision Log

Decision (2026-09-06): Lift the existing history engine into one interaction owner with generic participant bindings, instead of selecting between independent undo stacks. Each retained entry keeps its original adapter; requests and inverse identity retain the existing exact-attempt safeguards.

Decision (2026-09-06): Scope the owner to one renderer window, Library, access context, and Store epoch. View and Page identifiers remain command targets, not chronology partitions. A native input or independent editor can opt out through the existing focused editing boundary.

Decision (2026-09-06): Forward handles remain receipt-typed; shared replay handles report status and entry identity only. Presentation callbacks belong to the participant whose action was replayed, never the surface that happened to receive Command-Z.

Decision (2026-09-06): Temporary DOM detach preserves retained owners. Final participant disposal retires a chronological prefix through its lost actions, never individual middle entries that would expose misleading older Undo. Unknown sent commands retain their exact recovery barrier.

Decision (2026-09-06): Complete the source conflict boundary in Core rather than weaken the interleaving test. Canonical source generation, restored roots, ownership, and unambiguous placement remain guarded; unrelated sibling text and semantically identical history round trips must not block Promotion Redo.

## Outcomes & Retrospective

The original native drag/Undo failure is fixed. The focused Electron test now passes the full older-input → promotion → newer-input sequence in both directions, retaining the original Block and promoted Page identities. Real Chromium tests cover rapid cross-editor capture boundaries, hidden retained semantic replay, and focus preservation without overriding a later user choice. Title and Database adapters participate in the same typed chronology. Core now guards restored content and ancestor placement instead of rejecting a semantically unchanged source solely because its revision advanced. Existing Database, structural Cut, and two-window history workflows also pass. Final validation and its isolated reruns are recorded below; no production Profile was used.

## Context and Orientation

`src/renderer/lib/surface-history/owner.ts` owns command admission, undo/redo order, bounded retention, and exact request recovery. A participant is a typed client that prepares and interprets one kind of content action. A realm is the shared interaction owner for one authority scope in one window. `src/renderer/components/board/editor/nfm-editor-history.ts` adapts body Yjs captures and durable structural operations. `src/renderer/components/workbench/database-view-mutation-history.ts` adapts Board/List semantic mutations, including Block promotion. `src/renderer/components/block-documents/collaborative-page-title.tsx` edits a canonical title Y.Text. `src/renderer/lib/document-session-registry.ts` retains document resources beyond transient React mounts. Main/Core continue owning durable commands, inverse capabilities, and recovery; no second Main history stack or schema migration is needed.

## Plan of Work

Milestone 1 generalizes the existing history owner with typed bindings. Keep one admission sequence, queue, undo/redo interval, and retention budget. Preserve standalone construction for isolated clients and tests, implemented through the same engine. Add tests combining different adapter types, local capture cutoff, origin presentation, disposal, and uncertain commands. Existing owner tests must remain green.

Milestone 2 adds `src/renderer/lib/content-interaction-history.ts` as a window-local, reference-counted registry. Connect Database participants using semantic Library/access/epoch scope, preserving View-specific admission validation. Connect retained NFM controllers using their document descriptor, and give title Y.Text a retained native participant with explicit local origins. Extend `third_party/blocknote/packages/core/src/yjs/extensions/YUndo.ts` with a pre-capture delegate callback. Ensure nested inputs remain independent and all content participants publish the same history capability.

Milestone 3 corrects `crates/nodex-core/src/library/block_transfer/promotion_history.rs`: Promotion Redo validates the restored affected forest and placement while preserving unrelated source materialization. Add Core contract tests for changed-root conflict, unrelated sibling preservation, and a semantically unchanged round trip that advances the source head. No history schema migration is intended; existing captured materialization supplies the evidence. Prove the product workflow in `tests/e2e/content-interaction-history.spec.ts`, update the narrow history/NFM/Database specifications and domain ownership statements, and perform risk-appropriate handoff checks. The Electron test must use the existing realistic mouse-drag helper and never repair focus before Undo.

## Concrete Steps

Run commands from `/Users/asc/repo/nodex`. During engine work run `vp test run --config vitest.node.config.ts src/renderer/lib/surface-history/owner.node.test.ts`. During body integration run the neighboring `nfm-editor-history.node.test.ts` and structural-history tests with that same Node configuration. Run title and View-input tests using `vitest.renderer.config.ts` where appropriate; fix any React act warning.

Once stable, run `vp run typecheck` (covers both types and lint), `vp run test`, and `vp run test:e2e tests/e2e/content-interaction-history.spec.ts`. The focused E2E command must collect exactly one test; interrupt immediately if it collects the full suite. Its build step also validates the vendored editor bundle. Run additional existing focused history E2Es only when they cover changed boundaries. Check formatting for edited files and inspect `git diff --check` before committing.

## Validation and Acceptance

The native test first types older content, promotes Blocks by real drag, and immediately presses Command-Z. Promoted Pages must disappear and original Blocks must reappear with their original IDs. Redo must recreate the same Page IDs. Later body text must undo before promotion, and earlier text only after promotion is reversed. Cross-title/body/Database unit or renderer tests must prove the same sequence and that rapid alternation does not merge typing across another action. Native drafts must keep their independent Undo. Pending and unknown outcomes must block older replay and preserve the original frozen request.

## Idempotence and Recovery

All UI evidence uses fresh seeded disposable Profiles. Never touch an already-running production window or Profile. Rerun tests with new disposable homes after failures; inspect traces rather than changing focus to hide a failure. There is no storage migration. Preserve unrelated worktree changes. Existing exact-attempt recovery remains the authority after unknown outcomes; never bypass a blocked action by choosing an older participant stack.

## Artifacts and Notes

Baseline command: `vp run test:e2e tests/e2e/content-interaction-history.spec.ts`. Build passed, exactly one test collected, expected first Undo failure. Trace is local under `test-results/content-interaction-histor-1ee94-hanges-in-interaction-order/trace.zip` and is replaceable test evidence, not a committed artifact.

Final focused native command: the same E2E invocation rebuilt Core and Electron successfully and passed exactly one test (5.9 seconds). `vp run typecheck` passed across 4,264 files with no type or lint warnings. The three new actual-editor Chromium tests pass, including Undo invoked while native drag has left focus on the document body. Core `promotion_redo` coverage passes six tests, and `library_target_promotes_and_wraps_document_roots_atomically` passes its existing scenario.

Final validation:

- `vp run test`: unit 4,902 passed, Effect/Codex 27 passed, Core client 1,064 passed, Main 1,056 passed. Renderer had 3,178 passes and three failures caused by the outliner fixture omitting its access descriptor. The fixture now satisfies `OwnedDocumentDescriptor`; its focused renderer rerun passes all three tests without React act warnings. The runner stops on a failed phase, so integration was run separately rather than claiming an uninterrupted green standard run.
- `vp run test:integration`: 40 passed, two skipped, and two unrelated timeouts (PTY and dictation). Each timed-out file passed in its own isolated `vp run test:integration <file>` rerun. No Main, preload, or shared runtime change belongs to this implementation.
- `vp test run --config vitest.browser.config.ts` with the focused title, NFM history, semantic selection and status files passes. The new `nfm-content-interaction-history.browser.test.ts` passes all three actual-editor tests, including its final unclaimed-focus case.
- `vp run test:e2e tests/e2e/content-interaction-history.spec.ts`: one passed. Existing `database-surface-history.spec.ts`, `nfm-editor-history.spec.ts`, and `nfm-editor-history-multiwindow.spec.ts` cover four more native workflows. Three passed immediately; the Database test's old reset-dialog accessible name was updated to the new content-wide contract and its focused rerun passed. All five relevant native workflows now pass, with no synthetic replacement of the Block-to-Board drag.
- Final `vp run typecheck`: no warnings, lint errors, or type errors in 4,264 files. Changed-file formatting and `git diff --check` pass. Electron E2E preparation rebuilt and verified the application.
- `cargo test -p nodex-core --lib promotion_redo -- --nocapture`: six passed. `cargo test -p nodex-core --lib library_target_promotes_and_wraps_document_roots_atomically`: one passed. Changed Rust files pass rustfmt.
- `cargo clippy -p nodex-core --lib --tests -- -D warnings` is blocked by existing contracts `large_enum_variant`; allowing that diagnostic exposes the pre-existing shared `StoreError` `result_large_err` across the Core. Changed Rust files show no other lint diagnostic. Unrelated protocol and error types were left unchanged.

No full release, signing, packaging, or pressure gate was run: the change is covered by standard suite phases, bounded Core contracts, real Chromium behavior, and fresh-Profile native Electron workflows.

## Interfaces and Dependencies

`createInteractionHistory({ scopeKey, limits?, onError? })` exposes `bind`, receipt-free `request`/`recover`, shared `snapshot`/`subscribe`, scope reset, close, and idle settlement. `bind` accepts an existing typed content adapter, optional initial captures, capture cutoff, accounting, and origin `onCommitted`. It returns typed execute/capture/retained/reconcile and participant lifetime methods. `acquireContentInteractionHistory(scope)` returns the shared owner and an idempotent release function. Scope contains `libraryId`, `accessContext`, and `storeEpoch`. Existing Yjs native replay/discard APIs and Core structural receipts remain the only content inversion implementations.

Revision (2026-09-06): Initial execution plan records the reproduced failure and the chosen single-owner implementation before integration changes.

Revision (2026-09-06 03:30Z): Record passing shared participant checks, hidden replay/focus review repairs, and the native test's newly exposed Core source-conflict boundary; extend the implementation milestone instead of narrowing acceptance.
