# Page Files Behavior

Status: Active

Last Updated: 2026-08-28

Page Files are exact-format resources owned directly by a Page. They are the
durable home for images, PDFs, scripts, datasets, reference material, and other
content whose bytes and filename matter. Nodex does not introduce a separate
Artifact type: Agent-created outputs and user uploads use the same File model.

## Product model

Every Page has Files, whether or not the Page belongs to a Data Source. Files
are intrinsic Page content, not a Data Source Property. A File has:

- stable identity and exactly one owner Page;
- a portable Page-relative logical path;
- exact MIME, byte length, immutable current bytes, and retained versions;
- creation and update provenance, including an Agent Turn when applicable.

Renaming or replacing content preserves File identity. Deleting a body
placement does not delete the File. Copying a Page creates fresh File identities
for the copy while reusing identical immutable bytes.

Logical folder rows are derived from slash-separated path prefixes. They have no
identity, metadata, permissions, empty state, or lifecycle. A child Page owns
its own direct Files; the parent Files surface never flattens descendants.

## Page Stage

Every Page Stage Properties section contains one compact `Files` row. The row
avoids repeating Files that are already visible as placements in the Page body.
It shows `Empty` only when the Page owns no live Files. Otherwise it shows up to
two unplaced File chips and a compact summary when more inventory exists. When
every live File is placed, the summary reads `N in page`; mixed overflow uses
one combined `+N` summary whose tooltip distinguishes additional unplaced Files
from Files shown in the body. Each File chip uses the same path/MIME-derived
format icon as other exact-format File surfaces and opens that File directly.
The summary and add controls open the Page Files surface. Opening the Page or
rendering the closed row never loads File bytes. The Page Files list, deleted
rows, and preview header use the same File icon projection.

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
manifest revision or body-usage revision for that exact Page. Manifest and
body-usage revisions are independent: File mutations advance only the manifest,
while a changed Page File reference set or placement count advances only body
usage. Rename and replace also publish an exact current-content invalidation to
every foreign placement Page without advancing that Page's Files manifest or
body-usage revision. Ordinary text, Property, focus, and selection changes
advance none of these authorities. Background refresh retains the last rendered
manifest instead of replacing it with an empty or loading state.

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
typed Core structural transfer carries the placement with the subtree; it does
not create a hidden File clone or mutate either Page's direct Files manifest.
Moving a whole Page likewise preserves its File IDs. Copying a Page closure
creates new IDs for every copied Page's direct live Files, while placements of
Files owned outside that closure keep their existing identities.

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

Create, replace, rename, delete, restore, and clone each append a File version
with actor, optional Turn, operation identity, and time. Restore is a forward
mutation from a retained version. Deleted Files leave the live path namespace
but remain visible and restorable while their history is retained.

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
deduplication, and garbage collection. Upload first publishes verified bytes
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
same transaction. Owner-only manifest, mutation, version-history, and lifecycle
operations still require owner Page authority. Backups include every retained
reachable File blob and restore validates size and SHA-256 before switching
Profiles. Garbage collection is serialized against backup snapshots and never
removes bytes protected by a live prepared receipt or retained File version.

The architecture decision is recorded in
[ADR 0051](../adr/0051-page-owned-files-and-immutable-bytes.md) and
[ADR 0052](../adr/0052-file-placement-is-independent-of-ownership.md).
Attachment authoring details are owned by
[NFM Editor Attachment Chip Behavior](nfm-editor-attachment-chip-behavior.md).
