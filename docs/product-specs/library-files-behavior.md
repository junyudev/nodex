# Library Files

Status: Active

Last Updated: 2026-09-05

## Identity and content

A File is an independent Library resource with a stable identity, portable default
name, lifecycle, metadata revision and immutable content versions. Default names
may repeat. A File can exist without a Page relationship. Identical bytes can be
shared by several independent Files; content deduplication does not merge their
identities, names or histories.

Updating shared content appends a FileVersion and advances the File head. It
requires both the expected metadata revision and head version. Renaming changes
only the metadata revision. A failed comparison consumes no prepared upload and
changes no Document or Page path. Explicitly forking a readable version creates
an independent File.

## Library surface

`Library files` is the identity-level management surface. It is available
without opening a Page and presents one searchable, paged catalog. `All` shows
live Files, `Unused` shows live Files with no current Page entry, body
occurrence, or Canvas slot, and `Trash` shows explicitly trashed Files. Unused
is a cleanup hint rather than a deletion or retention decision.

Selecting a File shows its current preview, MIME type, byte length, head
version, update time, current locations, and content history. Global
actions include import, rename, save the selected version, update shared
content, make an independent copy, move to Trash,
restore, and permanently delete when retention permits. The shared-update action
explains that Page references follow the latest content,
while Canvas images and historical snapshots keep their captured versions. Loaded
usage rows are never presented as a complete count of affected locations. The
preview action row uses accessible icon buttons with action tooltips. A
right-aligned information tooltip explains sharing and retention rules without
occupying the details body. Versions precede Uses in full-width stacked sections;
their headings use normal capitalization. Action failures and the selected
historical version remain visible in context.

The catalog covers the current Profile Library in every Project context. When the surface is opened for a particular Page, `Add to Page`
creates only that Page's entry after asking for a path. The picker supplies the
File name as an editable default, rejects an occupied explicit path, and excludes
global File management actions.

A selected File is read by identity independently of catalog pagination and
filters. An unavailable requested File stays unavailable; the
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

## Identity and source validation

The current authenticated Profile can read and manage all Files in its Library.
Project routing does not filter catalogs or usage locations. Missing, deleted
and cross-Library File identities remain unavailable. File management has no
resource permission flags; lifecycle and retained uses determine available
Trash, restore and permanent deletion actions. Canvas and historical
reads preserve their exact captured version and name; current Page reads follow
the File head. A URI alone exposes no physical Profile path.

Usage queries remain paged and never treat a loaded window as a complete impact
inventory. Structural Clipboard exports bind exact selected versions and names,
an active bundle lease and the current Store epoch. Cut detachment does not
invalidate those retained bytes. Shared updates leave the captured export
unchanged, while Paste retains live File identity. Export preparation is
metadata-only and bounded to 128 Files.

Desktop and native clients materialize bytes through the authenticated Core
File boundary. Cache hits revalidate the selected source and version. Cache
loss is repairable from Core and does not make the cache a persistent owner.
At most two bounded File exports run concurrently.

File publication and Page entry mutation remain separate commands. Each item
has an operation-bound upload receipt, including repeated names and identical
bytes. Page entry batches consume receipts in one manifest-fenced transaction;
shared replacement compares metadata and content revisions.

## History and recovery

Body history binds exact File versions and frozen names. Forward restoration
reuses an unchanged live head or creates one new File per changed source File.
It never rewinds shared content elsewhere and does not restore independent Page
paths as part of title/body history.

The history panel supplies the selected Document revision as the File read source.
Images and attachment previews, displayed names and native saves all use that
same source. Switching revision, Library or Store epoch releases the previous
preview cache. Unavailable captured content stays unavailable; a preview never
falls back to a different current or retained source.

Canvas image slots freeze versions and names. Several slots can retain different
versions of one File. Live fixed targets remain usable after shared updates;
restoring a trashed target creates a File per distinct retained version and name.
Draft recovery preserves the same captured evidence. File creation,
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
current/recoverable uses or retained history prevent deletion. Missing owners
remain explicitly unavailable. Retired File identities cannot be reused, and all direct
identities retire in the deletion transaction.

File versions stay immutable and retained while the File exists. Physical Blob
collection follows all durable roots after File deletion. Deleting one File does
not necessarily free bytes shared by another File. Retry of a committed command
returns its durable result even after its now-unowned bytes have been collected.
