# ADR 0051: Page owns File identity; immutable bytes remain separate

- Status: Accepted; placement semantics amended by ADR 0052
- Date: 2026-08-28

## Context

Nodex Pages need to carry Agent outputs and user resources that cannot be
faithfully represented as collaborative Page body content: images, PDFs,
scripts, datasets, reference trees, and exact-format Markdown. Existing Page
attachments pointed directly at physical managed-asset names. That made a use
site look like ownership, tied rename to a storage locator, and offered no
Page-relative path, stable File identity, independent versions, or coherent
Page-copy semantics.

Subpages already provide the correct durable model for Nodex-native documents.
Their visible Owning Page Shell is both content and the single structural order
authority. Treating subpages as filesystem folders, hiding Agent plan Pages, or
adding a separate Artifact collection would duplicate ownership and lifecycle.
Conversely, treating every exact-format output as a Page loses byte fidelity and
turns ordinary resource trees into searchable document entities.

## Decision

Every Page intrinsically owns one direct Files manifest in addition to its
Document. A File is a Library resource with stable identity, exactly one owner
Page, a portable Page-relative logical path, current state, immutable version
history, and actor/Turn provenance. `Artifact` is not a durable noun; purpose is
expressed by surrounding Page context and path. Logical folders are derived
from path prefixes and have no identity or lifecycle.

File metadata and bytes are separate. Core stores exact bytes as immutable
SHA-256-addressed managed blobs and may share one blob among many File versions.
Clients upload bytes first through an authenticated bounded stream and receive
an opaque Project/store/operation-bound prepared receipt. A manifest mutation
consumes the receipt. Rename changes only the logical path; replace appends a
version; restore is another forward version. Page copy creates fresh File
identities and version-1 heads while reusing identical blobs.

Page body images and attachments are non-owning placements represented by
`nodex://files/<file-id>`. A placement may occur in any Page Document in the
same Library while the File retains exactly one owner Page. Removing a placement
never deletes the File; ordinary File deletion is rejected while placements
remain. Block transfer preserves placed File identity across Pages. Moving a
whole Page also keeps File identities because the owner Page does not change.
The authorization, retention, and transfer consequences are specified by
[ADR 0052](0052-file-placement-is-independent-of-ownership.md).

Direct File manifests never flatten child Page Files. Recursive closure is
composition over the existing Page ownership tree. Project grants, Page
lifecycle, backup, restore, and copy therefore follow one ownership relation.
Core owns metadata, blob publication/read, authorization, copy/transfer,
integrity validation, and garbage collection. Main and CLI adapt explicit
user-selected streams and destinations but never expose Profile paths or
read-by-hash capability.

Nodex-native plans, notes, and design documents remain ordinary child Pages
with visible Owning Page Shells. Their exact-format resources are Files of that
child Page. No Plan Mode behavior or prompt is changed.

## Consequences

Page Stage can expose one intrinsic Files row on every Page without adding a
Data Source Property. Rename and replace preserve body references, File history
is independent of Document history, and Page copies are logically independent
without duplicating bytes. Agent and CLI package projections can eagerly expose
bounded metadata while reading bytes lazily.

File and Document revisions remain independent authorities. Creating a File and
then placing it is intentionally safe as two semantic steps: interruption may
leave a valid unplaced File, never a dangling body reference. Deleting a placed
File requires explicit placement removal first. Cross-Page structural transfer
moves or copies only the placement; it does not advance a Files manifest.

Content-addressed publication can leave an unreachable blob after interruption,
so maintenance must collect unreachable bytes. It cannot produce committed
metadata that points to absent bytes. Backup/restore and garbage collection now
include retained File versions and prepared receipts in their closure.

Legacy `nodex://assets/*` remains a compatibility locator for non-Page asset
authorities. New Page authoring writes only stable Page File references; Canvas,
queued payload, Composer, and other asset domains do not become Page Files.

## Rejected alternatives

A dedicated Artifact database duplicates File identity, permissions, history,
and lifecycle while adding only a purpose label. A Data Source Files Property
would make intrinsic Page capability depend on membership. Modeling folders as
Pages pollutes navigation and search and introduces empty-folder lifecycle.
Hiding child Pages outside the body creates a second child/order authority.
Using physical asset names as File identity breaks rename and copy semantics.
Mounting the Profile as FUSE/WebDAV expands filesystem authority and is not
required for bounded Agent interoperability.
