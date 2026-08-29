# Page Files Behavior

Status: Active

Last Updated: 2026-08-29

Page Files are exact-format resources owned directly by a Page. They are the
durable home for images, PDFs, scripts, datasets, reference material, and other
content whose bytes and filename matter. Nodex does not introduce a separate
Artifact type: Agent-created outputs and user uploads use the same File model.

## Product model

Every Page has Files, whether or not the Page belongs to a Data Source. Files
are intrinsic Page content, not a Data Source Property. A File has:

- stable identity and exactly one current owner Page;
- a portable Page-relative logical path;
- exact MIME, byte length, immutable current bytes, and retained versions;
- creation and update provenance, including an Agent Turn when applicable.

Renaming, replacing content, or moving ownership preserves File identity.
Deleting a body placement does not delete the File. Copying a Page creates
fresh File identities for the copy while reusing identical immutable bytes.

Logical folder rows are derived from slash-separated path prefixes. They have no
identity, metadata, permissions, empty state, or lifecycle. A child Page owns
its own direct Files; the parent Files surface never flattens descendants.

## Page Stage

Every Page Stage can expose one compact `Files` row through its shared
Properties disclosure. A Page with no live Files, or with every live File
already represented in its body, starts with Files behind `N more properties`.
Expanding that disclosure shows the truthful `Empty` or `N in page` value and
retains the add and complete-inventory entry points. A Page with any unplaced
File shows Files directly. The row then avoids repeating Files already visible
as placements in the Page body: it shows up to two unplaced File chips and a
compact summary when more inventory exists. Mixed overflow uses one combined
`+N` summary whose tooltip distinguishes additional unplaced Files from Files
shown in the body. Each File chip uses the same path/MIME-derived format icon as
other exact-format File surfaces and opens that File directly. The summary and
add controls open the Page Files surface. Opening the Page or rendering the
closed row never loads File bytes. The Page Files list, deleted rows, and
preview header use the same File icon projection.

The open Files surface remains the complete direct-ownership inventory. Files
not placed in their owner Page appear first. Direct Files placed in that Page
live in a default-collapsed `In page · N` disclosure; opening from an `N in
page` summary expands it immediately. Foreign Files placed in the body remain
visible at their placement and do not enter the containing Page's Files
inventory. Path filtering searches the complete inventory through bounded Core
pages and reveals matching placed Files without creating a persistent view mode.
Placement is presentation, not a File type or visibility state.

The Files surface supports:

- adding one or more regular files;
- dropping files, directories, or a mixed selection from the operating system
  anywhere on the open surface;
- bounded recursive directory import, preserving logical paths;
- editing an existing exact-format text File;
- filtering by logical path;
- previewing bounded text and images;
- renaming paths, replacing bytes, downloading, deleting, and restoring;
- viewing deleted entries without treating them as part of the live namespace.

Each File is at most 64 MiB. One desktop import accepts at most 100 regular
files and 256 MiB total. Symlinks and special files are rejected. Text preview
and editing are bounded to 2 MiB; larger text-like Files remain downloadable.
Unsupported formats receive a truthful no-preview state.

The empty state presents a persistent file-drop affordance. While a supported
system drag is over the Files surface, the surface presents one stable,
unmistakable drop indicator even as the pointer crosses nested controls. A
dropped batch uses the same byte, count, path-allocation, and atomic manifest
mutation rules as the file picker. Dropped directories expand automatically and
retain their root name and relative paths. `Add folder` remains an explicit
picker entry, not a recovery path for unsupported drag behavior. A symlink,
special file, or violated batch bound rejects the whole selection before the
manifest changes.

Core owns upload path allocation. When an added File collides under the portable
path key, Core appends the first available ` (N)` suffix before the extension in
the same atomic mutation. The native CLI's exact-path `put` continues to replace
the live File already at that path instead of allocating a sibling. CLI `put`
is one semantic Core operation: its prepared bytes occupy a stable slot under
the operation identity, so an exact idempotent retry returns the original
receipt without reinterpreting the now-current manifest.

All metadata mutations compare the Page's current Files manifest revision. A
stale operation makes no partial changes and asks the caller to reload. A batch
validates its final namespace, so path swaps are legal while Unicode/case
collisions, traversal, reserved names, excessive depth, and excessive length
are rejected.

The closed row and an open Files surface refresh only when Core announces a new
manifest revision or owner-local body-usage revision for that exact Page. One
application-scoped cache listener invalidates matching retained queries even
when their Page tabs are currently unmounted, so a later remount cannot present
a pre-move Files inventory as fresh. Manifest and body-usage revisions are
independent: File mutations advance only the manifest, while an owner-local
placement-count change advances only body usage. Separately, Core compares the
complete Page File reference multiset of every Page Document commit and emits an
exact Document-scoped reference-change signal when it changes. Image and
attachment reads observe that signal so a newly authorized foreign placement
resolves immediately; it does not change File ownership, Files inventory, or a
manifest/body-usage revision. Rename and replace also publish an exact
current-content invalidation to every foreign placement Page without advancing
that Page's Files manifest or body-usage revision. Ordinary text, Property,
focus, and selection changes advance none of these authorities. Background
refresh retains the last rendered manifest instead of replacing it with an
empty or loading state. Automatic
Property visibility is stable for the mounted Page session: a new unplaced File
may promote Files from the disclosure, while a body-placement-only change never
reorders the Properties section. Once promoted, Files stays visible until the
Page surface remounts. A quiet row shown only because the shared disclosure is
open hides again when the user closes that disclosure.

## Placements

An image or attachment in a Page body may reference any live File in the same
Library using:

```text
nodex://files/<file-id>
```

The URI stores stable identity, not a path or blob hash. Presentation resolves
the current logical basename and bytes through the containing Page's canonical
placement, so rename and replace do not rewrite the body. The File keeps its
single owner Page. A placement does not grant access to the owner Page, direct
Files manifest, version history, rename, replace, delete, or restore authority.
A Page Document cannot persist a reference to a deleted, missing, cross-Library,
or otherwise unauthorized File.

Removing a placement leaves the File intact. Deleting a File that still has
placements is refused; the user removes those placements explicitly before
deleting it. This keeps placement editing and File ownership understandable
without a hidden cascade.

Placement usage is derived by Core from canonical
`block_asset_refs.page_file_id` rows. Each direct File summary reports either
`not_in_body` or its positive placement count in the owner Page body; foreign
placements do not make the owner inventory appear embedded locally. Nodex does
not persist an embedded, hidden, or Artifact classification on the File itself.

Block move and copy preserve placed File IDs both within and across Pages. A
typed Core structural transfer carries the placement with the subtree and never
creates a hidden File clone. Copy, duplicate, ordinary paste, deletion,
same-Page movement, and moving a whole Page shell do not change File ownership.

For an identity-preserving semantic move, ownership follows the placement only
when the move is exclusive. Core derives that consequence after persisting the
complete post-move placement projection: the File's current owner must be the
source host Page, the moved forest must contain one or more placements of the
File, and every live placement of that File must now be in the same target host
Page. If the source, a third Page, or any other Page still has a placement, or
the moved placement was already foreign to its source, ownership remains
unchanged and the body move still succeeds.

An exclusive ownership move preserves File ID, current bytes, Blob hash,
creation provenance, body URI, and complete version history. It appends one
immutable `rehome` version and advances both owner manifests in the same Core
transaction as the source and target Documents, projections, receipt, and
LocalCommit. The logical path is preserved when possible; a collision in the
target namespace receives the same deterministic ` (N)` suffix used by upload.
Only the initiating surface reports a collision-driven path change, using one
bounded success message; ownership changes without a rename are silent.

Copy and Cut of complete Block roots use the Structural Clipboard, including
ordinary image, attachment, and parent subtrees. The first valid paste of a cut
capability is an identity-preserving move and follows the same rule whether it
inserts at a caret or replaces selected content. Later pastes and every Copy
paste are copies and do not rehome the original File. Move Undo and Redo are
fresh semantic moves evaluated against their new canonical post-state;
replacement Undo and Redo also restore or reapply the replaced target closure in
the same transaction. Promotion Undo first proves that the generated Page's
File heads, namespace, placements, and target state still match its guarded
recipe; one atomic transaction reverses every required ownership move, restores
placements, and removes the generated Page. A conflict changes nothing and
keeps the history entry available.

Copying a Page closure creates new IDs for every copied Page's direct live
Files, while placements of Files owned outside that closure keep their existing
identities.

Legacy `nodex://assets/*` references remain compatibility locators for content
created by non-Page surfaces. New Page uploads, pasted materialized resources,
and Page images use Page Files. Canvas, queued payload, Composer, and other
non-Page asset authorities remain separate.

Pasting clipboard images into a Page publishes the image bytes first and adds
the body image Block only after publication succeeds. A failed upload therefore
leaves the body unchanged instead of creating an empty image Block. Clipboard
adapters accept both standard `DataTransfer.files` and image-only
`DataTransferItem.getAsFile()` exposure.

## Versions and deletion

Create, replace, rename, rehome, delete, restore, and clone each append a File
version with the owner at that point, actor, optional Turn, operation identity,
and time. Restore is a forward mutation from a retained version. Authorization
to inspect history follows the current owner, while historical owner IDs remain
immutable audit facts even if an earlier owner Page is deleted. Deleted Files
leave the live path namespace but remain visible and restorable while their
history is retained.

Page archive/delete/restore keeps direct Files and versions. If another Page
still places one of those Files, the deleted owner closure remains retained and
the placement continues to resolve. Physical collection becomes eligible only
after no external placement or other retention root remains. Whole-Page copy
copies only each live current state into version 1 of a fresh identity; it does
not fork source history.

## Agent and package access

Agents use ordinary child Pages for Nodex-native plans, notes, and design
documents. Exact-format output goes into the Files of the nearest semantic owner
Page. No Plan Mode behavior or prompt is specialized for Files.

The native Agent interface exposes bounded semantic commands to list, read,
put/replace, rename, delete, inspect versions, and restore Files. Page draft
projection includes the direct File manifest eagerly; bytes stay lazy and are
read through explicit File commands. Deleted Files can be included explicitly
when listing and remain selectable by identity or exact path for versions and
restore. The owner manifest remains complete for Agents and reports owner-body
placement counts; row-level de-duplication is solely renderer presentation.
Reading Page content may resolve current bytes for that Page's canonical foreign
placements, but does not reveal the foreign owner manifest or history. Neither
renderer nor Agent receives a Profile path or a read-by-hash capability.

## Reliability and authorization

Core owns File metadata, authorization, immutable blob publication, reads,
ownership-move derivation, deduplication, and garbage collection. Upload first
publishes verified bytes
and returns a Project/store/operation-bound receipt; a semantic mutation then
consumes that receipt. A failed semantic commit may leave an unreachable blob,
but it cannot leave committed metadata pointing to missing bytes.

Page read/write access covers its direct Files and follows the existing Page
ownership closure for descendants. Page read access also covers the current
presentation metadata and bytes of Files canonically placed in that exact Page;
the opaque File ID alone grants nothing. Generic collaborative persistence may
introduce a foreign placement only when its Project can already read the owner
Page or another canonical placement. Typed Core structural compilers may carry
an already-authorized placement even when moving its source projection in the
same transaction. An ownership move is never a caller-provided flag: only the
Library Module derives it from a typed semantic move, current ownership, and
canonical post-state placements. Owner-only manifest, mutation,
version-history, and lifecycle operations still require owner Page authority.
Backups include every retained
reachable File blob and restore validates size and SHA-256 before switching
Profiles. Garbage collection is serialized against backup snapshots and never
removes bytes protected by a live prepared receipt or retained File version.

The architecture decision is recorded in
[ADR 0051](../adr/0051-page-owned-files-and-immutable-bytes.md) and
[ADR 0052](../adr/0052-file-placement-is-independent-of-ownership.md).
Attachment authoring details are owned by
[NFM Editor Attachment Chip Behavior](nfm-editor-attachment-chip-behavior.md).
