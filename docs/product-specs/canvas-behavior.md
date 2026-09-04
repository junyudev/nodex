# Canvas Behavior

## Identity and placement

Canvas is a first-class document-bearing Block. It owns an independently
synchronized `canvas_scene` Document and has one exclusive Library or Page
placement. A Project's primary Canvas is only its default entry point; it is not
a Database View or a different Canvas type.

A Canvas nested in a Page appears there as one childless owner shell whose Block
ID is the Canvas ID. The shell stores no scene, file bytes, title snapshot, or
Document ID. Create, rename, move, duplicate, and delete use typed Library
operations that keep the owner, host shell, Document lifecycle, projections,
and receipt consistent.

## Access

A top-level Canvas is a grantable Library root. Each Project that can open it
has an explicit direct Canvas grant; the creator receives read-write access in
the creation transaction. A Canvas nested in a Page has no direct Canvas grant
and inherits the host Page's effective access. Moving a top-level Canvas into a
Page revokes its direct grants, while moving it back to the Library creates or
reactivates the mover's grant atomically. Access management shows inherited
Page access separately from direct Canvas access and never treats another
Project in the same Library as implicit authorization.

Every resolved Canvas Document is observed through the complete identity
`libraryId + accessContext + documentId`. `libraryId` names physical lifetime;
`accessContext` is explicitly either Library or one authorized Project. Canvas
target summaries, adapters, sessions, and receipts must preserve that identity
and must not invent a routing Project for Library access.

## Inline and Stage presentation

An inline Canvas begins as a lightweight named shell and mounts its editor only
while the owning Page surface is active and the Canvas is visible, prewarmed, or
explicitly engaged. A bounded coordinator prioritizes focused and nearby
Canvases; an evicted Canvas returns automatically without a separate Resume
state.

`Open Canvas in tab` and Library/Project entry points open the same stable Canvas
in Canvas Stage. Opening it again focuses the existing target where appropriate.
Deleted or inaccessible targets retain an explicit closable state instead of
silently opening another Canvas.

Inline and Stage surfaces share one process-local Canvas session only when the
complete authorized Document identity matches. They retain independent camera,
selection, tools, undo, and presence. Camera and inline height may persist as
local presentation preferences; they never enter the scene or host Page.

## Scene and assets

Core stores normalized current elements, durable portable app state, ordering,
and managed-file metadata. Selection, active tool, focus, viewport, and cursor
are presentation state. Separate windows converge element candidates by the
scene's deterministic version/tie-break rules; deletion is an explicit
tombstone.

Images bind a Library File and an exact immutable FileVersion in each scene-file
slot. The binding includes its frozen display name. The same File may appear in
two slots using different versions; a later shared File update or rename does
not change either slot. Creating a binding requires direct File read authority
or an exact current binding in the authorized Canvas. Canvas access exposes
only the bound bytes, not global File metadata or arbitrary versions.

Canvas image insertion publishes an independent Library File before the scene
mutation. It does not create a Page File entry. Renderer serialization accepts
only schema 2 exact bindings and reads every image through its Canvas, revision,
or recovery slot source. The active reader rejects stale in-flight bytes after
reset or authorization loss; the surface clears its binary presentation before
repairing or reopening the owner. Historical and recovery SVG previews use the
same slot-limited reads and never substitute a direct grant or current head.

Equal binding assertions are idempotent. A slot cannot be redefined to another
File or version; replacing an image creates a new slot and retargets its element.
Duplicating a Canvas preserves these bindings. Page shapes keep only a stable
target Page identity and never copy Page content or Data Source membership into
Canvas state.

## Offline work, sync, and presence

The renderer coalesces observations and persists each pending local scene
mutation to a bounded active outbox before transport. Response loss retries the
same mutation. Deterministic rejection quarantines that mutation, repairs from
canonical state, and allows later work to continue. Store-epoch or Document-
generation changes quarantine stale pending rows before retiring the old replica.
Local preservation failure keeps the window copy available for explicit export. Active and quarantined rows
are partitioned by the complete authorized Document identity, so one Library or
access context can never replay or clear another boundary's pending work.

The active outbox is capped at 256 intents and 32 MiB per authorized document;
quarantine holds up to 32 intents. Capacity failures preserve existing records
and stop the affected replica; they never evict another unconfirmed edit.
Quarantine retains the observed scene alongside the exact rejected intent.
`Unsaved edits · Review` previews those edits, safely merges compatible intents,
or creates an independent complete copy. Discard is reversible; export alone does
not resolve a draft. Conflict previews preserve the intended values even when
normal scene convergence would choose newer canonical elements. Images retain
the exact authorized version and name captured with the draft, even after shared
File updates or direct File access revocation. Removed image slots can be
reconstructed; a slot reused for another image requires a separate retained copy.
The shared
[Document recovery contract](document-sync-and-recovery-behavior.md) owns resolution,
cross-window convergence and retention.

Subscriptions begin before canonical synchronization. Main owns physical
reconnection and reports terminal lease failures explicitly; connected state is
backed by host or canonical-sync evidence. Missing or out-of-order
heads, reconnect, and completed write leases repair through one bounded full
scene. Remote updates do not enter local Excalidraw undo.

Open surfaces on the same complete authorized Document identity share
best-effort bounded cursor, selection, and active/idle presence. Presence never
crosses Library or access boundaries and never changes scene authority,
history, or offline state.

## History and maintenance

Canvas history is semantic scene history. Restore applies a new forward scene
mutation with newer element versions and explicit tombstones rather than
replacing current authority with old JSON. File bindings remain keyed by scene-file
slot in both canonical history and its retention index, so two versions of the
same File survive history capture and restore independently. Restoring an image
whose File is in Trash creates a new File for that captured version and name;
it does not untrash or update the original shared File. If a current slot has a
different binding, restoration allocates a fresh slot for the historical image.

Tombstone/file compaction may run after the last fully committed Canvas surface
closes and only after Core proves there is no active copy or pending work. It
pins a safety revision before rotating the collaboration generation. Failure to
acquire that boundary defers maintenance and never blocks close.

The deep scene-authority decisions are recorded in
[ADR 0005](../adr/0005-canvas-scene-native-sync-engine.md) and
[ADR 0033](../adr/0033-incremental-canvas-scene-authority.md). Reliability and
recovery mechanics live in [Reliability](../RELIABILITY.md).
