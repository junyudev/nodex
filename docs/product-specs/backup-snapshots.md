# Backup Snapshots

## Purpose and ownership

Backups is the user-facing recovery surface for Profile content. A snapshot holds what
Nodex alone writes: the Store, which contains Pages, Databases, Library Files, Projects and
how Sessions are organized, together with its managed assets. Rust Core Administration owns
snapshot consistency, validation, publication, retention, restore eligibility, and
background job recovery. Electron Main adapts those typed operations and keeps automatic
schedules alive. Settings presents status and intent; closing the page never cancels an
accepted job.

Only a completed, fully validated snapshot appears in the restorable list. A
queued, running, cancelled, or failed job is operational state, not
a restorable snapshot.

## Creating a snapshot

A snapshot is taken while Nodex keeps working. Agents keep replying, queued messages keep
starting, and edits keep saving; a snapshot never waits for, pauses, or interrupts any of
them. Its content is the Store exactly as of one moment during capture.

Conversations are not part of a snapshot. Chat transcripts belong to the Agent Runtime, and
each Agent keeps its own native history in its own home. Nodex never reads, copies, or locks
an Agent's home for a backup, so other apps using the same Agent account are unaffected.

`Create snapshot` starts one manual background job. Settings acknowledges the
start immediately, clears the optional label, and shows the current phase and
progress while the app remains usable. Reopening Backups, opening it in another
window, or restarting Nodex reconnects to the same durable job rather than
starting a duplicate. `nodex backup create` starts the same job from the command line.

The progress surface identifies database capture, managed-asset capture,
validation, digesting, and publication as distinct phases. Database capture may
report copied and total pages. Progress is evidence from Core, not a renderer
timer estimate.

The user may cancel while work is queued or running before publication. A
successful cancellation publishes no snapshot. Once commit or publication has
begun, cancellation is disabled because finishing the atomic transition is
safer than exposing a half-published artifact.

Failure leaves the existing snapshot inventory unchanged and presents a safe
diagnostic message. Retrying starts a new job unless Core can prove that the
same accepted job is being recovered.

## Capacity and retention

Backups shows total stored snapshot bytes, available filesystem capacity, and
the estimated space required for the next safe snapshot. Creation is disabled
when the preflight cannot preserve staging and safety headroom.

Automatic snapshots obey both the configured maximum count and a shared byte
budget. Retention removes the oldest automatic snapshots until both constraints
hold. A manual snapshot or pre-restore safety snapshot is never removed by
automatic retention; the user must explicitly delete it.

## Storage optimization

Backups also reports whether Core is optimizing snapshot storage. This status
refers to gradual measurement, pruning, and physical reclamation of short-lived
delivery and retry evidence inside `nodex.db`; it does not mean user Pages,
Documents, semantic revisions, or manual snapshots are being deleted.

Optimization runs in bounded background slices and remains safe across quit or
restart. While it is active, Settings reports remaining unmeasured records or
that old delivery history is being trimmed. When it completes, the retained
operational-history size remains visible.

## Restoring a snapshot

Restoring rewinds content, not conversations. Pages, Databases, Library Files, Projects,
and each Session's Project, archive state and linked Pages return to the snapshot. Chats
keep their current transcripts and continue with their Agents as before:

- A chat started after the snapshot stays. It returns to its Project, or appears without a
  Project when the snapshot predates that Project. Chat names are content, so such a chat is
  named from its opening message.
- A chat deleted after the snapshot stays deleted.
- Links from a chat to Pages follow the snapshot, because Page links are content.

Restore stops any reply that is still running, then restarts Nodex. Agent processes outside
Nodex and every Agent's own history are untouched.

Restore accepts only completed inventory entries and independently validates the selected
database, manifest and managed-asset closure. The optional safety snapshot is taken
immediately before replacement, with no write window between them. A failed or interrupted
install recovers the Store and its assets together. Restore behavior and crash recovery are
specified in [Backup, Restore, and Maintenance](../reliability/backup-restore-and-maintenance.md).
