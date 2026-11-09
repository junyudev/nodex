# Page Files Behavior

Status: Active

Last Updated: 2026-11-09

Page Files is the Page-local view of Library Files related to one Page. It lets a
person organize a File under a portable path, see Files used in the Page body,
and change either relationship explicitly. The Page does not own the File, its
content versions, global name or lifecycle.

The Library-wide identity, content, history and deletion rules live
in [Library Files](library-files-behavior.md). This specification owns Page paths,
body occurrences, Page inventory, and the Page Stage surface.

## Relationship model

A Page can relate to a File in two independent ways:

- A Page File entry assigns one optional logical path to that File in this Page.
- An image or attachment occurrence in the canonical Page Document references
  `nodex://files/<file-id>` directly.

New local images and attachments are imported as Library Files before insertion.
Temporary cache locators, browser object URLs, and display transport URLs are not
durable Document sources. A missing or invalid File identity rejects the upload instead
of creating an attachment that depends on a disposable cache.

A Page/File pair has at most one explicit entry, while the body may contain any
number of occurrences. An entry does not have to appear in the body, and a body
occurrence does not automatically create an entry. A child Page keeps its own
relationships; its parent never flattens them into one namespace.

Page Files is the deduplicated union of explicit entries and current body
occurrences. Each inventory row contains stable File identity, its current presentation, an optional Page path, and the body occurrence count. A
File present in both relationships appears once. Removing one relationship does
not remove the other or delete the Library File.

Page paths are slash-separated portable relative paths. Their prefixes render as
logical folders but have no identity, metadata, permission, history, or empty
state. The same File can have different paths in different Pages. Renaming a path
changes only that Page entry; renaming the File default name changes no Page
path.

## Page Stage

Every Page Stage can expose one `Files` Property row. Opening the Page or
rendering the row reads metadata only and never loads File bytes.

The row summarizes the Page's Files as a count and, when one origin attached
every File, names it: `3 files from <chat> · 2m`. It discloses the Files tree,
which spans the full width of the Properties beneath the row rather than the
value column, so folders, names, origins and sizes keep their own room. The tree
starts open; whether it is open, which folders are folded and whether it shows
every row are remembered for each Page in the window. A tree longer than ten rows
shows its first ten and `Show N more`; an inventory longer than one loaded window
continues with `Show more`.

A File with an explicit path and no body occurrence is an unplaced entry. These
entries make the row informative; Files already visible in the body do not. When
the quiet Properties disclosure owns the row, body-only changes do not make the
surrounding Property layout jump while the Page remains mounted.

The tree reads Page paths as folders: folders first, then Files, in natural name
order. Each File shows its kind icon, name and byte size. Files used only in the
Page body follow under `In page` with their File names; they have no path and no
attachment origin. Files that arrive while the Page is open carry a quiet new
mark until opened, and a folded tree shows the mark on its summary.

Each attachment origin appears once, on the narrowest node it covers: the summary
when one origin attached every File, a folder when one origin attached
everything in it, otherwise the File itself. An origin is the attaching chat with
its provider mark, `You`, or `Command line`, followed by how long ago; its
tooltip gives the exact time, and a chat's name opens that chat. A chat that no
longer exists reads `Deleted chat`.

Activating a File opens it in a tab beside its Page (see
[Opening Files](#opening-files)); Arrow keys move through the tree, Right and
Left unfold and fold folders, and Enter opens. A File's context menu offers
Open, Open in new tab, Save…, Copy path, Manage in Page files… and Remove from
Page, which reads Remove path while the body still uses the File. The row's `+`
and Manage open the Page Files manager. A Page shown outside a tab group opens
the manager on the File instead.

The manager provides a bounded, searchable inventory. All current-Profile
Page relationships can be managed once their inventory is loaded; Page lifecycle
and manifest revisions remain the mutation boundary. It distinguishes the
optional Page path from body usage and exposes actions appropriate to each
relationship:

- import a new Library File and add a Page entry in one operation;
- add an already readable Library File under a path;
- set or rename an entry path;
- remove an entry while leaving body occurrences and the File intact;
- replace one entry with a newly imported File while leaving body occurrences of
  the previous File intact;
- preview or save the current File;
- open Library File details for global rename, shared content update, versions,
  usage, Trash, restore, or permanent deletion.

An entry replacement changes only the selected Page/File relation. Updating the
shared File is a separate Library action with explicit wording because all
head-following Page body occurrences and entries will see the new content.

## Attachment provenance

Each explicit entry records who attached it and when. Core stamps the time, and
no caller names its own actor:

- the desktop app attaches as the local person;
- an Agent that Nodex runs carries a credential Core issued for its chat, so the
  entry names that product Session and its backend family (Codex, Claude,
  OpenCode or ACP), captured at attachment so a later provider change does not
  rewrite it;
- any other caller, such as the CLI run by hand or by an Agent Nodex did not
  start, is external;
- entries that predate provenance have an unknown origin and no time.

Renaming, moving and copying an entry, whole-Page copy, clipboard paste and
structural restore keep its provenance. Replacing an entry's File, as `nodex page
file put` does at an occupied path, or removing and re-attaching it records a new
origin and time. Shared File updates and global renames leave it unchanged.
Body-only uses have none. File creation and version evidence describe the File,
not who attached it to a Page.

## Opening Files

A Page File opens as a tab in its Page's tab group, immediately after the Page
tab, so the Page stays one click away. A File referenced in the Page body, as an
inline attachment, opens the same way from the reference itself (see
[Attachment Chip](nfm-editor-attachment-chip-behavior.md#opening)). A click opens a preview tab that the next
preview in that group replaces; a double click, Cmd/Ctrl-click, Open in new tab,
or switching between preview and source keeps the tab. Opening a File that
already has a tab activates it. The tab follows its entry: a renamed path keeps
the tab, and when the entry's File is replaced, as an Agent does when it attaches
a new report at the same path, the tab moves to the new File. A tab whose File
left the Page says so and offers to open the Page.

The tab's header is the path back to the Page, `<Page> / folder / file`, and its
Page segment opens the Page. Its controls are View source or View preview for
HTML, Markdown and SVG, Reload for an HTML preview, Save…, and a menu with Copy
path, Manage in Page files… and Open in Library….

Each File presents as itself:

- HTML renders as the page it is, in an isolated offline preview (see
  [Security](../SECURITY.md#offline-page-file-html-previews)). Relative URLs resolve
  among the same Page's explicit entries, so `profile/report.html` can show
  `flamegraph.png` and fetch `trace.json` beside it. Nothing reaches the network:
  a report's scripts, styles and fonts must be inline or attached to the Page. A
  web link the person clicks opens in the system browser. The preview reloads
  when the File changes, and a report with a dark color scheme shows it while the
  app is dark.
- Markdown renders; images show with their dimensions and size; PDFs, audio and
  video play in their viewers.
- PDF zoom controls reflect the rendered page scale. Until the preview has a
  positive available width, Fit width uses the document's current zoom.
- Text, JSON and code show as source with line numbers. Single-line JSON is
  indented for reading; Save keeps the original bytes.
- Text and source views read at most 2 MiB. Other formats say they can't be
  previewed and remain saveable.

## Import and path conflicts

Desktop import accepts regular files only. One File is bounded to 64 MiB; one
selection is bounded to 100 Files and 256 MiB total. Directory import is bounded,
preserves relative paths, and rejects symlinks and special files. Text preview is
bounded separately to 2 MiB. Unsupported formats remain downloadable and show a
truthful no-preview state.

Import first publishes immutable bytes under an operation-bound receipt. The Page
entry command consumes its selected receipts, creates independent Library Files
and all entries in
one transaction. If any path, identity or lifecycle check fails, it commits none of those
Files or entries. Published but unconsumed bytes remain unreachable and
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

A Page presentation binds its File identity and current or captured version through
the canonical entry or body projection. Core rejects missing, retired, cross-Library
or trashed File references before committing a Document change. Historical reads
require the exact retained source and cannot fall back to the current File head.

Every authenticated current Profile caller can insert a live File from the
Library. Core validates the selected File, exact source when historical, Page
lifecycle and manifest revision. Project context does not filter File choices.

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

## Identity and cache coherence

Every authenticated current Profile caller can read Library Files and their Page
presentations. Cross-Library references are rejected; an import creates a new
File in the destination Library. A File ID, hash, URI or clipboard payload does
not replace the canonical identity, lifecycle and exact-version checks.

Renderer File reads are keyed by Store epoch, routing context, read source, File
identity and optional exact version. Entry and body-reference changes refresh
only affected presentations. Removing a presentation releases its metadata,
bytes and object URLs. File retirement, Page or Document deletion, connection
closure and Store epoch replacement clear affected cached data. A cache hit
never substitutes for a fresh source and lifecycle check.

## Management feedback

Active Pages permit entry creation, path editing, replacement and removal.
Archived Pages and historical snapshots permit preview and save while disabling
those mutations. Opening the File directly uses its canonical Library identity.

Replacing an entry selects the new File and explains that existing body
occurrences remain unchanged. Hand-entered paths use exact collision semantics.
A revision conflict refreshes the inventory for review and never automatically
replays the user's write with a new precondition. Background refresh preserves
unfinished path edits.

Browsing existing Files replaces the Page manager with a focused picker; the
picker selects an existing File without exposing shared updates or lifecycle changes.

Page and Library File details share the same preview action bar: icon actions
with accessible names and tooltips, followed by a right-aligned information
entry. Page path replacement/removal rules live in that tooltip; the path,
historical or archived state and action failures remain visible. Content usage is available
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
