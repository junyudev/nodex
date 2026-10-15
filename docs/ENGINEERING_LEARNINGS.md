# Engineering Learnings

This document is Nodex's compact engineering memory. It records only
cross-cutting lessons that are expensive to rediscover and cannot be made fully
obvious or enforceable in code. It is an explanation and routing layer, not a
second product specification, protocol reference, incident log, or configuration
file.

Detailed behavior belongs with the module that owns it. Use the
[source-of-truth map](#source-of-truth-map) before adding material here.

## Admission rule

A learning belongs here only when most of these are true:

1. It is non-obvious even to a maintainer familiar with the affected library.
2. Forgetting it can cause data loss, security exposure, architectural drift,
   or a costly cross-module regression.
3. It applies across more than one call site or module.
4. It is likely to remain true after dependency and UI revisions.
5. Types, tests, lint, or a local code comment cannot enforce it completely.

If a fact is local, version-specific, or already executable, protect it at the
nearest seam instead:

- product behavior and interaction contracts go in `docs/product-specs/`;
- architecturally significant choices and rejected alternatives go in an ADR;
- durability and recovery rules go in `docs/RELIABILITY.md`;
- cross-feature renderer construction and testing conventions go in `docs/FRONTEND.md`;
- release and toolchain compatibility goes in the relevant runbook;
- dependency quirks go beside the Adapter and its behavioral regression test;
- one-off fixes that are fully covered by tests need no permanent prose entry.

Do not append debugging chronology, exact CSS values, dependency Interface facts, or
one heading per protocol notification. Git history already preserves the
incident; the current document should preserve the enduring model.

## Core principles

### 1. One state has one visible authority

Several modules may retain caches, recovery state, or read models, but only one
may decide what the user sees at a time. Codex's active renderer owner reduces
live conversation state; followers mirror owner publications, and main-process
snapshots are limited to named cold-load, recovery, and no-owner transitions.
Likewise, an active Card's title/body comes from its owned Document, not from a
Card projection or metadata draft.

A second reducer often looks harmless because a later snapshot repairs the
result. In a streaming or collaborative system it instead races partial state,
changes ordering, and makes the next valid patch target the wrong base. When
ownership changes, invalidate routing, semantic role, revision, pending queues,
and recovery state together.

See [Codex owner/follower streaming](product-specs/codex-thread-owner-follower-streaming.md)
and [Block identity](adr/0001-block-identity-card-alias.md).

### 2. Authority, read models, and UI projections are different things

Authority accepts intent and determines truth. A read model makes that truth
cheap to query. A UI projection decides how it is presented. Information flows
from left to right and never returns through the same path as a write:

| Domain               | Authority                                                       | Read model or projection                                |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Block content        | Yjs `block_tree` or normalized `canvas_scene` Document          | NFM, title, preview, search, assets, Card detail        |
| Database capability  | relational Database membership, properties, and Views           | Board rows, Calendar occurrences, Database View results |
| Codex conversation   | generated protocol items/requests plus explicit app-local state | transcript entries, activity groups, summaries          |
| Scheduled automation | `automation.toml`                                               | SQLite mirror and renderer detail                       |
| Review changes       | Git/file metadata and validated content                         | file tree, patch rows, summary counts                   |

This resolves an important retired ambiguity: `Card.description`, Card summaries,
and metadata overlays are projections. They never seed, refresh, or save a
mounted title/body editor. A Card's owned Document identity also does not choose
its sync engine; the registered schema and engine do.

See [Architecture](ARCHITECTURE.md), [Reliability](RELIABILITY.md), and
[Database Pages and Views](product-specs/database-pages-and-views-behavior.md).

### 3. Streaming is an ordered transaction, not a set of callbacks

Deltas, server requests, lifecycle completion, ACKs, disconnects, replay, and
React publication form one ordered event system. Buffer notifications and
requests in their arrival order; make coalescing preserve every covered sequence;
ACK only the contiguous prefix whose visible effects are durable or accepted;
and drain prose before terminal lifecycle state.

An event that produces no visible row can still be an ordering marker. React
may also batch two correctly ordered external-store mutations into one visible
commit, so workflows that require an intermediate render must establish and
test that publication seam explicitly.

### 4. Recovery is an explicit state transition

Resume, replay, rollback, cold hydration, owner replacement, and no-owner
fallback have different preconditions and outputs. A generic catch block must
not pull a source-null snapshot over live partial state. Failed resume discards
its provisional buffer; successful resume deduplicates buffered tails against
hydrated state before publication.

Name every recovery ingress and test both response-before-notification and
notification-before-response orderings. If an ingress cannot prove its owner,
revision, epoch, generation, or exact head, fail closed and reacquire authority.

### 5. Project semantics once; render them many ways

Canonical protocol or domain state should be projected through one exhaustive,
typed module before leaf rendering. That module owns zero/one/many row policy,
visibility dependencies, grouping, stable identity, completion, and request
state. UI modules render the resulting model; they do not rescan raw values to
guess “final assistant,” “active,” “blocking,” “exploring,” or tool identity.

Visibility and grouping are separate decisions. Summary inputs and disclosure
bodies are separate projections. A hidden item may still own turn state, and a
single canonical item may own several display rows. Incremental projection must
therefore include every dependency affected by lifecycle or ordering changes,
not only the raw object whose reference changed.

See [Codex transcript behavior](product-specs/codex-thread-transcript-behavior.md).

### 6. Preserve identity domains across seams

Protocol identity, domain identity, persistence identity, and render identity
are not interchangeable. Preserve the original type and value until the seam
that truly needs another representation:

- a Card ID is its stable Block ID, never a Yjs struct ID or Database row copy;
- a protocol `RequestId` remains `string | number`; DOM keys may stringify a
  type-tagged form, but replies and matching use the original scalar;
- nullable app-local turns use canonical occurrence identity rather than a fake
  protocol turn ID;
- raw Codex item identity remains separate from projected row and timeline IDs;
- route-shell, Project-session, content-Project, and app-server thread IDs stay
  distinct even when one UI surface carries all of them.

Identity conversion should happen once in a named Adapter. Reconstructing a
lookalike object at a snapshot or protocol seam hides missing fields and creates
a second contract.

### 7. Semantic lifetimes outlive visual attachments

An EditorView, React subtree, xterm container, webview toolbar, or floating menu
is a DOM attachment, not necessarily the owner of undo, provider, navigation, or
gesture state. Preserve the semantic owner across harmless remounts and make
real teardown explicit and idempotent.

For collaborative editors, one mounted surface owns its local Yjs origin and
UndoManager; temporary editability changes must not remount the EditorView or
destroy nested participants. A provider that accepted a flush/freeze lease may
need to finish headlessly after visual teardown. Hidden retained surfaces must
not remain candidates for global pointer arbitration or own a terminal runtime.

See [renderer view-state ownership](product-specs/renderer-view-state-ownership.md)
and [Frontend](FRONTEND.md).

### 8. Keep high-frequency work out of broad owners

Virtualization reduces DOM work, not upstream projection work. Token deltas,
PTY bytes, pointer movement, transcript search, and wide Card bodies must not
flow through `WorkbenchShell`, an all-conversation renderer reducer, or an
Electron-main hot path.

Subscribe by stable surface slice, project one visible turn at a time, use
summary read models for boards, keep content indexing and heavy parsing in
workers or bounded modules, and let xterm or imperative geometry layers consume
their own streams. The performance goal is locality: an update should wake only
the surface that can display it.

### 9. Drag and drop has one target model

The visible indicator, target arbitration, and committed mutation must use the
same semantic target and coordinate space. In nested surfaces exactly one
eligible owner renders feedback and handles the drop. In list reordering, derive
and render the insertion slot in the post-removal “remaining items” space, then
translate it once to the persistence contract.

Cross-parent Block movement is a stable-ID domain operation, not serialized DOM
or NFM transfer. The side menu establishes the exact source selection; one
window-local coordinator carries disposable gesture state; and one idempotent
`BlockTransfer` commits the result. Do not combine insertion-slot feedback
with sortable live reflow.

See [Board drag and drop](product-specs/board-drag-and-drop-behavior.md) and
[renderer view-state ownership](product-specs/renderer-view-state-ownership.md).

### 10. Collaborative durability requires exact retry seams

Durable acknowledgement means the complete authority transaction committed.
It is not evidence that bytes were received or that a causal summary resembles
the expected state. Yjs state vectors describe causal content, not byte identity,
delete-set idempotency, dependency closure, or a content checksum.

Keep immutable receipts after update payload compaction, bind retry identity to
canonical intent, reject unresolved dependencies, and validate the resulting
schema/global identity set before advancing a head. Store epoch and Document
generation prevent stale outboxes or caches from crossing restore/replacement
lifetimes. Canvas uses its own exact scene request/outbox contract rather than a
fabricated Yjs model.

See [Reliability](RELIABILITY.md) and
[Document-bearing Blocks](adr/0002-document-bearing-blocks-yjs.md).

### 11. Validate at external seams; keep normalized state ordinary

HTTP, IPC, persisted JSON, protocol recovery, file input, and untrusted tool
results need bounded validation before they enter internal state. Once data has
crossed that seam, reducers and projectors should consume the typed form rather
than repeatedly parsing `unknown` records or accepting alias fields.

Validate bytes before expensive diff, Markdown, image, or archive parsing.
Resolve user-supplied logical names to current server-side identities in the
same mutation that uses them; client lookup followed by mutation creates a
TOCTOU race. Rejected input must not partially mutate authority or produce a
misleading empty UI shell.

### 12. Reproducibility includes the whole artifact closure

Pin Node, pnpm, runner images, and relevant build conditions. Native addons are
ABI artifacts of the runtime they were rebuilt for; Electron-targeted binaries
must be tested through Electron's embedded Node, not a similar host Node.
Bundled native CLIs include required sibling executables and search-path tools,
not only the primary binary.

Release publication is a transaction: package and validate every target before
creating irreversible version/tag state. Verify the artifact that is actually
signed and notarized. Keep version-specific runner, Icon Composer, signing, and
packaging constraints in [the macOS release runbook](release-macos.md), where
they can carry current versions and recovery steps.

### 13. Static-analysis output is an agent Interface

Lint, formatting, and type checks are a feedback API for both people and coding
agents. Optimize that API for one semantic authority, broad and predictable
coverage, short feedback loops, actionable remediation, and a near-zero accepted
warning baseline. Hundreds of non-blocking diagnostics are not extra safety: they
consume context, hide new regressions, and teach callers to ignore the tool.

Use generic rules where they reliably detect correctness problems. Encode stable
project boundaries and repeated agent mistakes as focused, tested rules or
structural checks whose messages name the approved replacement. Promote only
high-confidence invariants to errors; scope, baseline, repair, or disable noisy
heuristics deliberately instead of relying on `--quiet`. When two tools can emit
the same semantic diagnostics, choose and document one authoritative path, then
test that dependency upgrades preserve it.

## High-risk implementation caveats

These details remain here because they cross several modules and have produced
expensive failures. Their exact implementation belongs beside the named seam.

### Register cancellation before asynchronous preflight

A cancellable operation must enter its operation-ID registry synchronously at
the public Interface, before its first `await`. Carry one `AbortSignal` through
preflight and every child process, and let final settlement own cleanup.
Otherwise cancellation can report failure while the mutation starts moments
later. Test immediate cancellation separately from the real process Adapter.

### Browser-managed editable DOM needs one owner

During native input and IME, the browser directly mutates contenteditable DOM.
React must own the host and surrounding controls, while a dedicated editor
Adapter owns editable children and reconciles canonical state outside
composition. Read operation intent from native `beforeinput` when required;
React's compatibility event is not guaranteed to expose `InputEvent.inputType`.

ProseMirror-managed DOM is also read-only to application code. Express custom
state through schema, decorations, plugin state, or overlays outside its managed
tree; direct attributes will be removed by reconciliation.

### Visible global UI must not wait for a passive listener

An overlay that becomes visible before its outside-pointer, resize, or keyboard
listener is installed has a real interaction gap. Subscribe for the mounted
lifetime, read current phase/callback state through React's effect-event pattern,
and guard inactive phases inside the handler. For async search and suggestion
UI, bind every actionable row to the query that produced it; never execute a
selection against stale rendered results.

### Runtime capability detection happens at call time

Renderer modules can be imported before Electron preload installs `window.api`.
Do not cache transport capability at module evaluation; inspect it inside the
public call. Main-process fanout must also treat disposed renderer frames as an
ordinary lifecycle race, not as an exceptional retry loop.

### Tests cross the same seam as production

Prefer behavioral tests at the public Interface. Mock only a feature-local
Adapter, not broad shared entrypoints, and restore timers, DOM constructors,
globals, and mutable singletons after each test. Low-level native events require
async `act` and an awaited observable outcome. Main-process tests must set and
initialize a suite-owned temporary `NODEX_HOME`; a supposedly pure helper must
never lazily open the developer's store.

When a flake appears only in CI, reproduce the exact commit, test project,
runtime image, and execution order before changing production code. Use seeded
real-app review for integrated visual evidence and focused renderer or Chromium
tests for isolated behavior. Tests should protect behavior, not Tailwind
strings or SVG paths.

### A gate is evidence only after it has failed

A performance or acceptance comparator proves nothing until a deliberate
regression makes it fail. Compare like-for-like samples, derive any noise
allowance from their spread, and cap it below the smallest regression that
matters. Lazy processes and caches need a launched-app check as well: unit tests
show each start path is conditional, but only the whole app shows who actually
starts them, so record the caller at the start seam when an unexpected start
appears.

### Trace reachability before trusting names

A retained UI module, selector, fallback, test ID, or helper is not evidence
that production reaches it. Trace the active feature gate, owner call site, and
returned model before documenting or fixing behavior. When framework-owned DOM
or lifecycle state changes unexpectedly, identify who owns the mutation before
changing how the local code responds.

### State-writing callback refs require stable identities

React detaches and reattaches a callback ref when its function identity changes.
If a composed ref includes an inline state-writing callback, cleanup can write
`null`, attachment can write the DOM node, and the resulting render can create a
new ref identity that repeats the cycle. The characteristic failure is
`dispatchSetState -> setRef -> Array.map -> setRef`, ending in `Maximum update
depth exceeded`.

Treat drag state, registration churn, Strict Mode, and an open floating surface
as trigger pressure, not automatically as the leaf defect. Close unstable ref
loops in the overlay dependency tree first. Then keep gesture-time droppable
identities stable, memoize multi-owner refs, and preserve a stable sortable host
around any deliberately keyed interaction child. Dismissing a tooltip inside
`onDragStart` is only timing mitigation because it joins the same synchronous
update burst.

For lane-aware sidebar project drops, keep one physical project registration
(`project:<id>`) for the whole gesture and resolve the semantic pinned or regular
destination only when evaluating policy or dispatching the drop. Encoding the
source lane in the droppable id makes every project ref detach and reattach at
drag start even though none of the project DOM nodes changed.

Test this class of failure in Chromium with real mounted overlay content and the
full gesture tree, failing on page and console errors. jsdom cannot prove
callback-ref commit behavior, and source-string checks do not prove that the
runtime dependency graph carries the fix. Radix documents the React 19 failure
mechanism and stable-setter repair in
[radix-ui/primitives#3967](https://github.com/radix-ui/primitives/pull/3967).

### Continuous geometry stays outside owner React state

ResizeObserver dimensions and pointer-resize samples are visual signals, not
application state. Feed them into stable shared observers and MotionValues,
derive dependent sizes in the same graph, and bind those values directly to
motion elements. Project into React state only when a guarded semantic value
changes, such as a breakpoint class, layout mode, or boolean capability. This
keeps unrelated authoritative updates from synchronously replaying geometry
state writes during the commit phase.

An Effect Event is not a stable dependency token: React intentionally gives the
function returned by `useEffectEvent` a new identity on every render. Call it
from an Effect, but never list it in that Effect's dependencies. Enforce this at
the shell/geometry boundary with the official hooks lint rules; a post-commit
measurement loop is too expensive to rediscover through runtime testing alone.

## Source-of-truth map

| Topic                                                                                                              | Authoritative document                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| System modules, dependency flow, authority table                                                                   | [Architecture](ARCHITECTURE.md)                                                    |
| Domain language and invariants                                                                                     | [Context](../CONTEXT.md)                                                           |
| Significant design decisions and tradeoffs                                                                         | [ADRs](adr/)                                                                       |
| User-visible behavior and public contracts                                                                         | [Product specifications](product-specs/index.md)                                   |
| Codex owner/follower ordering and recovery                                                                         | [Owner/follower streaming](product-specs/codex-thread-owner-follower-streaming.md) |
| Codex transcript, request, activity, and composer projection                                                       | [Transcript behavior](product-specs/codex-thread-transcript-behavior.md)           |
| Thread Summary sections, artifacts, Git actions, Browser, and PiP                                                  | [Thread Summary panel](product-specs/thread-summary-panel-behavior.md)             |
| Scheduled task/template route, drafts, runs, and navigation guards                                                 | [Scheduled route](product-specs/scheduled-route-behavior.md)                       |
| Settings routes, catalog, search, composition, and deep links                                                      | [Settings route](product-specs/settings-route-behavior.md)                         |
| Block/Owned Document durability, sync, backup, recovery                                                            | [Reliability](RELIABILITY.md)                                                      |
| Core selection, generation recovery, and Store migration policy                                                    | [Core lifecycle and Store](reliability/core-lifecycle-and-store.md)                |
| LocalCommit delivery, projection freshness, and visibility                                                         | [LocalCommit and projections](reliability/local-commit-and-projections.md)         |
| Document/Canvas sync, semantic history, and retention                                                              | [Document sync/history](reliability/document-sync-history-and-retention.md)        |
| Whole-Store backup, restore, replacement, and maintenance                                                          | [Backup/restore](reliability/backup-restore-and-maintenance.md)                    |
| Cross-feature renderer construction, state ownership, shared UI/editor primitives, and UI verification conventions | [Frontend](FRONTEND.md)                                                            |
| Board and cross-surface drag behavior                                                                              | [Board drag and drop](product-specs/board-drag-and-drop-behavior.md)               |
| NFM side-menu interaction                                                                                          | [NFM block side menu](product-specs/nfm-block-side-menu-behavior.md)               |
| Workbench ownership and navigation                                                                                 | [Workbench shell](product-specs/workbench-shell.md)                                |
| Review/file-change UI                                                                                              | [Review right panel](product-specs/review-right-panel-behavior.md)                 |
| Command-palette indexing and navigation                                                                            | [Command palette](product-specs/command-palette-behavior.md)                       |
| Local validation and runtime selection                                                                             | [Development](development.md)                                                      |
| macOS build, signing, notarization, and recovery                                                                   | [macOS release CI](release-macos.md)                                               |
| Security seams and hardening                                                                                       | [Security](SECURITY.md)                                                            |

When two documents appear to disagree, authority follows this order: accepted
ADR and current domain invariants for architecture, product specification for
user-visible behavior, reliability/security documents for their operational
contracts, then this distilled explanation. Fix the narrower authority and
update or delete the stale summary here; never preserve both versions as
“learnings.”
