# ADR 0090: Nodex decides in single-purpose runs

- Status: Accepted
- Date: 2026-11-25
- Owners: Nodex maintainers
- Supersedes: ADR 0078's persistent Coordinator chat, Work events and Turn notes

## Context

[ADR 0078](0078-nodex-coordinates-managed-work.md) gave the Profile one long-lived Coordinator
chat, shown as Nodex. It answered every Inbox suggestion request and woke for every Work event
about a managed chat. Since then, Core has started deriving each Page's Turn from facts
([ADR 0079](0079-status-moves-on-facts-a-persons-move-wins.md),
[ADR 0085](0085-the-inbox-is-pages-whose-move-is-yours.md)). The Inbox already shows the
question, report, failure or prerequisite that needs the person, so the watching half of the
Coordinator has stopped adding information.

In practice the chat cost attention and tokens without returning value. Most Work events ended
with no action, because the derived Turn already said everything. Each turn carried the whole
long conversation, so a single routing decision paid for weeks of unrelated history. People
could not tell what the chat was for. They could not find it again, because it was hidden from
every chat list, and its transcript showed messages Nodex sent to itself with no visible outcome.
Meanwhile one real gap stayed open. An Agent chat that ended its turn waiting on the person in
prose, without a report or a question, showed no Turn and notified nobody.

## Decision

Nodex is something the app does, not a chat the person keeps.

- **Decisions run on their own.** Each judgment that needs a model runs as a **decision run**:
  a short Agent run started for one request, with that request's context, the tools to answer
  it and nothing else. These are routing an Inbox suggestion request and assessing an event
  Automation. Core binds each run to its request, and only that run may settle it. A decision
  run never appears among chats. The decision it produced links to it, so the person can see
  how Nodex decided. No conversation carries over between decisions. Everything a decision
  needs comes from Core in its request.
- **Core watches work.** Work reports, questions, approvals, failures, stalls and finished
  Prerequisites are already Turn facts. A new Turn reason, **Reply**, covers an Agent chat that
  finished its turn with nothing reported and nothing pending: the person's reply is next.
  Nothing wakes a model to restate a Turn. Work events, their delivery batches and Turn notes
  are removed.
- **Turns notify by rule.** A Member's question, approval, review, blocked, failed and reply
  episodes notify according to their preferences. Stalled and ready-to-start Turns wait quietly
  in the Inbox.
- **Work chats speak for their work.** The root Agent of a Page's active chat acknowledges a
  GitHub request and announces its result through the reply-to-origin tool.

Managed chats remain: a chat that an Inbox dispatch or a Page start hands work to receives work
instructions, and its notifications come from its Page's Turn.

## Consequences

- There is no Open Nodex, no Start Nodex fresh and no hidden Profile conversation. "Nodex runs
  on" chooses the Agent for decision runs.
- Each decision pays only for its own request. Routing requests run in parallel up to the
  configured limit, instead of queueing behind one conversation.
- Nodex no longer recalls earlier routing from memory. A message that continues earlier work
  still goes there through the eligible chats and explicit references that Core supplies.
- The Inbox, the Board and Activity say what happened, and each Nodex decision can be traced to
  the run that made it.
- Failures that reach a Turn need the person. The Agent Runtime already retries passing provider
  errors before a run fails.
