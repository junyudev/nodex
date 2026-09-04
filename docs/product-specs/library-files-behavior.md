# Library Files

Status: Active

Last Updated: 2026-09-05

## Identity and content

A File is an independent Library resource with a stable identity, portable default
name, lifecycle, metadata revision and immutable content versions. Default names
may repeat. A File can exist without a Page relationship. Identical bytes can be
shared by several independent Files; content deduplication does not merge their
identities, names, permissions or histories.

Updating shared content appends a FileVersion and advances the File head. It
requires both the expected metadata revision and head version. Renaming changes
only the metadata revision. A failed comparison consumes no prepared upload and
changes no Document or Page path. Explicitly forking a readable version creates
an independent File; new Files receive the requesting Project's direct write
grant in the same transaction.

## Library surface

`Library files` is the identity-level management surface. It is available
without opening a Page and presents one searchable, paged catalog. `All` shows
live Files, `Unused` shows live Files with no current Page entry, body
occurrence, or Canvas slot, and `Trash` shows explicitly trashed Files. Unused
is a cleanup hint rather than a deletion or retention decision.

Selecting a File shows its current preview, MIME type, byte length, head
version, update time, visible authorized locations, and content history. Global
actions include import, rename, save the selected version, update shared
content, make an independent copy, manage direct Project access, move to Trash,
restore, and permanently delete when retention permits. The shared-update action
explains that Page references follow the latest content,
while Canvas images and historical snapshots keep their captured versions. Loaded
usage rows are never presented as a complete count of affected locations. The
preview action row uses accessible icon buttons with action tooltips. A
right-aligned information tooltip explains sharing and retention rules without
occupying the details body. Versions precede Uses in full-width stacked sections;
their headings use normal capitalization. Action failures and the selected
historical/read-only state remain visible in context.

In a Project context, the catalog lists only Files with a direct grant to that
Project. A trusted Library context can manage the full Library catalog and
Project grants. Page-derived access alone never makes a File appear in the
global catalog. When the surface is opened for a particular Page, `Add to Page`
creates only that Page's entry after asking for a path. The picker supplies the
File name as an editable default, rejects an occupied explicit path, and excludes
global File management actions.

A selected File is read by identity independently of catalog pagination and
filters. An unavailable or unauthorized requested File stays unavailable; the
surface never substitutes another File. Preview, save, and independent copy use
the selected version. Preview format and size limits follow that exact version's
presentation metadata. Background refresh preserves the selected version and
unfinished name/path edits; retargeting the surface resets those local drafts.

Imports report successful Files and individual failures. Each File commits
independently; a failed item does not hide earlier successes or prevent later
items from being attempted. The selection remains bounded to 100 Files and
256 MiB. Partial-failure feedback asks users to retry only the failed items.

## Page relationships

A Page optionally assigns one path to a File. These entries form that Page's
portable namespace and carry their own manifest revision. Body occurrences use
`nodex://files/<id>` independently of paths. The Page inventory is the union of
entries and current body uses, deduplicated by File identity, with an optional
path and a body occurrence count.

Ordinary Page or Block copy, move, cut, paste and promotion preserve shared File
identities. They do not transfer File ownership or rewrite shared metadata.
Whole-Page copies reproduce explicit Page paths. Local replacement creates a new
File and retargets the chosen entry or occurrence; updating all shared uses is a
separate File operation.

Image and attachment uploads in the body create independent Library Files.
They do not reserve Page paths. Inline labels use the File presentation name,
including a frozen name when an exact historical source is supplied. A File
has no owner-Page disclosure.

## Authority

Project File grants are direct, nonrecursive read or read-write grants. Page
access exposes the current bytes and presentation of Files actually used there;
it does not grant a global File listing, arbitrary versions or File mutation.
Canvas and historical reads authorize their exact captured binding. A File URI
alone is not read or placement authority.

The File usage query requires direct File access and lists only Page or Canvas
owners independently readable by the requesting Project, including authorized
recoverable owners. Pagination and cache dependencies preserve those boundaries;
there is no hidden-owner total. Each visible location includes its authorized
title, lifecycle, and whether it follows current Page content or uses a fixed
Canvas version. Active locations can be opened directly. Incomplete pagination
is explicitly labeled and never treated as a complete impact inventory. A lifecycle
conflict reveals no inaccessible owner identity or hidden usage count.

Desktop and native clients read bytes through `/core/v1/files/blobs/<file-id>`
with an explicit authority source. Direct reads may select a retained version;
Page reads follow the current head, while Document revision, recovery draft and
Canvas slot reads must match that source's captured target. Native save uses
the same source as preview. Neither a save dialog nor a local cache expands
the authority of the request. Copying a File reference as a local path
materializes an authorized exact version into a rebuildable private cache. Every
materialization rechecks its source, including cache hits; cache loss can be
repaired from Core without making the cache a persistent File owner.

File publication and Page entry mutation are separate commands. Each selected
item in a batch has its own operation-bound upload slot, including repeated
names or identical bytes. The Page entry command consumes those receipts in
one manifest-fenced transaction; a global File replacement instead compares
the File's metadata and content revisions.

## History and recovery

Body history binds exact File versions and frozen names. Forward restoration
reuses an unchanged live head or creates one new File per changed source File.
It never rewinds shared content elsewhere and does not restore independent Page
paths as part of title/body history.

The history panel supplies the selected Document revision as the File read source.
Images and attachment previews, displayed names and native saves all use that
same source. Switching revision, Library or Store epoch releases the previous
preview cache. Unavailable captured content stays unavailable; a preview never
falls back to a current Page or direct File grant.

Canvas image slots freeze versions and names. Several slots can retain different
versions of one File. Live fixed targets remain usable after shared updates;
restoring a trashed target creates a File per distinct retained version and name.
Draft recovery preserves the same captured evidence. File creation, grants,
Document changes and recovery resolution share one durable operation.

Recovery inspection returns an exact read binding for each File in each preview.
The current view uses the current Page or Canvas binding; retained content uses
its captured draft. A merged body keeps captured targets for retained File IDs
and current bindings for later additions. An unresolved captured target cannot
borrow the current File head. Canvas bindings are keyed by scene slot, preserving
different captured versions of the same File. Every byte read and save rechecks
the supplied source; the preview map itself grants no access.

Unknown historical targets remain unresolved and cannot silently read or restore
the current File head. See [Document history and retention](../reliability/document-sync-history-and-retention.md)
and [Canvas behavior](canvas-behavior.md).

## Trash and permanent deletion

An unused live File remains saved. Trash is explicit and has no automatic expiry.
Current Page entries, body occurrences and Canvas image bindings prevent Trash,
including those belonging to recoverable deleted owners. Remove the relationship
first; trashing a File never removes another owner's content.

Historical and recovery evidence can retain versions of a trashed File. Restoring
from Trash reuses the same File identity and head. Permanent deletion requires
Trash and the absence of every retained use. The details surface explains when
current/recoverable uses or retained history prevent deletion, without naming
inaccessible locations. Retired File identities cannot be reused, and all direct
grants are revoked in the deletion transaction.

File versions stay immutable and retained while the File exists. Physical Blob
collection follows all durable roots after File deletion. Deleting one File does
not necessarily free bytes shared by another File. Retry of a committed command
returns its durable result even after its now-unowned bytes have been collected.
