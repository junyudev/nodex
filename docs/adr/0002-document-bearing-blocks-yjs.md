# ADR 0002: Document-bearing Blocks use explicitly registered Yjs Documents

- Status: Accepted
- Date: 2026-07-11; amended 2026-07-13
- Owners: Nodex maintainers
- Scope: Accepted for `block_tree`; its proposed Canvas/Yjs extension is superseded by ADR 0005

## Current applicability

ADR 0017 renames the document-bearing Page to Page and replaces Space content
ownership with Library ownership. The explicit per-owner Document and Yjs-root
decisions remain current; Project is only a presentation/execution coordinate.

## Context

The legacy Page editor serializes a whole BlockNote document to NFM, debounces the snapshot, and later replaces editor content when another window's Page snapshot arrives. Two windows therefore edit separate snapshots rather than one shared causal document. A later full save can overwrite an earlier save, and deferring external replacement merely delays the conflict.

Making every paragraph an independent collaborative Document would produce excessive provider, persistence, loading, and undo overhead. Conversely, placing every Page body in one Space-wide Y.Doc would couple unrelated loading, retention, permissions, history, and failure domains.

## Decision

Every Page owns exactly one explicitly registered Yjs Document. It has two named roots:

- `Y.Text("title")`
- `Y.XmlFragment("body")`

These are the complete named-root set; hidden extra shared roots are invalid. The body owns one canonical BlockNote root `blockGroup`. Every active BlockNote-backed Document contains at least one registered application Block because the editor schema requires `blockGroupChild+`; semantic blank is represented by one stable-ID empty paragraph and projects to blank NFM/plain text. The NFM syntax parser remains policy-free and may return zero Blocks. Document genesis, whole replacement, and a patch's final whole-body result normalize that empty forest to the stable editable shape; Fragment insertion instead rejects an empty forest and requires `<empty-block/>` for an intentional empty Block. A first root-level insertion into a semantic blank promotes the seed ID into the first content Block through a write-fenced update, rather than deleting it or exposing it as an extra empty Block. Genesis allocates the seed identity before durability, prepare idempotently repairs historical zero-Block Documents through the sole SQLite writer, and mutation/relocation boundaries cannot leave an active Document empty. Renderer-created placeholder IDs are never authority.

Title and body therefore participate in the same causal history and durable update stream. Ordinary paragraphs, headings, lists, and media are stable-ID Blocks inside the nearest Page's body fragment; they do not each own a Y.Doc.

Only selected document-bearing Block types own independent Documents: Page, Synced Block sources, Reusable Template sources, and Canvas. This ADR governs the Yjs `block_tree` owners; ADR 0005 governs Canvas's `canvas_scene` engine. Promotion, instantiation, and ownership changes are explicit transactions; content size never promotes an ordinary Block.

A Synced Block source is a system-managed document-bearing Block with schema `nodex.synced-block@2`. Its Y.Doc has only `Y.XmlFragment("body")`; it must not manufacture a Page title root. Every visible occurrence is a childless `syncedBlockRef` that stores only `sourceBlockId` and lazy-mounts the source's independent surface. Nodex deliberately uses a library-source model: the source Block has a real Library placement so its relational location is total, but normal Page/Database/top-level navigation does not present it as another Page. Exact owner lookup, reference expansion, history, search materialization, and maintenance may address it. The original promotion location becomes the first reference; this hidden source placement is product policy, not an accidental extra Page.

Promotion moves the original subtree's application Block IDs into the new source Document, creates a new UUID-v7 reference identity at the host location, and commits both Documents/registry/evidence atomically. Copy allocates fresh UUID-v7 IDs for the source body. Demotion is allowed only when exactly one current reference can be proven from exact-head projections. It requires one lease covering both host and source heads, relocates the source roots back with their existing IDs, leaves the source Y.Doc at a durable empty head/projection, and tombstones the source resource and reference in the same SQLite transaction. Typed deletion and physical GC must pass the same exact-head reference scan and reject any source with a live reference.

The schema registry dispatches on content model and sync engine. Page, Synced Block, and Reusable Template use `block_tree` with `yjs`; Canvas uses `scene_graph` with `canvas_scene`. BlockNote/NFM code requests the block-tree Adapter explicitly and fails closed for another content model, so Canvas is never forced into a fake title/body tree or Yjs root set.

Every body-only `block_tree` owner reuses one exact-root primitive rather than maintaining per-type `body` validators. Synced Block and Reusable Template Documents have no title root.

A Reusable Template source is a library Block with an authoritative display name in intrinsic Block properties. A visible `templateRef` is childless and may retain a disposable display hint only. Instantiation is copy-on-apply: it fences the exact source and target heads, recursively allocates fresh application IDs, and inserts the copied subtree through the normal stable-ID Document operation path. Existing instances do not remain linked. Exact-head reference scanning rejects lifecycle deletion/GC while any live reference remains. Template content currently rejects nested document-bearing owner shells because a correct deep copy would also need to allocate and atomically create their owned Documents.

Document ownership follows product semantics rather than storage size. A long-form document is a Page, including when nested inside another Page. Code remains an ordinary `codeBlock` inside its nearest owning Document. Loading, caching, compaction, and viewport virtualization may vary with size, but those policies cannot change Block type, identity, ownership, collaboration, or NFM syntax. A future independently owned code artifact would require a separate ADR proving lifecycle and product behavior beyond “large code.”

The registry is relational (`documents` and `block_documents`). Nodex does not use Yjs subdocuments for ownership: providers still synchronize subdocuments as independent entities, while explicit registration makes loading, persistence, cache invalidation, and access checks visible in the Nodex domain.

SQLite is the local durable authority. `document_updates` stores the compactable binary Yjs replay tail, `document_update_receipts` permanently retains update identity/request hash and committed sequence, and `document_snapshots` stores verified operational full states. A provider acknowledges only after durable commit. An update that still has unresolved Yjs struct/delete dependencies after tentative application is rejected for retry rather than persisted. Yjs state vectors drive synchronization; SQLite `headSeq` is only a persistence freshness sequence. Independent hashes protect each exact retained update and snapshot blob, while reconstructed state is validated semantically through contiguous replay, dependency closure, state-vector equality, schema decoding, and exact materialization agreement. Later full-state re-encodings are not canonical, so their digests are never persisted or compared as identity.

Each mounted writable surface creates a distinct Yjs client identity, even for two windows owned by the same user. `Y.UndoManager` tracks only local transaction origins for that surface, so remote edits are not undone locally. Awareness carries cursor/presence keyed by client session and window but is never persisted as content.

Ordinary editor transactions carry no trusted structural command metadata. The
writer derives direct node, parent, and sibling-order effects from the canonical
before/after Block trees; renderer-reported touched IDs remain diagnostics only.
An acknowledged removal of an ordinary Block records generation- and
placement-revision-bound authority for that Document so a later causal local
undo may restore the same identity. That evidence cannot reactivate a retired
identity, cross a Document authority or generation, or stand in for an explicit
cross-authority relocation.

NFM is limited to genesis import, explicit compare-and-swap replacement, export, and materialized projection. `blocksToYDoc`-style conversion is permitted only for genesis. An existing collaborative Document is loaded from snapshot plus updates and is never reconstructed from NFM.

Whole-body replacement and checkpoint restore create a Document-wide durable
barrier. Any stale Yjs update based before that barrier is preserved as recovery
work rather than merged, even when its apparent Block IDs are disjoint; a
block-scoped semantic fence remains merge-friendly only when applying the
update to both its retained base head and the current head proves it unrelated.
If the base head is no longer reconstructible, the writer preserves the update
as recovery work instead of trusting incomplete client metadata.

## Consequences

Concurrent title and body edits merge through Yjs instead of competing whole-Page snapshots. Loading, undo, cache, compaction, and failure scopes align with the surface a user opens. Expanded references can mount a target Page's independent provider without copying foreign content into the host Y.Doc.

The renderer needs a transport-neutral `NodexYProvider`; Electron carries binary updates through IPC and browser clients use binary POST plus SSE fanout. Both transports must share handshake, durable acknowledgement, retry, deduplication, epoch, and generation semantics.

The writer must tentatively apply and validate updates before one SQLite transaction appends the update, advances the head, updates Block registry/materialized indexes, and records change history. A rejected update invalidates the tentative cache and reloads from durable state.

## Alternatives considered

Whole-NFM last-write-wins snapshots cannot merge concurrent intent. A Space-wide Y.Doc makes unrelated Pages one loading and failure domain. One Y.Doc per paragraph creates needless synchronization overhead. Yjs subdocuments hide no provider complexity and weaken explicit product ownership. Size-based Document types are also rejected because they turn an implementation threshold into durable product identity and duplicate Page and `codeBlock` semantics.
