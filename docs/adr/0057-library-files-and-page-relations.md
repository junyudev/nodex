# ADR 0057: Library Files and Page relations

- Status: Accepted
- Date: 2026-09-04
- Supersedes: the Page ownership, exclusive rehome, and owner-closure copy rules in [ADR 0051](0051-page-owned-files-and-immutable-bytes.md) and [ADR 0052](0052-file-placement-is-independent-of-ownership.md). Their immutable-byte and canonical-Document principles remain valid.

## Context

A file can be useful before it appears in a Page, and the same file can appear in several Pages. A single owner Page makes the file's availability, path, history, and lifetime depend on an incidental presentation location. Moving the last image occurrence then becomes an ownership transfer across two manifests, even though neither its identity nor its bytes changed.

Page paths also describe how a particular Page organizes its references. They do not describe the File itself. Treating a path rename as a content version mixes independent concurrency boundaries and makes sharing difficult to explain.

## Decision

The Library Module owns File identity. The Profile owns its physical byte storage. A File is a first-class Library resource, with its own direct Project grants; it is not a Block and has no Block placement or owner Page.

Every File has a stable ID, a nonunique portable default name, an independently advancing metadata revision, a lifecycle, and a head pointing to an immutable FileVersion. A FileVersion records exact Blob bytes, MIME type, byte length, and creation provenance. Content hashes may share physical bytes across versions and Files, but never merge File identities.

A Page has two independent ways to use a File:

- An explicit PageFileEntry assigns a portable logical path to a File. The relation is unique by Page and File, and paths form a collision-free portable namespace within that Page.
- A canonical Document occurrence references `nodex://files/<file-id>` directly. It does not require an explicit entry or a generated path.

Page Files is the deduplicated union of these relationships. Body occurrence counts and explicit paths remain Page-local. Removing an entry changes only the relation; removing an occurrence changes only the Document. Moving or copying Blocks, promoting Blocks to Pages, and copying Pages preserve File IDs. Explicit entry transfer operates on the two Page manifests and never changes File content or global metadata.

Entry batches validate their final namespace, so paths can be exchanged without temporary names. Explicit paths are reserved before suffix allocation. Each changed Page manifest advances once; a copied source remains unchanged. Import and local replacement consume prepared bytes, create the File, grant its creator access, and write the relation atomically. A conflict leaves all of those resources unchanged.

Updating a shared File requires an explicit File write with a revision/head precondition. Replacing one occurrence or entry creates a new File and retargets only that relationship. Global replacement must remain compatible with existing media occurrences. Renaming a Page path, renaming the File's default name, and replacing bytes use their respective relation, metadata, and content concurrency boundaries.

## Authorization

Trusted Library authority may manage Files throughout the Library. A Project obtains global File access only through a direct `file` grant, with `read` or `read_write` access and no recursive inheritance. File creation grants the creating Project read/write access in the same transaction. Actor and Turn provenance do not grant authority.

An authorized Page relationship permits the File's current presentation metadata and current bytes. It does not authorize version enumeration, arbitrary historical versions, global changes, or other Pages. A retained Document revision permits only the exact File target captured in that revision. Canvas and queued inputs likewise identify their retained targets explicitly. A File ID, content hash, URI, or physical path is never a bearer capability.

Structural persistence receives the exact File IDs proven by the authorized source or authenticated clipboard snapshot. This evidence survives source detachment in the same operation. Fresh content still requires current read authority; a general structural-write flag cannot authorize arbitrary File IDs.

A whole-Page clipboard copy captures its explicit paths together with its body. Pasting initializes the new Page from that captured namespace while preserving the shared File IDs. Later source-path changes do not change the copy, and later shared content updates still follow the File head. Structural retention includes Files referenced by captured bodies and entries, including while a cut has detached the source.

Generic File read stamps and File event atoms require direct File authority. Page presentation reads use Page authority. A File change can therefore publish a File-scoped event and independently invalidate the current presentation in authorized Pages without widening either scope. File identity and grant changes participate in the existing visibility journal and revocation protocol.

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
Canvas reads authorize that exact slot. A live File can be reused at its fixed
version even when its head has advanced; Canvas restoration does not reinterpret
its bindings as ordinary head-following body occurrences. Trashed targets fork
once per distinct File/version/name, preserving multiple old versions without
changing the original File's lifecycle. Occupied slots with different bindings
receive new scene slot identities during an explicit forward history restore.

Retained Canvas drafts freeze each authorized slot at acceptance. Recovery can
reconstruct a removed slot from that exact target. A slot reused for another
binding cannot redirect retained image intents; the complete retained scene
can still be saved as a copy. File and Canvas creation effects share one Library
event, and all recovery effects share one durable operation.

Retained Yjs drafts freeze their authorized File targets when Core accepts the
package. Recovery first preserves the retained causal merge and then remaps
File occurrences. Copying a recovered Page composes File and Page effects into
one Library event; it does not invent another operation identity for part of
the same recovery.

A live File remains retained even when unused. Trash is explicit and has no automatic expiry. Current and recoverable Page/Canvas relationships prevent trashing. Retained historical and recovery targets can outlive current use and prevent permanent deletion. File versions remain retained while the File exists. Permanent deletion retires the File ID; physical Blob collection follows all durable roots and cannot be inferred from Page usage counts alone.

Submitted conversation attachments retain immutable bytes independently of their
source File. Thread-owned Blob roots survive removal from a queue and release
when the Thread is deleted. This preserves the submitted input without keeping
an otherwise disposable File identity alive. Attachment reads require the owning
Thread's Project authority; knowing a Blob hash alone never authorizes a read.

File usage queries expose only independently authorized Page/Canvas owners;
pagination has no hidden owner totals, and read stamps depend on each returned
owner. Lifecycle conflicts are generic when other owners are inaccessible.
SQL constraints protect retirement and retain all versions while their File
exists; consumed upload receipts do not become accidental Blob retention roots.

Cross-Library import copies authorized bytes into a destination File identity. Profile snapshots preserve their internal identity graph and rotate the Store epoch. Neither mechanism creates a live reference across Library boundaries.

## Consequences

The common move/copy path has no File ownership policy, path allocation, hidden fork, or ownership Undo. File history describes content, Page manifests describe organization, and Document history describes occurrences with exact retained content. The additional direct resource boundary replaces ownership exceptions with explicit authorization and retention rules.

Upload publication remains a bounded, authenticated byte stream followed by a transaction-bound prepared receipt. Core consumes the receipt together with the File write, grant, relation changes when requested, durable result, and LocalCommit evidence. Temporary composer or queued bytes may use the same Blob machinery without automatically becoming user-visible Files.
