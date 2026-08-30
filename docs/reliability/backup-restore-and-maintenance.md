# Backup, Restore, and Maintenance

## Backup boundary

A whole-Store backup contains the SQLite database and managed assets from one
Core Administration boundary. Core drains admitted Store writes, blocks new
Store work, flushes/validates authority, and creates the SQLite snapshot before
enumerating assets. Host materialization publishes a new immutable file by
fsyncing a temporary file in a sibling same-filesystem staging directory, then
atomically renaming or linking it into the managed asset root. Staging files are
outside the backup closure.
Therefore a concurrent publication can only be absent from both the captured
database and its required closure, or appear as an unreferenced extra asset; a
partially written file is never observable.

The staged database, asset files, manifest, and their directories are fsynced
before the backup is published. After the complete SQLite integrity,
foreign-key, schema, and invariant validation succeeds, the current manifest
records that evidence version together with the database SHA-256 and a
deterministic digest over every asset path, length, and byte. Backup identity
and result are receipt-backed; retention starts only while the same Core
authority remains active. Restore still performs its own strict
installed-candidate validation.

Creating a backup returns `submitted` as soon as Main owns the background
operation and identity; this is not a claim that Core has already written its
job journal. The renderer retains that exact normalized command across unknown
transport outcomes and reconnects with the same identity. When another backup
already occupies the lane, Core writes a no-op receipt that durably coalesces
the new operation identity to the active job and returns `already_running`;
replay preserves that relationship across response loss and Main restart.
There is no elapsed-time admission failure.

The coordinator records each execution phase under the Profile control
directory, resumes or adopts interrupted jobs on startup, and exposes
database-page, asset-byte, validation, digest, publish, and writer-held
progress. Cancellation is accepted before publication begins; once publication
is the only remaining safe transition, the job finishes atomically.

Database capture uses SQLite's online-backup API on a dedicated connection in
bounded steps with transient-busy retry. A managed-asset snapshot lease holds
the immutable closure derived from the captured database while files are
copied. The staged artifact is fully validated once and represented by an
in-process verified capability; the normal publish path consumes that
capability instead of rereading and rehashing the artifact. Recovery and restore
never trust the process-local capability and therefore fully revalidate anything
adopted from disk.

Manual and scheduled backups use the same operation. Automatic interval and
retention are Profile settings described in [Configuration](../CONFIGURATION.md).
Automatic snapshots obey both a count limit and a total-byte budget. Manual and
pre-restore snapshots are never silently removed by that policy.
The UI reports environment-managed values without pretending to overwrite them.

## Restore preflight

Restore is explicit and exclusive. Its optional safety backup is created after
the same Store/asset fence is acquired and before replacement, with no reopened
write window between those operations.

Core rejects a candidate unless it passes:

- exact supported Store schema and authority metadata;
- SQLite integrity and foreign-key checks;
- Block ownership and document-bearing owner invariants;
- ready Document/head/projection consistency;
- a complete managed-asset closure containing only safe flat regular files;
- no symlink, unsafe filename, missing referenced asset, or unknown object.

## Journaled replacement

Database, WAL, and assets are one recoverable replacement. Core records and
fsyncs a replacement journal before moving live/staged pieces. Every rename and
parent directory is fsynced. Startup recovery either restores the complete
previous authority or finishes the complete new authority; it never mixes
database and asset generations.

After installation, Core rotates the Store epoch transactionally, invalidates
subscriptions and process-local leases, and returns a committed receipt. A
missing Host response cannot turn that durable success into failure. Electron
submits its first-wins shutdown request in the same uninterruptible post-commit
step. Relaunch begins only after the complete Main application scope has
released, so no old Adapter can continue using the replaced authority.

Pre-restore renderer checkpoints, outboxes, Awareness, stream cursors, and
Document sessions fail closed on the new epoch. Surfaces remount from current
descriptors and canonical content; no old local edit can replay into the
restored Store.

## Development Profile clones

Offline development provisioning may materialize a current evidence-backed
published backup into a new Profile home. The source Profile remains unopened:
Core reads only the backup package, copies `nodex.db` and its managed-asset
closure into a private sibling staging directory, and rejects symlinks,
existing targets, or source/target ancestry overlap. Regular-file copying uses
the platform's clone-or-copy primitive, which prefers APFS CoW on same-volume
macOS and falls back safely elsewhere. The copy preserves Profile, Library,
content, history, Project identities, and the imported Store epoch for
production-shape fidelity while reminting the Agent token key and automation
jitter salt. It is an isolated local fork: post-clone history may diverge under
the imported coordinates and is never merged, synchronized, or replayed into
its source.

Core verifies the copied database and asset-tree digests before reminting, then
validates schema/epoch identity, document authorities, every present managed
asset, and missing-asset evidence without repeating the publication-time SQLite
integrity scan. It writes and syncs the private `profile-snapshot.json` receipt,
then atomically renames the staging directory into place. Because the staging
tree is disposable and exactly reproducible, development cloning omits
per-file fsync for the copied database/assets while retaining receipt and
directory publication syncs. A power-loss-damaged fork must be deleted and
recreated from its unchanged backup. Failed provisioning removes only the owned
staging directory and never modifies the source backup. This is a local
development input path, not a restore into a running Profile.

## Maintenance

Core Administration orders integrity checks, foreign-key checks, Document
compaction, revision retention, deleted-Block collection, and incremental
vacuum through one maintenance coordinator. Callers request intent, not an
arbitrary sequence of storage operations.

Scheduler due-work reads are bounded candidate probes. They may inspect the
owning subsystem's indexed eligibility state, but they do not perform a full
Store integrity scan, foreign-key scan, or evidence-closure plan merely to
decide whether work is due. Complete Store validation belongs to explicit
open, migration, backup, restore, and replacement boundaries; each maintenance
mutation still relies on enforced foreign keys and its own fail-closed local
evidence checks.

Maintenance is idempotent where possible and reports typed partial/deferred
outcomes. Operational delivery and receipt retention runs as self-silent short
transactions with durable counters and floors; product maintenance writes a
receipt only when it actually changes semantic state. Maintenance never removes
pinned revisions. A risky migration or large maintenance operation
should begin from a labeled manual backup.

Operational pruning is driven by bounded commit/receipt identity sets. Every
foreign-key check, detach, and semantic-reference guard on that deletion path
has an index whose leading columns match the lookup; a bounded result is not a
bounded maintenance pass if SQLite must scan an unbounded child ledger to
prove deletion safety. Logical evidence deletion converges before physical
page reclamation begins. Profiles created by current Nodex use incremental
auto-vacuum; once no logical slice made progress, Core reclaims individual
freelist pages in chunks of at most 64, checks the same time budget between
chunks, and yields after at most 256 pages per pass. A successful physical pass
advances only the existing maintenance scheduling revision, so the next pass
receives a fresh due-work identity without manufacturing a LocalCommit,
receipt, replay event, or history row.
An existing Profile whose database header uses another auto-vacuum mode is not
silently rewritten or subjected to a full `VACUUM` during ordinary maintenance.

Online maintenance does not hold the serialized writer for a complete pass.
Block collection first plans a globally bounded set of the oldest eligible
tombstones through a consistent WAL reader snapshot. Retained Document
versions project their Block and Database-view identities when the checkpoint
is created; upgraded Stores backfill at most one immutable checkpoint per
reader plan before collection begins. Candidate analysis queries that bounded
identity projection instead of rebuilding every retained checkpoint. A
tombstone that is still retained records the commit fence it was evaluated
against and a bounded retry time, so later candidate probes advance past it
instead of repeatedly rescanning the same uncollectible prefix. A product commit
or retry expiry makes the candidate eligible for reevaluation. Collection then
processes short candidate slices through separate writer commands. Each writer slice checks the
snapshot's LocalCommit fence, and each candidate still commits atomically;
interruption or an intervening product commit may leave earlier candidates
collected, and replaying the same receipt-backed operation safely converges from
a fresh plan before the final receipt is written. Request-class scheduling can
run queued interactive work between those slices, while aging guarantees
maintenance eventually receives another slice.

Main serializes maintenance lanes through a FIFO permit. Each lane can queue at
most its one scheduler fiber, so a high-frequency migration or retention lane
cannot repeatedly win a try-lock and starve another due responsibility. Only a
Core due-work plan may move a lane to its idle cadence; contention and stale
evidence remain active work and are replanned without warning noise.

## Recovery evidence

Backup/restore tests exercise interruption at each journal phase, invalid
assets, corrupted databases, epoch rotation, and stale-client rejection. Current
schema values, journal filenames, and physical steps belong to the
Administration implementation and tests rather than this contract.
