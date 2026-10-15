# Backup Snapshots

## Purpose and ownership

Backups is the user-facing recovery surface for whole-Profile snapshots. Rust
Core Administration owns snapshot consistency, validation, publication,
retention, restore eligibility, and background job recovery. Electron Main
adapts those typed operations and keeps automatic schedules alive. Settings
presents status and intent; closing the page never cancels an accepted job.

Only a completed, fully validated snapshot appears in the restorable list. A
queued, running, cancelled, or failed job is operational state, not
a restorable snapshot.

## Creating a snapshot

A snapshot includes the Store, managed assets, the complete execution database,
execution identity and image attachments, and recoverable Codex/Claude native
history. Runtime activity and queued work must finish before capture; a snapshot
never interrupts an active conversation. History is captured in full regardless
of the transcript window currently visible in the UI.

Provider credentials remain in the configured account. Restored Codex and Claude
Sessions retain their native IDs and resume using that account. ACP and OpenCode
transcripts remain readable, while native continuation requires their original
external history service or files.

`Create snapshot` starts one manual background job. Settings acknowledges the
start immediately, clears the optional label, and shows the current phase and
progress while the app remains usable. Reopening Backups, opening it in another
window, or restarting Nodex reconnects to the same durable job rather than
starting a duplicate.

The progress surface identifies database capture, managed-asset capture,
validation, digesting, and publication as distinct phases. Database capture may
report copied and total pages plus transient retries. Progress is evidence from
Core, not a renderer timer estimate.

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

## Restore boundary

Restore accepts only completed inventory entries and independently validates
the selected database, manifest, managed-asset and execution-history closure. The optional safety
snapshot uses the same complete backup boundary before replacement begins.
The old execution process is closed before installation and cannot write through
its replaced database connection. A failed or interrupted install recovers every
Profile component together.
Restore behavior and crash recovery are specified in
[Backup, Restore, and Maintenance](../reliability/backup-restore-and-maintenance.md).
