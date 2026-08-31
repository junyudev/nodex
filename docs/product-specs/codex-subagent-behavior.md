# Codex Subagent Behavior

Status: Active
Last Updated: 2026-09-02

## Intent and ownership

Subagents are child agent Threads that remain inside one root Chat. They do not
become sidebar Chats, and their overview is not another transcript replica.
The app-server remains the execution, spawn-graph, mailbox, and transcript
authority. Core Workspace keeps a restart-safe projection of positively
observed descendants, status evidence, discovery completeness, and lifecycle
closures. Main's root-scoped Subagent Directory reconciles those facts and is
the only overview and selected-detail interface exposed to the renderer.
Subagent control currently belongs to the Chat's default local Agent host.
Remote-host control is not inferred from a conversation id: it requires an
authoritative host coordinate in the durable route and every command. Until
that contract exists, a remote registry match must not be used to send, stop,
or resume a child.

This document owns the user-visible Subagents overview, status, detail, and
root lifecycle behavior. Inline tool/activity rendering remains owned by
[Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md), while
multi-window transcript attachment remains owned by
[Codex Owner/Follower Streaming](codex-thread-owner-follower-streaming.md).

## Overview and discovery

The overview is a generation-fenced, revisioned metadata projection for one
root Chat. A row may contain child identity, parent identity, display metadata,
objective, role/model hints, normalized status, timestamps, and diff counts. It
never contains assistant answer text or a child conversation document.

Initial presentation shows at most four Active rows and ten Done rows. Each
section reports a known count; an exact total is available only after discovery
has reached an authoritative end. Until then, the count is presented as a
lower bound and absent children are never inferred to be finished. `Show more`
is an explicit metadata-expansion boundary. `Show less` returns to the initial
window and releases the expanded presentation. Neither action hydrates child
transcripts.

Discovery uses bounded app-server metadata pages and persists each verified
positive child and parent edge atomically with its page identity. A page retry
is idempotent, reusing a page identity for different content is rejected, and a
non-advancing cursor stays incomplete. Complete and incomplete are distinct
facts: an incomplete pass may add children but cannot remove, finish, or hide a
previously known child. A terminal state-database page is checked against spawn
identities already observed in the root transcript. Missing identities trigger
one non-state listing and bounded metadata-only repair; any identity that still
cannot be proven reachable keeps the universe incomplete. Background discovery
is scoped to the root and shares the app-server request scheduler's
collaboration-hydration lane.

Spawn and status notifications may arrive before a child metadata read. A
verified spawn therefore establishes the positive descendant fact first and
metadata enrichment may follow. Status evidence that precedes identity is kept
in a bounded host-generation buffer and merges immediately after discovery
proves the child edge. Overview refreshes are coalesced from canonical Thread
summary/status/archive/delete events and root-scoped Directory invalidations.
An invalidation carries no overview payload; the renderer rereads the
revisioned Core projection. A slower revision cannot replace a newer revision,
and an incomplete response cannot replace a complete response from the same
host generation.

An expanded overview is one internally consistent Core revision. Main pins the
first page's projection revision and restarts the entire bounded scan when a
later page observes another revision. Repeated mutation falls back to one
bounded page from a single revision rather than returning rows assembled from
different snapshots. A child cannot therefore appear in both Active and Done
because its status changed between pages.

## Status semantics

Overview status is `active`, `waiting`, `done`, or `unknown`. Active runtime
flags distinguish work from approval or user-input waiting. Explicit idle,
system error, terminal Turn completion, and completed child activity can
establish Done. `notLoaded` means only that the runtime is not resident; it is
Unknown and never proves completion. An interrupted Turn also leaves the child
identity resumable, so interruption alone does not permanently close it.

Status evidence is ordered within one host/source generation. Runtime
notifications and completion evidence outrank metadata, while newer evidence
of the same class outranks older evidence. Metadata may fill identity or
timestamps but cannot overwrite a stronger status. A later active Turn may
reopen an identity that had previously completed.

Unknown rows remain in the unresolved Active side of the overview instead of
being misreported as Done. They are labeled `Status unavailable`, never
`Working`, and do not run an elapsed-work clock. Waiting rows show both
`Waiting` and elapsed time. Only Active and Waiting rows update elapsed time
once per second; Done rows stop the active clock and show a stable relative
completion time. The Done section is omitted when its count is zero.

Replacing the physical app-server generation triggers one Main-owned recovery
pass for each loaded root previously known to the Subagent Directory. Core
first establishes the new generation universe and carries the prior positive
descendant graph forward while downgrading transient status to Unknown. Main
then reads one bounded metadata page. For at most 32 inherited rows that remain
Unknown, it reads only the latest Turn skeleton with `itemsView=notLoaded` and
physical concurrency two. A terminal skeleton is committed through a
generation-fenced status precondition; an absent, failed, or `inProgress`
skeleton remains Unknown. The pass neither resumes a child nor reads its items
or transcript, and it publishes one root invalidation after its Core writes
settle.

## Selected detail

Every overview, raw activity, expanded activity, and compact activity entry
routes through the same selected-child boundary. Before opening, Main verifies
that the requested Thread is a descendant of the root. A stale or unrelated
Thread id cannot open as a child detail.

Opening a child is the only ordinary parent-surface action that may attach
child history. Existing sparse resident history is reused. Otherwise Main asks
the existing Thread history Module for one bounded selected tail and reports
whether the result is resident sparse, newly attached sparse, or metadata-only.
Metadata-only results stay explicitly unavailable rather than masquerading as
an empty completed transcript. A Main-side sparse result is not `ready` until
the requesting renderer has installed the normal owner/follower role,
checkpoint, attachment state, and conversation snapshot. Attachment absence
or failure becomes an explicit unavailable or failed result. Opening one child
does not subscribe to or hydrate its siblings.

The panel records a pending selected route while hydration runs, fences the
result to the latest requested child, and rolls back to overview when that
request fails. A ready detail uses the normal background-agent transcript
surface. It is interactive when the child is not archived and the normal
conversation-writer boundary permits interaction. Done describes the previous
Turn, not the Thread's writer authority: a completed child may receive a
follow-up and become Active again. Archived, deleted, unavailable, or
unattached children remain read-only. Returning to overview does not discard
child transcript authority or turn the parent into its owner.

## Root interruption and archive

Stopping a root Turn first interrupts that root through the ordinary command
lane, then reads the expanded known descendant projection. The Directory allows
the runtime's own cascade a bounded interval to settle. Remaining Active,
Waiting, or Unknown descendants are inspected through a one-Turn summary read;
only a still-`inProgress` child receives an explicit interrupt. A typed
not-found, dead-agent, or already-terminal response is idempotent terminal
evidence. After an accepted interrupt, Main polls the one-Turn summary within
the same five-second subtree deadline; accepting the request alone is not a
postcondition. These fallback reads and interrupts are bounded, run with
physical concurrency two, and share root-scoped scheduling. The command does
not report successful convergence while discovery is incomplete or a child in
that fallback set fails or remains unresolved.

Automatic Goal continuation is also root-tree aware. An idle root can continue
an active Goal only after discovery is complete and the unresolved Active
count is zero. Explicit queued user work keeps its independent target contract.

Before archive, Main requires a complete descendant closure and Core records a
deterministic lifecycle operation containing the expected root and descendants.
The app-server archive remains the physical operation. Its response is followed
by bounded postcondition reconciliation because root success does not by itself
prove every child settled. A transport error after the physical request also
enters reconciliation because it may follow a partial remote mutation.
Lifecycle observations are applied in bounded
batches, are restart-safe, and distinguish settled, unresolved, and failed
members. A partial lifecycle is never reinterpreted as an empty tree. If the
physical archive succeeds before descendant postconditions converge, the root
remains in the ordinary Chat surface and the archive action fails visibly so a
retry can resume the same durable lifecycle operation; it is not hidden as a
successful archive.

Delete uses the same durable closure, partial-transport semantics, bounded
reconciliation, and typed outcome model. Settings -> Data controls lists only
archived root Chats. Permanent deletion begins or resumes the durable subtree
operation; an incomplete result restores the row and remains retryable instead
of hiding an unresolved subtree.

## Performance and failure behavior

Normal overview and notification handling may read child metadata, graph, and
status only. It does not call child resume, item-page, or transcript-bearing
Thread reads, and it does not register child conversation subscriptions. The
generation-recovery exception reads one item-free latest-Turn skeleton for a
bounded set of Unknown descendants. Consequently a child's history length does
not change overview payload shape or retained conversation memory.

The bundled Agent runtime selects the multi-agent protocol from the active model's
catalog metadata. Nodex does not globally force V2 because doing so can expose a
reserved tool schema that a V1 model cannot accept. Models that select V2 use
the runtime's current Thread cap, wait intervals, and `collaboration` tool
namespace. The unmodified app-server remains the mailbox and completion-delivery
authority. Nodex does not claim crash-durable or exactly-once parent mailbox
delivery beyond that upstream contract; its own responsibility is to recover a
truthful descendant/status projection after endpoint replacement.

Discovery pages, result bytes, pass time, cursors, expanded windows, lifecycle
batches, and selected-tail history all have independent bounds. Hitting a bound
returns or preserves an incomplete result and continuation; it never forces an
Unknown child to Done. Endpoint generation replacement fences old reads and
evidence. A selected-detail failure remains retryable without invalidating a
truthful overview.

## Validation expectations

Regression coverage must include:

- spawn-before-metadata and status-before-row ordering;
- metadata losing to newer notification or completion evidence;
- `notLoaded` and interrupted children remaining unresolved;
- app-server replacement without replayed child notifications, including
  terminal skeleton convergence and an indeterminate child displayed as
  `Status unavailable` without a work clock;
- page retry identity, cursor progress, complete-marker reachability, and
  old-generation rejection;
- restart-safe keyset windows and at least a 1,000-descendant projection;
- initial four/ten windows, exact-total withholding, Done-zero omission,
  waiting plus elapsed time, and explicit expansion/release;
- overview and panel-closed notifications performing no child transcript read
  or conversation subscription;
- one selected child reusing or attaching one sparse history while siblings
  remain metadata-only;
- selected detail becoming ready only after renderer role/checkpoint/snapshot
  attachment, with explicit unavailable and failed outcomes;
- stale selected-route completion, unavailable selected history, and
  interactive/read-only detail ownership;
- root interruption with hydrated and unhydrated descendants, plus explicit
  terminal absence, post-interrupt polling, failed, and unresolved results;
- archive lifecycle closure, bounded reconciliation, idempotent restart, and
  partial descendant outcomes after either success or transport failure;
- expanded overview mutation between pages restarting at one projection
  revision rather than mixing Active and Done rows;
- ordinary child completion reaching the parent and converging the overview
  while the app-server process remains live.
