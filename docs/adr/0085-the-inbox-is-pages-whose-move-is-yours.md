# ADR 0085: The Inbox is Pages whose move is yours

## Status

Accepted. Refines [ADR 0079](0079-status-moves-on-facts-a-persons-move-wins.md) and
[ADR 0080](0080-the-inbox-is-what-is-yours.md). Supersedes the intake triage state
and membership rules in [ADR 0067](0067-inbox-entries-and-dispatch-proposals.md).

## Context

A captured message is an ordinary Page. Its Owner needs to see it while deciding
what to do with it. Moving that Page out of Triage on a Board is as much a
decision as choosing Add to Todo in the Inbox.

## Decision

Core derives a `triage` Turn for active intake Pages in Triage that have no active
chat or delivery in progress. Its actor is the Page Owner. When there is no active
Owner, the decision waits for any active Member. Capture assigns the author or
requester as Owner where known. Relocation preserves the decision and changes
the Inbox scope to the Page's current Project. The capture Inbox remains provenance.

A Page appears once in the Member's Inbox. Triage and delivery recovery show the
message, with advice or delivery recovery actions. Other eligible Member Turns
show the work Page. Quiet answers and Problems retain their own eligibility.
Status edits from every surface control routing. Add to Todo moves held work
to Todo. Save to Notes relocates the Page beneath the Notes Page bound to its
Inbox. The Page leaves its Data Source and keeps its Document and provenance. Mark done and Skip this run move to Done. Filing moves
to Todo at the destination. Return to Inbox moves to Triage when no active chat
is bound. Returning a saved note restores its original Data Source membership
and sets Triage. Start, handoff and acceptance use the existing work commands and fences.

Activity records routing decisions in the same commit, including when a Status
edit outside the Inbox handles or returns the Page. Leaving Triage supersedes
open proposals and withdraws pending advice. Undo restores the prior Status and
any proposal it can still restore atomically.

Later binds a future time to one Member's current Page Turn episode. Both intake
and work rows can be deferred. Answers, Problems and Ask-first run decisions
keep their own actions. Another episode or loss of membership discards the
deferral. Core publishes a return only while that episode still belongs to the
Member, with at most one claim per notification channel.

Each Project and the Library Inbox lazily bind a top-level Notes Page. The
person may name it and organize sections under it. It stays active while
bound. The Coordinator may suggest an active destination from a bounded
breadth-first outline of titles and may leave it to the Notes root.

## Consequences

The Board, Inbox, CLI and phone share one Status and one Turn. Project moves
relocate pending attention without handling it. A new request or reassignment
can reach its Member immediately, including when an earlier episode was deferred.
