# Description History Revisions

Status: Active
Last Updated: 2026-03-11

This document is the detailed source of truth for Nodex's revision-based storage for card description history.

It is intentionally narrower than the main product spec. It explains how description history is stored, hydrated, migrated, pruned, and reclaimed on disk.

## Purpose

This feature exists to stop repeated edits to large NFM descriptions from exploding SQLite storage.

Before schema v21, `history.previous_values`, `history.new_values`, and `history.card_snapshot` could each inline full `description` strings. Repeated edits to one large card could therefore duplicate large text blobs many times and push the SQLite file to grow rapidly.

Schema v21 replaces that model with:
- `cards.description` as the latest fully materialized description
- `cards.description_revision_id` as the authoritative pointer to the latest revision
- `description_revisions` as the revision log
- `description_blocks` as deduplicated top-level NFM block blobs
- `history` rows that store description revision ids instead of raw description text

## Scope

Included:
- SQLite schema for description revisions
- revision encoding and reconstruction model
- history write behavior for create/update/delete/revert/restore/undo/redo
- destructive migration behavior for pre-v21 history
- pruning, revision garbage collection, and incremental vacuum behavior
- shared NFM parser/serializer extraction needed by the storage layer

Not included:
- BlockNote editor UX details
- general history panel UX unrelated to description hydration
- backup UX
- asset storage

## Design Goals

- Keep current card reads fast by preserving `cards.description`.
- Remove full-description duplication from `history`.
- Deduplicate repeated top-level NFM blocks across revisions.
- Keep undo/redo and restore semantics unchanged at the API/UI boundary.
- Keep storage bounded over time through pruning, GC, and incremental vacuum.
- Share one canonical NFM parser/serializer between main and renderer.

## Storage Model

### Materialized Current Value

Each card still stores its current description directly:

- `cards.description`
- `cards.description_revision_id`

`cards.description` remains the source used by normal board and card reads. The revision id exists so history and restoration logic can reason about description ancestry without diffing arbitrary historical JSON blobs.

### Description Block Blobs

`description_blocks` stores canonical serialized top-level NFM blocks:

```sql
CREATE TABLE description_blocks (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Rules:
- Each top-level NFM block is serialized with `serializeNfm([block])`.
- The serialized string is hashed with SHA-256.
- Identical top-level blocks across cards or revisions share the same blob row.
- Children remain inside the serialized parent block blob. v1 does not diff nested blocks independently.

### Description Revisions

`description_revisions` stores one revision row per persisted description state:

```sql
CREATE TABLE description_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  parent_revision_id INTEGER,
  kind TEXT NOT NULL,
  block_hashes_json TEXT,
  ops_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind IN ('snapshot', 'delta'))
);
```

Revision kinds:
- `snapshot`: stores the full ordered top-level block hash list in `block_hashes_json`
- `delta`: stores ordered splice ops in `ops_json`

`parent_revision_id` points to the previous revision for the same card description chain.

### History Rows

The `history` table no longer stores description text inline. Instead it stores revision ids:

- `previous_description_revision_id`
- `new_description_revision_id`
- `snapshot_description_revision_id`

The JSON payload columns remain, but `description` must be omitted from:
- `previous_values`
- `new_values`
- `card_snapshot`

## Revision Encoding

### Canonical Diff Boundary

The diff unit is the top-level `NfmBlock[]` sequence.

Why:
- Nodex descriptions are block-structured, not plain text blobs.
- Reordering/inserting/removing top-level blocks is common.
- This keeps the model simpler than full CRDTs while still saving substantial space.

Limitation:
- Editing a nested child rewrites the containing top-level block blob.
- v1 does not perform nested block-level structural diffing.

### Delta Format

Delta revisions store an ordered list of splice ops:

```ts
type DescriptionDeltaOp = {
  startOrdinal: number;
  deleteCount: number;
  insertedHashes: string[];
};
```

Interpretation:
- start at `startOrdinal`
- delete `deleteCount` existing top-level block hashes
- insert `insertedHashes` at that position

The current implementation computes these ops from the previous and next block-hash lists using an LCS-based diff.

### Snapshot Policy

Not every revision is a delta.

Nodex writes a snapshot revision when either of these is true:
- the chain since the previous snapshot reaches the checkpoint interval (`SNAPSHOT_INTERVAL = 20`)
- the serialized delta payload is not smaller than the serialized snapshot payload

This keeps reconstruction cost bounded and avoids storing deltas that are larger than the full state they describe.

## Reconstruction

To reconstruct a description for a revision id:

1. Walk parent links backward until reaching a snapshot.
2. Read the snapshot's full ordered block hash list.
3. Replay forward delta ops until the target revision.
4. Read the referenced `description_blocks`.
5. Concatenate the serialized top-level block strings with newline separators.

If a revision id is `NULL`, the hydrated description is the empty string.

## Write Behavior

### Card Create

On card creation:
- create an initial snapshot revision from the new description
- write `cards.description`
- write `cards.description_revision_id`
- write a `create` history row whose:
  - `new_values` excludes `description`
  - `card_snapshot` excludes `description`
  - `new_description_revision_id` points at the initial revision
  - `snapshot_description_revision_id` points at the same initial revision

### Card Update

On updates that do not change description:
- `cards.description_revision_id` is unchanged
- history stores normal non-description field deltas
- description revision pointers in that history row remain `NULL`

On updates that change description:
- compute the next revision from the current `cards.description_revision_id`
- update `cards.description`
- update `cards.description_revision_id`
- write an `update` history row whose:
  - `previous_values` excludes `description`
  - `new_values` excludes `description`
  - `previous_description_revision_id` points at the old description
  - `new_description_revision_id` points at the new description

### Card Delete

On delete:
- the card row is removed
- the `delete` history row stores:
  - `previous_values` without `description`
  - `card_snapshot` without `description`
  - `previous_description_revision_id`
  - `snapshot_description_revision_id`

### Revert / Restore / Undo / Redo

These flows all operate through revision ids internally.

Rules:
- if the target state changes description text, a new revision may be created
- if the operation is replaying or restoring an existing historical state, the relevant stored revision id is reused
- generic history consumers can still hydrate full descriptions when needed
- the card history overlay does not do that anymore; it reads a panel-specific display model derived from revision ids and block blobs

The renderer no longer has to pretend description revisions are ordinary field-level before/after strings.

## UI Contract

There are now two read shapes:

1. Internal/generic history reads may still hydrate the old `HistoryEntry` shape when full reconstruction is required for restore/revert-oriented flows.
2. `history:card` returns a panel-specific display model for the card history overlay.

The panel model includes:
- metadata for the history row (`id`, `operation`, timestamps, undo state)
- non-description field changes as explicit `fieldChanges`
- description updates as block-level delta entries with `added` / `removed` / `replaced` operations
- a default-collapsed full `before` / `after` description view for update entries
- create/delete description snapshots as ordered top-level block cards

For the panel model:
- `previous_description_revision_id` and `new_description_revision_id` are interpreted into top-level block change cards
- `snapshot_description_revision_id` is interpreted into ordered snapshot block cards
- full description strings are not reconstructed by default for UI display

## Shared NFM Core

Because the revision layer needs to parse and serialize NFM in the main process, the pure NFM implementation now lives in:

- `src/shared/nfm/types.ts`
- `src/shared/nfm/parser.ts`
- `src/shared/nfm/serializer.ts`
- inline/helper modules beside them

Renderer NFM modules under `src/renderer/lib/nfm/*` re-export this shared core and keep renderer-only logic, such as the BlockNote adapter, separate.

This ensures:
- one canonical parser/serializer behavior
- identical block hashing across main and renderer
- fewer parser drift bugs

## Migration Behavior

### Version Boundary

This feature ships in schema v21.

### v20 -> v21 Migration

The migration is intentionally destructive for history compatibility.

Behavior:
- existing projects and cards are preserved
- all old `history` rows are dropped
- `description_revisions` and `description_blocks` are recreated from scratch
- each existing card gets a fresh initial snapshot revision seeded from its current `cards.description`
- `cards.description_revision_id` is backfilled from that seeded revision

This is acceptable because Nodex currently has no production user data requirement for legacy history preservation.

### Unsupported Older Versions

Only supported migrations are run in app startup.

Versions older than the supported migration path still fail fast as unsupported, per the general reliability model.

## Pruning And Garbage Collection

### History Retention

The existing count-based history retention policy remains the only retention knob.

When history pruning removes old rows:
- old history rows are deleted first
- reachable description revisions are recomputed from:
  - all current `cards.description_revision_id` values
  - all retained history revision-pointer columns
- unreachable `description_revisions` rows are deleted
- orphaned `description_blocks` rows are deleted afterward

There is no attempt to preserve revisions that are only reachable from already-pruned history.

### Redo-Stack Clearing

Clearing undone history entries also triggers description revision GC, because those entries may be the last references to some revisions.

## Disk Reclamation

### Auto Vacuum Mode

Nodex now sets:

```sql
PRAGMA auto_vacuum = INCREMENTAL;
```

and applies:

```sql
VACUUM;
```

when switching into that mode during migration or fresh schema bootstrap.

### Why `INCREMENTAL` Instead Of `FULL`

`FULL` auto-vacuum would try to reclaim free pages on every commit, which is a worse tradeoff for a write-heavy local SQLite app:
- more page movement
- more commit overhead
- greater chance of fragmentation side effects

`INCREMENTAL` is the intended compromise:
- free pages are tracked automatically
- reclamation happens deliberately after prune/GC work
- normal writes stay cheaper than `FULL`

### Opportunistic Reclamation

After history pruning or redo-stack deletion removes history rows and GC removes unreachable revisions/blobs, Nodex runs:

```sql
PRAGMA incremental_vacuum;
```

This reclaims free pages gradually instead of requiring frequent full-file rewrites.

Important consequence:
- disk space may shrink over time rather than immediately after every delete

## Invariants

These invariants should always hold:

- `cards.description_revision_id` is `NULL` only if the card has no tracked description state; normal created cards should have a non-`NULL` revision id
- `cards.description` must reconstruct exactly from `cards.description_revision_id`
- `history` JSON payloads must not inline `description`
- any history row that semantically references description state must use one of the description revision id columns
- deleting history rows may make revisions unreachable; pruning code must run revision/blob GC
- identical top-level serialized blocks must hash identically across main and renderer

## Known Limitations

- Nested edits rewrite the containing top-level block blob.
- Revision reconstruction still requires walking a chain, though snapshots bound the cost.
- Because old history is dropped at v21 migration, there is no legacy compatibility path for pre-v21 history inspection.
- `cards.description` is still fully materialized, so the latest card state itself is not compressed in-row; only the history path is compacted.

## Testing Requirements

Coverage for this feature should include:
- stable canonical NFM serialization for hashing
- deduplication of identical block blobs
- snapshot-vs-delta selection
- exact reconstruction from snapshot + delta chains
- hydrated history reads exposing full descriptions
- undo/redo/revert/restore correctness for description changes
- destructive v20 -> v21 migration behavior
- GC of unreachable revisions and orphaned block blobs

## Related Documents

- [Main product spec](./nodex-product-spec.md)
- [Reliability](../RELIABILITY.md)
- [Notion-flavored Markdown spec](../references/notion-flavored-markdown-spec.md)
