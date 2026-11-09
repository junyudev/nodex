# ADR 0079: Status moves on facts; a person's move wins

- Status: Accepted
- Date: 2026-11-05
- Owners: Nodex maintainers

## Context

A Page needs one stage for where its work stands. Keeping Status unchanged after a chat reports
ready or unnecessary leaves the Board behind the work. Automatic moves must also preserve a
person's later decision, even when they move away and back to the same stage.

## Decision

Status keeps `triage`, `plan`, `doing`, `review` and `done`, and adds `canceled`. Default names
are Triage, Todo, In Progress, In Review, Done and Canceled. Source-owned names and colors remain
customizable. Existing exact default names are upgraded without changing stage identities.

The Database transition collaborator runs inside the transaction recording each work fact:

| Fact                     | Expected predecessors     | Destination |
| ------------------------ | ------------------------- | ----------- |
| Start or handoff         | Triage, Todo              | In Progress |
| Ready report             | In Progress               | In Review   |
| Dropped report           | Triage, Todo, In Progress | Canceled    |
| Person accepts           | In Review                 | Done        |
| Blocked or failed report | None                      | Unchanged   |

Core maintains a Page-local, monotonic revision for person Status edits. Explicit Desktop,
CLI and person commands advance it independently of automatic Property revisions. A Page launch and its work link retain the person revision at the attempt's creation.
A related-only link captures no attempt; its first handoff records the current fence. A fact moves Status only when
the current predecessor and captured person revision match. Moving A → B → A still advances
the fence. The same transaction retains skipped facts and whether the move applied. Acceptance
is an explicit person command and advances that fence; verified Agents cannot accept work.

Each Page has at most one active chat, selected by Start, Start again, explicit handoff, or Inbox
new-chat/send-to-chat dispatch. Ordinary related links do not select it. Archiving or unlinking
the selected chat clears the binding, without falling back to an older chat. Replies target the
active chat. Older attempts may report evidence but cannot move a newer attempt's Page.

Done and Canceled are terminal for presentation, completion filtering and sorting. `completed_at`
marks entering either terminal stage, survives moves between terminal stages, and clears on
reopening. It means terminal time, not acceptance. Only Done means accepted work. A prerequisite
must be active in its retained Data Source and Done; ready or dropped reports never satisfy it.
Ready-to-start requires Triage/Todo, an Agent Assignee, no active chat and all prerequisites satisfied.
Automatic starts additionally require person-granted consent. Readiness epochs retain the
Page work revision and assignment/consent, Status and person-edit revisions, and Done
prerequisite evidence; reports alone never change readiness.

## Consequences

- The Board advances with recorded work while a person's later choice remains authoritative.
- One explicit active destination replaces choosing a linked chat by recency.
- Done is the acceptance seam; cancellation retires work without releasing its dependents.
- Historical reports remain evidence even when their proposed Status move was skipped.
