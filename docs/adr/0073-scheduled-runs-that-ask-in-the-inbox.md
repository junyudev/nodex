# ADR 0073: Scheduled runs that ask in the Inbox

- Status: Accepted
- Date: 2026-10-27
- Owners: Nodex maintainers
- Refines: Inbox dispatch in [ADR 0067](0067-inbox-entries-and-dispatch-proposals.md)

## Context

A scheduled task always ran when it fell due. Some recurring work, such as bumping dependency
versions, is worth a glance before it starts: the user wants to confirm it, change this run's
instructions or model, or skip it. Other work, such as a security check, should run on its own and
speak up only when it finds something.

Nodex already had one place where work waits for the user: the Inbox, whose proposals never run
until the user confirms them. A Page's recurrence is a third schedule, but it describes when a
person works on something, not when an Agent does.

## Decision

A scheduled task is the only thing that starts Agent work on a schedule, and the Inbox is the
only place where anything waits for the user. Each task chooses its launch: `Automatic` runs when
due; `Ask` places the firing in the Inbox. A Page's recurrence and reminders never start Agent
work.

An `Ask` firing becomes an ordinary Inbox message in the task's Inbox. A Project task's
firing goes to that Project's Inbox, a projectless task's to the Library Inbox, and a
Heartbeat's to its chat's Inbox. The message body is the task's instructions, and the
message carries a `Run task` proposal the schedule writes from the user's own definition.
Scheduled messages do not take suggestions; their decision comes from the task.

Core owns firings beside their task. While a firing is held or failed and waiting in the
Inbox, later firings of the same task fold into it rather than adding messages, and the
task's next run advances. The Desktop Host answers a hold lease with one Workspace command
that creates the message and proposal and settles the lease in the same commit.

Confirming a held firing freezes the message text the user reviewed as that run's
instructions, plus any Agent or model chosen for this run, and admits the firing in the same
commit. An admitted firing is claimed through the task's ordinary due lease and executed by
the same Host path as an automatic run. The Inbox keeps no outbox for it, and Inbox History
follows the run's chat. Any other decision on a waiting firing consumes it: skipping it,
filing or redirecting the message, or deleting it. Run now on a task with a held firing
confirms that firing. A firing that fails before reaching a chat returns to the Inbox with
its reason and Retry.

Only the user grants unattended execution. An Agent may create tasks that ask, and may move a task
to `Ask`. Creating an `Automatic` task, or changing a task from `Ask` to `Automatic`, needs a
suggested change that the user applies. Core enforces this for Agent commands. A run that needs the
user afterwards says so with `send_to_inbox`, attributed to its task.

## Consequences

- One review surface covers both moments that need the user: before a run and after it.
  Scheduled remains the place where tasks are configured and runs are logged.
- A Project task's firing is a Page on that Project's Board, so a recurring task leaves one Board
  entry per decided run.
- The held message keeps the instructions the user reviewed. Until the user edits it, a follow-up
  command, fenced by the message's revision, rewrites it to match edits to the task.
- An Agent cannot escalate a task to unattended execution, even when it can otherwise manage the
  task directly.
