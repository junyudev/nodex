# Codex Managed Worktree Lifecycle Behavior

## Intent

This document owns the product contract after a managed Git worktree has been
allocated for a Codex Chat. It covers durable execution-location identity,
sidebar presentation, snapshot-before-removal, Environment cleanup, restore,
archive ownership transfer, automatic retention, permanent-worktree
protection, and moving an existing Chat between checkouts, worktrees, and
execution hosts.

Creating a new worktree and starting or forking a Chat is specified in
[Codex Worktree Creation Behavior](codex-worktree-creation-behavior.md).
General Project, Session, and Chat identity remains in
[Codex Workspace Behavior](codex-workspace-behavior.md). Transcript rendering
remains in
[Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md).

The capabilities in this document fail closed when their required host adapter
or app-server operation is unavailable. Nodex must not expose a control or
agent tool that reports success without performing the promised lifecycle
operation.

## Execution location

Every Codex Chat has one canonical execution location:

- a local checkout;
- a local managed worktree;
- a checkout on a registered remote execution host; or
- a managed worktree on a registered remote execution host.

Core Workspace owns the durable host id, cwd, managed-worktree path, runtime
workspace roots, and Project assignment for the Chat. A location change commits
those coordinates together. Main may cache and project the location but cannot
persist a second semantic authority. A renderer never infers the location from
path spelling.

App-server cwd and runtime roots are runtime observations, not durable
execution-location authority. Every resume of a managed-worktree Chat sends
Core's exact cwd and writable roots again. Metadata returned by `thread/read`
or `thread/resume` cannot replace those coordinates, including when the host
reports an equivalent platform spelling such as `/private/var` for `/var`.
The cwd and managed-worktree path therefore remain one coherent path identity;
a worker never receives one spelling as its authorization root and another as
the path to mutate.

The first Session-to-Chat link publishes the Chat and its complete execution
location in the same Core revision. Lifecycle planning reads every Chat that
consumes a managed-worktree path, together with pinned, archived, activity, and
Project-source protection metadata, from one revision. An incomplete or
ambiguous snapshot fails instead of presenting missing protection data as an
empty set.

The Project's source catalog is independent from a Chat's execution location.
Moving a Chat into a worktree replaces only the primary execution root. Other
Project source roots retain their order. The source checkout that was replaced
does not remain writable merely because it belongs to the same Project.

## Sidebar identity

A ready managed-worktree Chat displays the shared worktree glyph at the resting
end of its sidebar row. A pending worktree displays the same identity with its
pending treatment. Hover or keyboard focus reveals the normal row actions in
the same trailing space rather than adding another rail or changing the row's
height.

The glyph is presentation only. It has no independent accessible name and does
not change the row's accessible name, which remains the Chat title. The local
tooltip is `This conversation is running in a local git worktree.` Remote
worktree presentation identifies both the execution host and worktree.

The row hover card presents Project, branch, and worktree as separate facts.
The worktree label is a stable human-readable repository/worktree label, not a
short allocation token or the complete absolute path. A pending item whose
path has not been allocated may show worktree identity without inventing a
path-derived label.

## Physical and logical ownership

A managed worktree is created by the user account that owns the execution host.
Nodex does not change POSIX ownership. The worktree remains linked to its source
repository through Git's common directory.

The active Chat owner is recorded under the source repository's Git worktree
metadata as `codex-thread.json` with versioned content:

    {
      "version": 1,
      "ownerThreadId": "<thread id>"
    }

This file coordinates host-local lifecycle work; it does not replace Core's
durable Project, Session, or Chat relationship. When several Chats share one
worktree, one is the physical owner and all remain logical consumers.

## Snapshot contract

Before a retained managed worktree is removed, the host worker captures its
complete materialized state in the source repository at:

    refs/codex/snapshots/<worktree-id>

`worktree-id` is the SHA-1 digest of the normalized worktree path. The snapshot
contains tracked working-tree changes, staged changes, binary content, file
modes, and eligible untracked files. It is constructed with a temporary Git
index and never stages, resets, or otherwise mutates the user's real index.

Eligible untracked entries are regular files and Git symlinks that remain
within the worktree root and are not excluded by Git ignore rules. Socket,
device, FIFO, path-escape, unreadable, and over-bound inputs fail snapshotting;
they are never silently omitted from a required recovery point.

If the snapshot tree is identical to `HEAD`, the ref points to `HEAD`. Otherwise
the worker creates a synthetic commit whose parent is `HEAD` and whose message
identifies the removal reason. An unborn repository produces a synthetic root
commit. Updating the snapshot ref is atomic and repeatable; a later snapshot of
the same worktree replaces its recovery point only after the new object graph
is complete.

Snapshotting preserves the materialized filesystem tree, not the distinction
between staged and unstaged changes after restore. Restoring materializes the
captured tree from its commit.

## Removal policies and ordering

Every physical removal has a typed reason. The reason selects one of three
snapshot policies:

- Archive, automatic retention, and automation archival require a successful
  snapshot. Failure stops removal.
- An explicit targeted removal in Worktree settings attempts a snapshot but may
  continue after a reported snapshot failure.
- Failed creation, retry, and cancellation before a worktree is retained are
  ephemeral cleanup and do not create a recovery snapshot.

There is no generic renderer-controlled force-delete operation.

For a retained worktree, removal proceeds in this order:

1. Apply the required snapshot policy.
2. Resolve the selected Environment from worktree Git metadata.
3. Read its cleanup configuration.
4. Run the configured cleanup script from the worktree with
   `CODEX_SOURCE_TREE_PATH` and `CODEX_WORKTREE_PATH`.
5. Ask Git to remove the worktree.
6. Remove only validated managed-root residue and empty allocation directories.

An unreadable or no-longer-present Environment configuration is recorded and
does not by itself make the worktree undeletable. A cleanup script that was
successfully resolved but exits unsuccessfully prevents deletion. Cleanup
output and failure are visible to the initiating surface.

All removal requests are single-flight by execution host and normalized path.
Concurrent requests cannot run cleanup twice or race two physical removals. A
stricter snapshot policy can subsume a weaker pending request; a required policy
is never downgraded.

## Availability and restore

Opening a managed-worktree Chat inspects its execution location before treating
the missing cwd as an ordinary load failure. The canonical availability is one
of:

- `available`: the cwd is usable;
- `restorable`: the worktree is absent and a matching snapshot exists;
- `gone`: the required cwd no longer exists and no supported restoration path
  applies; or
- `unavailable`: Nodex could not complete a reliable inspection.

A restorable Chat shows:

- `Worktree cleaned up`
- `This chat’s worktree was removed to save disk space`
- `Restore worktree`

A gone Chat shows `Current working directory missing` and
`This chat’s working directory no longer exists` without a restore action. An
inspection failure shows `Couldn’t check worktree status`,
`Retry to verify this chat’s working directory`, and `Retry`.

Restore recreates the worktree at its durable path with the snapshot ref. If an
existing path already represents the same snapshot, restore succeeds
idempotently. A conflicting existing path is never overwritten. For a nested
cwd, the worker materializes the required relative path through the repository's
sparse-checkout mechanism when needed. Failure removes only the worktree
created by that restore attempt. Rewriting owner metadata is best effort and a
failure is surfaced as a warning without deleting successfully restored data.

After restore, Main refreshes the Chat's app-server hydration, runtime roots,
permissions, sidebar projection, and availability before allowing the next
Turn.

## Archive and shared worktrees

Archiving one Chat does not remove a worktree that another non-archived Chat
still consumes. Main selects an eligible replacement whose cwd remains inside
the worktree, writes the replacement owner, and archives the requested Chat.

When the archived Chat is the final consumer, a non-permanent managed worktree
uses required-snapshot removal. Permanent Project roots and other explicitly
protected roots are never removed as an archive side effect. A failed snapshot
or cleanup cannot be hidden by deleting the durable execution metadata.

## Worktree settings

The Worktrees settings surface owns three Main-persisted preferences:

- `Worktree root`: the root for future managed worktrees; blank uses the
  default. Changing it does not make existing worktrees unmanaged.
- `Automatically delete old worktrees`: enabled by default.
- `Auto-delete limit`: an integer of at least one, defaulting to 15. The saved
  value remains when automatic deletion is disabled.

Each execution host has exactly one current managed root. That root controls
future creation and physical inventory discovery; changing it replaces the
previous discovery root and does not create root history. Existing Chats keep
their exact Core-owned execution locations, so inspection, restore, archive,
handoff, and cleanup continue to target those paths after the current root
changes. A legacy `worktree_known_roots` value is ignored and is removed on the
next canonical worktree-settings write; Nodex neither scans nor deletes those
paths implicitly.

The surface queries one selected host at a time and defaults to Local. Local
worktree and retention preferences are editable only while Local is selected.
An enabled SSH host shows a read-only inventory and the managed root from that
host's execution-host configuration; local preferences are never projected as
remote settings.

Disabling automatic deletion requires an explicit danger confirmation. The
surface explains that disabling it transfers disk-usage management to the
user, while enabling it prunes older managed worktrees only after snapshots
make them restorable.

One inventory refresh sends one worker request for the selected host's current
root. The worker recognizes legacy four-hex allocation parents and current
`YYMMDD-HHMM-xxxxxxxx` allocation directories. Unrelated and symlinked
two-level directories are ignored. A correctly named entry remains visible
when its Git metadata is missing or damaged; its source repository is unknown
so the user can still identify and remove residue. A missing or unreadable root
produces an empty inventory, while an unexpected host/worker failure uses the
surface's retryable load failure.

The inventory groups physical worktrees by source repository and lists every
associated Chat using a bounded bulk Core projection. Permanent Project roots
are excluded. Targeted deletion first revalidates that exact host/path against
a fresh physical inventory, archives the associated Chats without triggering
per-Chat cleanup, then asks the lifecycle owner to remove the physical
worktree once. The Chat records and execution locations remain available for
inspection and restoration.

## Automatic retention

Automatic retention constructs one consistent plan before deleting anything.
It protects:

- permanent or stable Project roots;
- roots used by pinned Chats;
- pending worktree roots;
- newly allocated roots that have not completed owner registration;
- roots owned by in-progress Chats;
- ownerless roots younger than one hour; and
- compatibility-protected roots whose ownership cannot be classified safely.

If pinned or Project protection metadata cannot be read reliably, the entire
retention pass is skipped. Missing metadata is never interpreted as an empty
protection set.

Eligible ownerless worktrees are ordered oldest first by birth time. Eligible
owned worktrees are then ordered oldest first by owner Chat update time. The
configured number is retained from the eligible set; protected roots do not
consume that allowance. Ownerless roots created before
`2026-02-21T00:00:00.000Z` remain protected while the owner-metadata migration
guard is active. Deletions use the required
snapshot policy, are deduplicated by host and path, and run with bounded
concurrency. One failure does not authorize bypassing protection for another
candidate.

Immediately before physical removal, retention recomputes the plan from the
current settings, host inventories, lifecycle, automation, pending, newborn,
and permanent-root facts. A changed limit, disappeared entry, or newly
protected candidate therefore cannot be deleted from a stale plan.

Scheduled automations use the same creation, owner, snapshot, cleanup, and
retention lifecycle and the same host worker as interactive creation. A
running, retrying, or otherwise live automation protects its worktree.
Retention is requested after application initialization, successful owner
registration, Chat archival, and a retention-setting change. Requests are
coalesced; only one plan runs at a time and at most three removals execute at
once.

## Permanent worktrees and multiple source roots

A permanent worktree adopted as a Project source is not an automatically
managed temporary worktree. It is excluded from inventory and automatic
retention until the user explicitly removes it from the Project.

Creating or moving to a permanent worktree replaces the Project's primary root
for that execution context and preserves all additional source roots in order.
Workspace-write permission includes the new primary, the additional roots, and
explicit custom writable roots. It does not silently retain write access to the
old primary checkout.

Local creation, setup, snapshot, cleanup, and restore execute as the logged-in
desktop user. Nodex does not change ownership with `chown`. A created worktree
and its owner metadata therefore retain that user's uid/gid and normal
directory/file modes, while Git's common directory remains the source
repository's Git metadata directory. Host workers reject path escape and
symlink traversal before copying or removing content. A remote worker applies
the same rule under the authenticated remote login user; local filesystem APIs
never inspect or mutate a remote path.

Permanent Project roots are lifecycle protection data, regardless of whether
their physical path happens to sit below a configured managed root. Inventory,
archive cleanup, and retention never treat them as removable. Removing a
permanent source from a Project first changes that protection fact and then
uses the explicit Project-root-removal lifecycle reason; it is never an
automatic-retention side effect.

## Moving a Chat

Moving a Chat is a real execution-location transaction. It retains the same Chat
identity and history while moving its Git state and subsequent execution
between a checkout, a managed worktree, or a registered execution host.

The transaction:

1. Stops or waits for an active Turn according to the user-visible operation.
2. Captures source Git state and prepares the destination without destroying
   the source.
3. Transfers missing Git objects and rollout state when hosts differ.
4. Applies the destination state and resolves branch or dirty-destination
   conflicts without destructive reset.
5. Switches the app-server's cwd and runtime roots.
6. Commits the complete durable execution location in Core.
7. Refreshes runtime caches, ownership, sidebar, browser/diff context, and other
   path-sensitive Chat metadata.
8. Cleans or transfers ownership of the source only after the destination is
   authoritative.

Main keeps a durable operation journal around effects that cannot share one
database transaction. Recovery preserves at least one complete usable copy.
Failure before durable commit rolls back the destination and keeps the source;
source cleanup failure after commit leaves the Chat at the destination and
reports a recoverable warning. A follow-up prompt is sent only after durable
commit and at most once.

For a local checkout-to-worktree move, the host worker creates a detached
destination, moves the source branch into it, and transfers tracked, staged,
binary, and untracked changes through an operation-labelled Git stash. The
local checkout remains on a safe branch. Moving back first requires a clean
local checkout, detaches the managed worktree from its branch, checks that any
same-named local branch still identifies the expected commit, and applies the
complete materialized state locally. A conflicting branch or dirty destination
fails before overwriting either copy. Compensation reverses the same Git
operation and removes only a destination created by that handoff.

Only one handoff may run for a Chat at a time. Main journals the source,
prepared destination, runtime-switch and Core-commit boundaries with an atomic
replace. On restart it reads Core's canonical location to decide whether to
finish destination ownership/cleanup or restore the source; an unavailable or
ambiguous canonical read defers recovery without mutating Git.

The app-server owns Thread runtime methods but not worktree lifecycle. A loaded
Chat is first interrupted when it has an active Turn, then receives
`thread/settings/update` for cwd and sandbox policy and a same-rollout
`thread/resume` for the complete cwd/runtime-root projection. An unloaded Chat
resumes with the new cwd and runtime roots. A non-empty rollout path must match
the loaded Thread's active rollout path; a mismatch fails closed before the
runtime location changes.

Runtime cwd overrides are not Nodex's durable location authority. A complete
app-server restart may or may not expose the last override through a cold
`thread/read`, so every resume reprojects the canonical execution location from
Core. Nodex advertises handoff only when the pinned app-server version and
methods, Core's atomic location mutation, and both source and destination host
transaction effects are available. Persisted older tool catalogs also fail
closed at execution when those capabilities are unavailable; they cannot fall
back to a UI-only or metadata-only move.

## Remote execution hosts

A remote worktree operation is routed entirely to the host that owns its path.
Local filesystem code never inspects or deletes a remote path. Remote capability
is visible only for a registered, health-checked adapter with repository,
worktree, execution, cancellation, and file-transfer support.

SSH credentials and private keys remain with the operating system's SSH
configuration and agent. They are not sent to the renderer, stored in Core, or
included in lifecycle logs. Host-key verification is not weakened. Commands
use validated arguments and paths rather than prompt-derived shell strings.

Cross-host movement snapshots the source, transfers missing Git objects through
a temporary bundle, and transfers rollout state through private operation-owned
directories. Every file is bounded and verified by size and SHA-256 before use.
The destination worker imports Git through
`refs/codex/handoff/destination/<operation>` into a detached managed worktree
and installs the rollout at the same Codex-home-relative sessions path before
the destination app-server resumes the unchanged Chat id. It never keeps a
runtime dependent on a temporary staging rollout.

Only the primary workspace root is replaced. Additional roots retain their
authored order and path identity, and each must already resolve to a non-symlink
directory on the destination host; otherwise preparation fails before Core
changes. The destination app-server receives the rewritten cwd, complete root
list, and matching sandbox writable roots together.

After the destination runtime and Core location commit, ownership moves to the
new worktree. A managed source is snapshot-required before removal; a source
checkout is retained. Temporary refs, bundle copies, transfer directories, and
Main relay files are then removed. Rollback removes only the destination files
created by the operation and keeps the source. If an SSH result frame is lost
after the remote import completed, compensation scans the authorized
destination repositories for the deterministic destination ref, finds only a
matching worktree under the configured managed root, and removes it. It never
repeats an unknown mutation or treats a timeout as proof that nothing happened.
The transaction fiber's cancellation signal reaches each app-server and host
worker operation. If cancellation races an import after destination state may
exist, compensation does not reuse that already-aborted signal: it submits one
operation-fenced cleanup to the destination host's still-live Scope. Main
shutdown may interrupt that host Scope; the durable handoff journal then remains
the authority for startup recovery.

## Runtime and protocol boundaries

The renderer can request product operations through typed IPC but cannot invoke
raw worker methods, choose snapshot refs, or supply a force flag. Main validates
the Chat, host, path, Project protection, and requested operation before calling
the host worker.

The worker protocol is a runtime contract, not only a TypeScript type. Both
local worker-thread and remote JSON-lines adapters validate an outbound request
with the same versioned codec used by the worker before dispatch. Invalid
producer data fails locally without terminating an otherwise healthy worker;
transport exit and unknown remote execution state remain distinct failures.

Core does not inspect Git, execute scripts, or store snapshot refs. The host
worker does not mutate Core or renderer state. The app-server protocol does not
gain a managed-worktree method or a `worktreeInit` item.

The client-only worktree initialization activity remains app-side and is
filtered from accepted app-server history. Main retains it in the live
conversation document, so replacing or reloading a renderer preserves the
activity and its position before the first user prompt. It is not a durable
protocol item or Core record: restarting Electron Main, including a complete
application restart, rebuilds the transcript from app-server history without
that activity. The Chat's durable worktree location, sidebar identity,
availability, and restore capability remain intact across that restart.

## Verification contract

Lifecycle tests use disposable repositories and explicit temporary worktree
roots. They cover clean, dirty tracked, staged, binary, untracked, nested-cwd,
unborn-HEAD, cleanup failure, cancellation, shared-owner, retention, restore,
and handoff cases. Destructive tests assert path containment before cleanup and
never operate on a user's real Project source.

Renderer behavior tests cover roles, accessible names, keyboard and focus
contracts, action visibility, and state transitions. Exact geometry, tokens,
icons, portal placement, and motion live in focused Storybook/runtime visual
evidence rather than source-string tests.
