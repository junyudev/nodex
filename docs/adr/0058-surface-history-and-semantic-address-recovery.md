# ADR 0058: Surface history preserves gesture order across content address changes

Status: Accepted

An editor surface owns one chronological history, even though collaborative
content and structural ownership use different inverse engines. Structural
gestures reserve their place before asynchronous work; the retained editor owns
the history, and keyboard, native-menu, and programmatic commands share that
owner. A stable Block identity does not imply that a restored Block has the same
Yjs addresses, so invalidated text entries cross a guarded semantic bridge
instead of being cleared or replayed against detached content.

## Consequences

- The local engine consumes exactly the selected StackItem, including a
  no-effect result. It cannot search past a structural entry. A narrow pinned
  Yjs primitive also disposes exact unreachable items while preserving the GC
  keeps needed by other live managers over the same Document.
- A surface records affected Block fields and stable parent/sibling anchors
  alongside each local capture group. Typing materializes only affected fields;
  structural transactions scan placements without snapshotting separate owned
  Documents. This is ephemeral inverse evidence, not a second durable content
  log or a whole-Document snapshot per keystroke.
- Core's existing durable structural write fences identify invalidated
  addresses through authorized Document delivery and canonical synchronization.
  Bounded interval aggregation may conservatively fence a whole body. It does
  not discard history, grant permission, or replace content synchronization.
- Semantic replay validates the Document generation, current placement,
  affected post-state fields, forest anchors, and retained identities. It
  preserves unrelated changes and rejects ambiguous concurrent edits atomically.
  Library authority owns forest restoration and any owner consequences; generic
  Document writes cannot invoke that internal restoration operation.
- A Block created and deleted within an unsent batch may have no canonical
  registry row. Replaying that local deletion performs first registration
  through the ordinary Document writer, not a fabricated tombstone restore.
  Fresh UUID, global ownership, permanently retired identity and typed-creation
  guards still apply. Existing deleted Blocks require their exact tombstone.
- Each successful bridge yields a fresh, durable inverse recipe in the same
  transaction. Earlier entries whose addresses were rebuilt remain semantic.
  Cross-Document movement never transfers a surface's history: the source entry
  blocks while its resource is away and can resume after an authorized return.
- Before a local Document update can tombstone identities, its Provider waits
  for the surface's reachable identity set to be retained in Core. Incremental
  reference counts include changed Blocks, old/new ancestors and sibling
  anchors; ordinary typing on an already retained identity does not submit
  another set. These bounded roots protect local history before its first
  semantic bridge, without persisting a parallel content log. Adding roots
  advances LocalCommit so an older collection plan cannot race a pin. Pure
  release is durable monotonic maintenance: older evidence can only over-retain,
  so it needs no semantic event and still works after the last Project is gone.
  A terminal surface revision fences late requests, and the authenticated
  window owner releases local roots on close, proven process death or Store
  replacement. Unregistered IDs are only retention references, not reservations
  or permission to bypass canonical identity registration.
- Recipe lifecycle is Core authority, not a renderer-global index. A dedicated
  authorized projection invalidates history state; bounded capability-checked
  reads reconcile reachable tokens after delivery gaps and before replay.
  Only proven supersession removes an entry automatically. A consumed or
  unavailable token blocks earlier history unless its original uncertain
  attempt is recovering the already committed receipt.
- An uncertain attempt retains both its exact request and its original branch.
  Receipt recovery does not prepare a new Document head or make an obsolete
  inverse reachable. An authoritative non-commit rejection permits a fresh
  attempt. Actual token release advances the lifecycle projection; repeated
  release without a transition remains a no-op.
- Main owns pending structural requests and cleanup beyond the renderer's
  waiter. Each application WebContents generation has an opaque retention
  lifetime, atomically bound to new recipes and authenticated Host peer
  credentials in Core. This aggregates resource retention, never Undo order.
  Closing the lifetime fences late writes and releases only its own recipes.
  Inactivity, suspension and connection replacement are not proof of death;
  Core reclaims abandoned lifetimes only after the Host process is proven gone.
  Store replacement discards these ephemeral roots atomically.
- The reachable interval is bounded across both inverse engines. Eviction
  removes the oldest Undo prefix, then the farthest Redo future; it cannot
  leave a future action without its prerequisite. Oversized local groups also
  retire their earlier prefix instead of making an older structural action the
  next Undo. Pending inverse capabilities are handed to Main for exact outcome
  recovery before release, never revoked while the inverse may still commit.
- Database View history follows the same admission, exact-attempt and scope
  rules without inheriting Document or Yjs machinery. Scalar and manual-order
  batches compile a whole-gesture guarded inverse in Core. Active values and
  logical position anchors need no resurrection retention or durable Undo stack;
  ordinary authorized writers execute the inverse atomically. Operations without
  a complete inverse remain explicit barriers, never partial suboperation Undo.

Combining every Document into one Y.Doc would erase existing authority and
resource boundaries. Clearing history after structural edits would erase valid
user intent. Neither is an acceptable substitute for address recovery.

The behavioral contract belongs to [NFM structural editing](../product-specs/nfm-editor-structural-editing-behavior.md);
delivery and retention belong to [Document reliability](../reliability/document-sync-history-and-retention.md).
Database capabilities belong to [Database behavior](../product-specs/database-pages-and-views-behavior.md).
