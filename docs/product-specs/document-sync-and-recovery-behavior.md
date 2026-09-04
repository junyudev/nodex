# Document Sync and Recovery

Nodex edits a local document replica and confirms a save only after Core commits
it. Connection state, durable save state, and local recovery protection are
separate facts. The normal save round trip stays visually quiet.

Page, Canvas, and manual version saves remain available in long-lived Profiles
and editor sessions. Each new save receives a fresh bounded submission identity;
retries retain the original identity and payload. An expired or uncertain older
submission remains explicit recovery work and is never silently reissued as a
new edit.

## Connection and failure

Each open document has one logical Main session. Main owns replacement physical
streams and their retry policy. A missing exact subscription obtains a fresh
validated barrier; the renderer synchronizes canonical state before retrying
its original pending update. Opening an IPC subscription or pressing Retry does
not itself prove that a stream is connected.

Temporary transport, deadline, or busy failures retain pending identity and
bytes. Protocol incompatibility, invalid updates, revoked access, and unsafe
structural conflicts stop the affected replica. They are never presented as an
indefinite Offline state with no recovery owner. Other documents remain usable.

A late physical stream finalizer cannot remove its replacement's authorization.
Every replacement barrier checks document identity, engine, and Store epoch.
Store replacement continues to require the application relaunch boundary.

## Waiting for a structural edit

Reorder, owner deletion, structural paste, and structural history must finish
native drag and input-method state and obtain a committed document head. One
absolute 10-second preparation deadline covers this work, beginning when the
operation is queued. After 700 ms, the document status shows `Waiting for save…`
and offers Cancel. Escape also cancels the active editor preparation.

Cancel, timeout, deactivation, or disposal removes only the operation's wait.
Pending content continues saving. A cancelled operation cannot submit when the
old save later completes, and the next operation can proceed. Once a Core
mutation may have been submitted, its exact identity and receipt determine the
outcome; cancellation does not claim to undo a possible commit. A later user
focus choice wins over focus restoration. Refreshing callbacks or props for the
same Document and access context preserves queued and active waits. Actual view
deactivation, authority change or explicit Cancel ends those waits.

## Local protection and recovery

The renderer writes batched incremental Yjs deltas to IndexedDB. Each completed
transaction covers a particular surface's local edit version. An older write
finishing after a new edit does not cover that edit. Only covered pending work
may be described as retained on the device. Disabled, unavailable, or lagging
local storage is described as work held in the current window.

Before transport, a local submission journal records the exact update identity
and bytes when IndexedDB is available. A verified ACK removes only that entry.
Local journal failures do not prevent Core durability; they remove the claim of
crash protection. A finite local journal wait also keeps unavailable IndexedDB
from indefinitely blocking a Core save.

On reset or deterministic failure, the provider stops that replica and captures
its full Yjs state, schema identity, original epoch/generation, local coverage,
original in-flight request, and error evidence. An IndexedDB transaction retains
the shared boundary's cached bytes and unresolved requests before retiring that
exact active checkpoint. It never clears every generation of a document.
Failed preservation leaves the original checkpoint and live replica available;
Reload refuses to destroy that only copy.

Closing a Page tab also retains its document runtime when pending edits have
neither a Core acknowledgement nor a completed checkpoint covering their local
version. Reopening that Page can reuse the retained replica. A disabled cache
does not count as successful local protection merely because its no-op returns.

After restart, an unresolved submission from a previous session is retained as
a separate recovery draft. It is not replayed under a new request identity.
Canonical content stays editable. Same-boundary deltas without unresolved
submissions can merge through normal canonical synchronization.

## Review retained edits

`Unsaved edits · Review` opens a shared, root-hosted review dialog. It describes
retained drafts independently of the current document's save state. Closing the
dialog or choosing Later keeps the draft pending without opening another alert.
A protected failed replica also offers Continue editing to start a fresh canonical
session. Page and Canvas use the same persisted resolution lifecycle.

The list reads bounded summaries; selecting a draft loads one package and one
read-only preview. Current content can be compared with After restoring when a
safe merge is available, or with Retained draft when no reliable merge exists.
The Backups settings page also lists Library drafts across documents and
generations, including drafts whose source no longer exists. Recently handled
entries remain available there and in the review dialog.

Core determines the available actions:

- Restore edits creates a new forward commit after rechecking the draft revision,
  current document head, generation, authorization, schema and structural barriers.
  Existing unrelated content is preserved. Safety and result versions are recorded.
- Save as a copy creates an independent Page or Canvas in the Library, with new
  owned identities. It is offered only for a complete recoverable package. Packages
  referencing child owners or files without a captured resource closure remain
  pending and exportable; Nodex never marks a partial copy as complete.
- Discard draft requires an inline confirmation, changes no current content, and
  can be reversed with Undo discard in Recently handled.
- Export creates a local JSON recovery package containing the retained source
  envelope, encoded engine bytes, and available readable preview. It does not
  resolve the draft. Details remain secondary to content and recovery actions.

Already-saved drafts are handled automatically only when Core proves full engine
containment. Yjs evidence includes deletion sets and every shared type, not just
state-vector equality or visible text. Partial submission receipts and newer
canonical heads do not prove coverage. Canvas containment includes every retained
intent and any full retained scene. Conflicting Canvas elements remain visible
in the retained preview and cannot overwrite newer canonical elements.

Restore/copy and draft resolution commit atomically. The caller persists the new
user action's identity before sending it; an uncertain reply retries that exact
request. A second window cannot apply a stale draft revision, and all windows
converge on Core's recorded result. A changed preview requires review again.

## Protection and retention

Core durably receives an immutable, hash-checked recovery package before the
renderer retires its exact local staging row. Lost replies leave staging bytes
intact; repeated reception cannot overwrite a different package under the same
identity. Drafts are Library-owned and every operation rechecks current access.
A Core recovery artifact still covers one rejected update rather than a complete
later renderer draft. Cached content never grants new access.

Pending drafts have no age-based eviction. Handled drafts remain for 30 days,
then bounded maintenance releases their package and resource roots. Core bounds
individual packages at 32 MiB, Library recovery storage at 256 MiB and 512 drafts,
and summary pages at 50 records. Counts include pending records beyond the first
page. Capacity failure preserves unacknowledged local bytes. This protection is
not a substitute for Profile backups.

Copy diagnostics includes status, document coordinates, pending count, local
coverage, failure code, recovery kind, and artifact reference. It excludes
content, credentials, and request bytes.

For ownership, transport, and retention details, see
[Document Sync, History, and Retention](../reliability/document-sync-history-and-retention.md).
