# Files Git data

Files reads Git data only for the local host and resolves repository metadata from the file's
containing directory. Equal paths on different hosts never share a comparison or blame query.
Repository operations use the existing typed Git worker; draft text stays in the renderer.

The file comparison input accepts the Review source descriptors for Unstaged, Staged, Branch and
Commit, plus a file-local Uncommitted descriptor. Last Turn uses conversation diff data rather
than Git. The global Review Git source contract remains unchanged.

Without an explicit selection, a dirty draft uses Unstaged. Otherwise the first source with a
change to that file wins: Unstaged, Uncommitted, then Branch. An existing explicit selection always
wins over this default. The default branch preference is remote, then local. The file tree's
Changed files section compares against a branch only when the repository has a remote base
branch; otherwise it lists Unstaged changes.

| Source      | Base                                                       | New content              |
| ----------- | ---------------------------------------------------------- | ------------------------ |
| Unstaged    | Index                                                      | Current draft            |
| Uncommitted | HEAD, or empty for a new file                              | Current draft            |
| Branch      | Selected branch's merge-base with HEAD                     | Current draft            |
| Staged      | HEAD                                                       | Index snapshot           |
| Commit      | Selected commit's first parent, or empty for a root commit | Selected commit snapshot |

Uncommitted obtains the HEAD blob from the staged summary. When that file has no staged change,
its index baseline is also HEAD. Branch review summaries describe committed changes; a file with
only working-tree edits reads the merge-base blob explicitly. An added or untracked file has an
empty base. Renames retain the old path. Conflicts, missing base objects, incomplete summaries,
unreadable blobs and oversized blobs remain explicit failures. Snapshot reads never substitute
disk content. A stale repository generation cannot publish mixed comparison contents.

Comparison and blame queries include a saved revision, supplied as the disk modification time or
a successful-save counter. Saves and external file replacements advance it. Keystroke versions
and draft text are excluded from query identity. Changes to repository state without a file
revision require the consumer to refetch or invalidate the query. Cancellation reaches every
worker request. These queries do not own another repository watcher or polling loop.

Git blame describes saved working-tree lines. The active-line label joins the author, commit
subject, eight-character commit hash and local medium date; uncommitted (zero-SHA) lines and lines
without an author have none. A consumer displaying blame in an unsaved draft must first map
unchanged draft lines back to saved lines; inserted and replaced lines do not inherit another
line's author.

Change navigation counts change blocks rather than changed lines: adjacent deletions and
additions are one block, and context separates blocks. It disables at either boundary instead of
wrapping.

The comparison loader retains the Git worker's bounded text-read limits. It does not silently
replace an oversized baseline with current content. Presentation, selected-source persistence,
editor diff sessions and search controls remain responsibilities of their consumers.

The Files text editor displays live comparisons in unified or split layout with wrapping and all
unchanged context expanded. Edits update the caller-owned draft without saving or reading Git.
Empty drafts keep an editable caret row; equal empty files have no change blocks, and typing or
undoing against an empty baseline updates navigation without treating that caret row as a change.
Staged and Committed content supplied as snapshots is read only, including an empty snapshot.
Changing the layout preserves the live edit session and undo history. Changing the baseline,
document revision, entering or leaving a snapshot, or switching between a plain document and a
comparison starts a new edit session; the current draft and caret are retained when the document
revision is unchanged.

Active-line blame appears only on the new side of an editable document. It maps unchanged draft
lines to saved lines with a line diff bounded to 262,144 UTF-16 characters per input and an edit
length of 512. Inserted or replaced lines and unavailable bounded mappings have no label. The
label follows the caret and is removed when its row leaves the rendered window or blame is disabled.
