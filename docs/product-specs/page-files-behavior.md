# Page Files Behavior

Status: Active

Last Updated: 2026-09-05

Page Files is the Page-local view of Library Files related to one Page. It lets a
person organize a File under a portable path, see Files used in the Page body,
and change either relationship explicitly. The Page does not own the File, its
content versions, global name, lifecycle, or Project grants.

The Library-wide identity, content, permission, history, and deletion rules live
in [Library Files](library-files-behavior.md). This specification owns Page paths,
body occurrences, Page inventory, and the Page Stage surface.

## Relationship model

A Page can relate to a File in two independent ways:

- A Page File entry assigns one optional logical path to that File in this Page.
- An image or attachment occurrence in the canonical Page Document references
  `nodex://files/<file-id>` directly.

A Page/File pair has at most one explicit entry, while the body may contain any
number of occurrences. An entry does not have to appear in the body, and a body
occurrence does not automatically create an entry. A child Page keeps its own
relationships; its parent never flattens them into one namespace.

Page Files is the deduplicated union of explicit entries and current body
occurrences. Each inventory row contains stable File identity, its authorized
current presentation, an optional Page path, and the body occurrence count. A
File present in both relationships appears once. Removing one relationship does
not remove the other or delete the Library File.

Page paths are slash-separated portable relative paths. Their prefixes render as
logical folders but have no identity, metadata, permission, history, or empty
state. The same File can have different paths in different Pages. Renaming a path
changes only that Page entry; renaming the File default name changes no Page
path.

## Page Stage

Every Page Stage can expose one compact `Files` Property row. Opening the Page or
rendering the closed row reads metadata only and never loads File bytes. The row
summarizes Files related to the current Page and opens the complete Page Files
surface.

A File with an explicit path and no body occurrence is an unplaced entry. These
entries are the most useful compact-row preview because they are otherwise not
visible in the editor. Files already visible in the body are summarized without
repeating every attachment or image. When the quiet Properties disclosure owns
the row, body-only changes do not make the surrounding Property layout jump
while the Page remains mounted.

The open surface provides a bounded, searchable inventory. It distinguishes the
optional Page path from body usage and exposes actions appropriate to each
relationship:

- import a new Library File and add a Page entry in one operation;
- add an already readable Library File under a path;
- set or rename an entry path;
- remove an entry while leaving body occurrences and the File intact;
- replace one entry with a newly imported File while leaving body occurrences of
  the previous File intact;
- preview or save the authorized current File;
- open Library File details for global rename, shared content update, versions,
  usage, grants, Trash, restore, or permanent deletion.

An entry replacement changes only the selected Page/File relation. Updating the
shared File is a separate Library action with explicit wording because all
head-following Page body occurrences and entries will see the new content.

## Import and path conflicts

Desktop import accepts regular files only. One File is bounded to 64 MiB; one
selection is bounded to 100 Files and 256 MiB total. Directory import is bounded,
preserves relative paths, and rejects symlinks and special files. Text preview is
bounded separately to 2 MiB. Unsupported formats remain downloadable and show a
truthful no-preview state.

Import first publishes immutable bytes under an operation-bound receipt. The Page
entry command consumes its selected receipts, creates independent Library Files,
grants the creating Project direct read/write access, and creates all entries in
one transaction. If any path or authority check fails, it commits none of those
Files, grants, or entries. Published but unconsumed bytes remain unreachable and
are later collectible.

Core owns path normalization and allocation. Paths reject absolute forms,
traversal, empty segments, reserved Windows names, controls, Unicode/case
collisions, and excessive component, depth, or total length. A multi-entry batch
validates its final namespace, so exchanging two existing paths does not require
a temporary name. A normal import may allocate the first available ` (N)` suffix;
an exact-path command or explicit replace-entry policy either replaces the
relation or rejects the collision as requested.

Every entry mutation compares the Page manifest revision. A stale command makes
no partial change and asks the caller to review the new inventory. One committed
batch advances that Page manifest once. The body-use revision advances only when
the canonical set or count of body File occurrences changes; it is independent
from the entry manifest and each File revision.

## Body occurrences

Images and attachments store stable File identity rather than a Page path or
Blob hash. Upload, paste, and oversized-text materialization create a Library
File, then insert its File URI in the body. They do not reserve a Page path. If
File creation succeeds but editor insertion later fails, the independent File
remains visible in Library Files and can be reused or cleaned up.

The containing Page authorizes the current presentation metadata and current
bytes only while its canonical entry or body projection contains the File. This
access does not expose arbitrary File versions, global usages, other Page paths,
or File mutation. Core rejects missing, retired, cross-Library, trashed, or
unauthorized File references before committing a Document change.

Body labels may carry a local explicit name or caption. When no local value is
present, they display the File presentation name. Historical and recovery
surfaces use the frozen name from their exact File binding rather than the
current global default name.

Removing an image or attachment changes only the Document occurrence. Removing
the last occurrence makes a body-only File disappear from Page Files unless an
explicit entry remains. The Library File stays live even with zero Page usage.
Trashing a File is refused while any current Page entry, body occurrence, Canvas
slot, or recoverable current relation still uses it.

## Move, copy, paste, and Undo

Ordinary Block move, copy, cut, paste, drag, Page promotion, and whole-Page copy
preserve File IDs. They never transfer File ownership, append a File content
version, rename a File, or allocate a path as a side effect.

Moving a Block occurrence between Pages removes and adds body relationships as
part of the two Document updates. Existing Page entries stay where they are.
Copying a Block adds another occurrence of the same File. Whole-Page copy also
copies the source Page's explicit entries and paths while keeping the same File
IDs. An explicit `Create independent copy` action is the only general operation
that forks File identity.

Explicit entry move or copy is a relationship command. Move compares source and
target manifest revisions, removes the source entry, and adds the target entry in
one transaction. Copy leaves the source entry. A target collision rejects the
whole command; it never mutates the shared File or chooses an unreviewed path.

Structural Undo restores the relationships changed by the original action. A
shared File update elsewhere does not invalidate Undo for a Block move because
that Undo does not modify the File head. Undo for a local occurrence replacement
restores the original File ID and follows its current head. Exact historical
restoration uses the separate snapshot rules below.

## History and recovery

Every current Page history checkpoint freezes the exact FileVersion and default
name for each body File. The snapshot identity includes these bindings, so a
shared File update can create meaningful history even when the Document head did
not change. Preview reads only the selected revision's exact targets.

Restoring Page title/body is a new forward transaction. An unchanged live File
may be reused; a changed or trashed target is forked once and restored body
occurrences are remapped to that new identity. The operation never rewinds a
shared File used elsewhere. Title/body history does not restore independent Page
entries, so paths added after the checkpoint remain untouched.

A whole-Page structural snapshot includes both body bindings and explicit Page
entries. Its restore or copy applies one mapping to both sets, preserving their
agreement. Legacy snapshots without complete File evidence remain explicitly
unresolved and cannot fall back to a current head.

## Authorization and cache coherence

Page read access permits the Page inventory and current File presentations
visible through that Page. Page write plus a current proof that the source File
is readable permits adding an entry or body occurrence. A File ID, hash, URI,
clipboard payload, or creation provenance is not such proof. Cross-Library
references are rejected; an authorized import creates a new destination File.

Renderer File reads are keyed by Store epoch, access context, read source, File
identity, and optional exact version. Entry and body-reference changes refresh or
revoke only affected Files. Removing the last authorized relationship releases
metadata, bytes, and object URLs before revalidation. Direct File grants, Page or
Document revocation, Project lifecycle, and Store epoch replacement clear their
matching scopes. A cache hit never substitutes for a fresh Core authorization.

## Management feedback

Page Files exposes Core-authorized Page write capability. Read-only Pages permit
preview and save while disabling entry creation and path editing and omitting
replacement/removal actions. Direct File access is separate: opening a Library
File by identity may report that direct access is required without invalidating
the Page's own preview authority.

Replacing an entry selects the new File and explains that existing body
occurrences remain unchanged. Hand-entered paths use exact collision semantics.
A revision conflict refreshes the inventory for review and never automatically
replays the user's write with a new precondition. Background refresh preserves
unfinished path edits.

Browsing existing Files replaces the Page manager with a focused picker; the
picker does not expose shared updates, lifecycle changes, or grant editing.

Page and Library File details share the same preview action bar: icon actions
with accessible names and tooltips, followed by a right-aligned information
entry. Page path replacement/removal rules live in that tooltip; the path,
read-only state and action failures remain visible. Content usage is available
in the information tooltip.
Browse Library and Add folder use labeled icon controls beside the primary
Add files action. Path editing keeps its explicit Save action.

Both managers use the same File metadata line: MIME type, byte size, displayed
version, and File update time. The timestamp describes the shared File, not when
a Page path was attached or edited. Historical previews use the selected
version's MIME type and size while the update time remains File metadata.

File lists prioritize name/path, byte size, and update date. The Page sidebar
groups files into Attachments (no current body references) and In page
(one or more body references), omitting empty groups. Group headings align with
the search field's left edge and show a quiet inline count, replacing the
standalone File total. Counts use Core's full filtered group totals, independent
of loaded pagination.
A File with both a path and body references appears once, in In page. Groups
classify the loaded search results; pagination continues across the inventory.
Content-reference counts remain details, not list subtitles. Library browsing and the existing-File picker use the same
metadata rows.
