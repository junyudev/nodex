# ADR 0078: Nodex coordinates managed work

- Status: Accepted; Status transitions and prerequisite satisfaction superseded by [ADR 0079](0079-status-moves-on-facts-a-persons-move-wins.md)
- Date: 2026-11-03
- Owners: Nodex maintainers
- Refines: Inbox dispatch in [ADR 0067](0067-inbox-entries-and-dispatch-proposals.md), held runs in
  [ADR 0073](0073-scheduled-runs-that-ask-in-the-inbox.md)

## Context

With one chat, the model is the limit. With many, the person is: each chat finishes, asks, fails
or stalls on its own and raises its own notification, and the person has to open each one to
learn whether it needs them. The Inbox's suggestion Agent proposed where a new message should go,
but it forgot everything between requests and never followed the work it dispatched. Boards held
the work, but nothing connected a card to the chat doing it, said that one card must wait for
another, or told the person when a result was ready.

## Decision

The Profile has one persistent coordinating Agent, the **Coordinator**, shown as **Nodex**. It is
an ordinary Runtime chat with its own history, created on first need and never listed among
chats; the Inbox is its face. Its conversation is a working memory, not an authority: everything it
decides is recorded in Core, so it can be compacted, restarted or started fresh without losing
work.

Nodex routes, watches and speaks:

- **Routes.** Every Inbox suggestion request is delivered to Nodex, which answers through
  `inbox_suggest`. The Host validates and settles the answer through the same fenced request
  machinery as before, so advice still never runs by itself. A person may opt in to Nodex
  starting their own clear requests directly; that standing consent is the person's, applied by
  the Host only to the person's own unchanged messages.
- **Watches.** Chats Nodex dispatches, or that the person hands to it, are **managed**. Core keeps
  a durable, deduplicated record of the events Nodex must hear about — a work report, a question
  or approval, a turn that ended without a report, a failure, a stall, a card that became ready —
  and the Host delivers them to Nodex in batches as Host-authored input, reconciling Runtime
  admission so a batch is never delivered twice. Events come from observing each managed chat's
  current state and comparing it with the last observation, not from the live notification
  stream, so a restart neither loses nor repeats them.
- **Speaks.** Nodex posts typed Inbox entries — result, attention, problem, answer — about a
  specific chat or Page, only when the person must act or can use a result. Those posts, not the
  managed chats themselves, raise desktop notifications for finished work. A reply to a post is
  an ordinary Inbox message that Nodex routes back. Core binds each post to the Work events it
  answers, so resolved attention retires with its fact.

Work becomes explicit on the Board. A managed chat reports the outcome of its Page's work with
`report_work` — ready, blocked, failed or not needed. A Page names the Agent that should do it and
whether it may Start automatically; it can **Wait for** other Pages. Starting a Page hands it to
a new managed chat. When a Page's prerequisites are satisfied — each is done, or its latest
report is ready or not needed — a Page set to Start automatically starts, and any other asks the
person through Nodex. Nodex may propose a plan of several such Pages; the person's confirmation
creates them and grants their unattended starts.

Status stays the person's: Agent work never moves it, except that starting work hands the Page to
a chat as before. Whose turn it is — working, needs you, ready for review, blocked, waiting on
prerequisites — is derived from linked chats and their reports.

Behavior is instruction; identity and consent are enforced. Nodex's discipline — never doing the
work itself, never rewriting a request it acts on, attaching follow-ups only on an explicit
reference, one concrete question at a time, at most a hundred words — lives in standing
instructions the Host attaches to every Nodex turn. Core enforces only what instructions cannot:
only the Coordinator authors Nodex entries and settles suggestions through its tool, only the
person grants unattended starts, and only the person's own unchanged messages start on their
standing consent.

## Consequences

- One place answers "does anything need me?": the Inbox, written by Nodex. The Board answers
  "where does each piece of work stand?", and a chat answers "what happened here?".
- Inbox advice gains memory of what is already running, at the cost of a long-lived conversation
  that Core treats as disposable.
- Managed chats stop notifying on every finished turn; questions and approvals still notify, since
  they block work.
- Agents can coordinate through Nodex without a second task system: Pages remain the work, chats
  remain the execution, and the Inbox remains the only place where anything waits for the person.
- A Page's prerequisite chain can run unattended once the person grants it, and stops for the
  person wherever they kept the launch on ask.
