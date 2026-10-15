# ADR 0057: Library Files and Page relations

- Status: Accepted
- Date: 2026-09-04
- Supersedes: the Page ownership, exclusive rehome, and owner-closure copy rules in [ADR 0051](0051-page-owned-files-and-immutable-bytes.md) and [ADR 0052](0052-file-placement-is-independent-of-ownership.md). Their immutable-byte and canonical-Document principles remain valid.

## Context

A file can be useful before it appears in a Page, and the same file can appear in several Pages. A single owner Page makes the file's availability, path, history, and lifetime depend on an incidental presentation location. Moving the last image occurrence then becomes an ownership transfer across two manifests, even though neither its identity nor its bytes changed.

Page paths also describe how a particular Page organizes its references. They do not describe the File itself. Treating a path rename as a content version mixes independent concurrency boundaries and makes sharing difficult to explain.

## Decision

The Library Module owns File identity. The Profile owns its physical byte storage. A File is a first-class Library resource; it is not a Block and has no Block placement or owner Page.

Every File has a stable ID, a nonunique portable default name, an independently advancing metadata revision, a lifecycle, and a head pointing to an immutable FileVersion. A FileVersion records exact Blob bytes, MIME type, byte length, and creation provenance. Content hashes may share physical bytes across versions and Files, but never merge File identities.

A Page has two independent ways to use a File:

- An explicit PageFileEntry assigns a portable logical path to a File. The relation is unique by Page and File, and paths form a collision-free portable namespace within that Page.
- A canonical Document occurrence references `nodex://files/<file-id>` directly. It does not require an explicit entry or a generated path.

Page Files is the deduplicated union of these relationships. Body occurrence counts and explicit paths remain Page-local. Removing an entry changes only the relation; removing an occurrence changes only the Document. Moving or copying Blocks, promoting Blocks to Pages, and copying Pages preserve File IDs. Explicit entry transfer operates on the two Page manifests and never changes File content or global metadata.

Entry batches validate their final namespace, so paths can be exchanged without temporary names. Explicit paths are reserved before suffix allocation. Each changed Page manifest advances once; a copied source remains unchanged. Import and local replacement consume prepared bytes, create the File and write the relation atomically. A conflict leaves all of those resources unchanged.

Updating a shared File requires an explicit File write with a revision/head precondition. Replacing one occurrence or entry creates a new File and retargets only that relationship. Global replacement must remain compatible with existing media occurrences. Renaming a Page path, renaming the File's default name, and replacing bytes use their respective relation, metadata, and content concurrency boundaries.

## Identity and lifecycle

The current authenticated Profile has full access to its Library Files. Project
is routing metadata rather than a content permission boundary. Core validates
File identity, lifecycle, exact retained source and revision preconditions.
Current Page uses follow the File head; Canvas and historical sources preserve
their exact captured versions and names. File IDs, hashes and physical paths do
not expose Profile storage paths or replace connection authentication.

Structural persistence receives canonical File IDs proven by its source or
clipboard snapshot. Whole-Page clipboard copies preserve captured Page paths
and shared File identities. Retention keeps detached snapshot sources alive.
File changes publish canonical File effects and invalidate affected current
presentations without coupling File lifetime to a Project.

## History and retention

Yjs Document snapshots bind each referenced File to an exact content version and frozen display name. Restoring a Document is a forward write. It reuses a live File only when the current head and default name still match the snapshot; otherwise it forks the retained target once per source File and remaps the restored occurrences. It never rolls back the shared File used elsewhere. Independent Page entries are not part of title/body history restoration.

Snapshot hashes and automatic history coverage include exact File bindings.
The canonical snapshot owns these facts; its query/retention index must agree
with its hash, target count, versions, and names. Legacy snapshots without exact
bindings remain explicitly unresolved and cannot silently restore current bytes.
Historical presentation reads return their frozen target rather than current
File metadata. A restore publishes File and Document effects in the same durable
commit; replay cannot produce another fork.

Canvas slots bind exact File versions and frozen names in their canonical scene.
The historical retention index keeps the slot coordinate as well as the File ID,
so one Canvas can retain several versions of the same File. Current and historical
Canvas reads validate that exact slot. A live File can be reused at its fixed
version even when its head has advanced; Canvas restoration does not reinterpret
its bindings as ordinary head-following body occurrences. Trashed targets fork
once per distinct File/version/name, preserving multiple old versions without
changing the original File's lifecycle. Occupied slots with different bindings
receive new scene slot identities during an explicit forward history restore.

Retained Canvas drafts freeze each captured slot at acceptance. Recovery can
reconstruct a removed slot from that exact target. A slot reused for another
binding cannot redirect retained image intents; the complete retained scene
can still be saved as a copy. File and Canvas creation effects share one Library
event, and all recovery effects share one durable operation.

Retained Yjs drafts freeze their captured File targets when Core accepts the
package. Recovery first preserves the retained causal merge and then remaps
File occurrences. Copying a recovered Page composes File and Page effects into
one Library event; it does not invent another operation identity for part of
the same recovery.

A live File remains retained even when unused. Trash is explicit and has no automatic expiry. Current and recoverable Page/Canvas relationships prevent trashing. Retained historical and recovery targets can outlive current use and prevent permanent deletion. File versions remain retained while the File exists. Permanent deletion retires the File ID; physical Blob collection follows all durable roots and cannot be inferred from Page usage counts alone.

Submitted conversation attachments retain immutable bytes independently of their
source File. Thread-owned Blob roots survive removal from a queue and release
when the Thread is deleted. This preserves the submitted input without keeping
an otherwise disposable File identity alive. Attachment reads require the owning
Thread identity in the authenticated Profile; a Blob hash exposes no host path.

File usage queries page current and recoverable Page/Canvas owners throughout
the Library. Loaded windows are not complete impact totals. Lifecycle conflicts
preserve retention constraints. SQL retirement guards retain every immutable
version while its File exists; consumed upload receipts are not Blob roots.

Cross-Library import copies selected bytes into a destination File identity. Profile snapshots preserve their internal identity graph and rotate the Store epoch. Neither mechanism creates a live reference across Library boundaries.

## Consequences

The common move/copy path has no File ownership policy, path allocation, hidden fork, or ownership Undo. File history describes content, Page manifests describe organization, and Document history describes occurrences with exact retained content. Canonical identity and retention rules replace ownership exceptions.

Upload publication remains a bounded, authenticated byte stream followed by a transaction-bound prepared receipt. Core consumes the receipt together with the File write, relation changes when requested, durable result, and LocalCommit evidence. Temporary composer or queued bytes may use the same Blob machinery without automatically becoming user-visible Files.
