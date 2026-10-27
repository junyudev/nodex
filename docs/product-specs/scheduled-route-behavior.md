# Scheduled Route Behavior

## Intent and authority

Scheduled is the Workbench destination for creating, finding, editing, running,
and reviewing scheduled tasks. Rust Core owns versioned definitions,
schedules, due leases, run/inbox/read/archive state, occurrences, and reminders.
The Desktop Host owns external agent execution and operating-system
notifications. The renderer owns route presentation and drafts only.

The active definition collection is bounded to 200 entries at creation. Deleted
history remains available through its bounded Core window. Renderer mutations
use the same Core revision fence and committed update event as agent-driven
`automation_update` mutations.

Scheduled tasks execute with an explicit Codex, configured Claude Code, or ACP
Agent Instance binding. Creation, editing and execution retain the exact instance;
ACP also retains its logical Agent identity. A missing, disabled, or mismatched
instance cannot admit a new scheduled execution, even while an older catalog is
cached. Existing definitions remain readable when their instance is unavailable.
An unavailable Profile or runtime never selects another backend. Remote-host
execution remains unavailable.

Every Agent can read and manage Cron tasks and Heartbeats across Projects and
Sessions in the current Profile, including in Plan mode. Core retains exact
captured execution identity and validates target existence and lifecycle. Page
occurrence completion, skipping and schedule changes also accept projectless
actors, preserving the absent actor Project in their content transactions.
Updating a task checks its current and proposed target; moving a Heartbeat
Session changes execution routing without changing access. Mutation retries
revalidate the live execution identity before replaying their receipt. Agent
commands cannot claim due work or change run and lease state; those transitions
remain Host-owned.

Agent list/search windows filter task identity, name and prompt in the current
Profile before applying the result limit. An explicit Project filter narrows the
list only. Continuation cursors are bound to that filter and query. Definition commands keep a stable operation identity;
the same caller Thread can reconcile unchanged arguments in a later Turn or after
restart. Updates and deletes retain the observed definition revision. Explicit
updates replace the complete definition, so omitted optional fields reset to their
defaults. Every retry revalidates its captured execution identity before returning its
original committed result.

## Entry points and route state

The rail's `Scheduled` entry, command palette `Manage automations`, and Thread
Summary Scheduled rows open `/automations`. Scheduled is a sidebar destination:
its own sidebar replaces Home's, and Home resumes its own last location when the
user leaves. Scheduled lists only tasks owned by the current Profile.

Route state is canonical URL state:

- `automationId` selects a task;
- `automationMode=create` opens the create dialog, seeded by `templateId` when
  present; `automationMode=edit` opens the edit dialog for the selected task;
- `runSessionId` presents a run's or Heartbeat's chat in place.

A selected task that no longer exists returns to the landing page. A selected
Heartbeat opens its target chat. Presenting a chat keeps the Scheduled sidebar and
rail selection while the chat is the route's active Session, with its ordinary
header and panels.

## Sidebar

The header holds the `Scheduled` title, a Search toggle, and `New task`. Search
opens an inline field that filters tasks by name; Escape clears it, closes it,
and returns focus to the toggle.

`Upcoming` lists active tasks by next run, then paused tasks, then by name. Its
`Filter tasks` menu shows or hides Active and Paused tasks. Each row shows the
task name over its next run date and schedule (`Oct 19 · Mondays at 9:00 AM`), or
`Paused · {schedule}`. A spinner marks a running task and a dot marks unread runs.
Hovering or focusing a row reveals `More task actions`: Pause or Resume, Run now,
Edit, and Delete, which asks for confirmation. Pause and Resume update the list
optimistically and roll back with an error toast when the save fails.

A cron task with runs is a folder. Selecting it opens its conversation and its
newest unarchived runs; selecting it again folds the runs. A run row is titled by
its summary, `Running now`, or `Run completed`; opening it marks it read and
presents its chat in place. Runs can be archived from their row. Heartbeats never
fold; selecting one opens its chat.

The sidebar states loading, `No scheduled tasks`, `No matching tasks`, and a load
error with `Try again`.

## Main pane

Without a selection, the landing page offers suggested tasks from the system
template catalog. Choosing one opens the create dialog seeded with its name,
instructions, and schedule; `Show more` reveals the whole catalog.

A selected cron task reads as the conversation that set it up: its instructions
as the user's message, then `Your task is scheduled. Its next run is …` (or a
pointer to task details when no next run is known), then a card with the task's
name and schedule that opens the edit dialog. `Reply about this task…` starts a
chat about the task in its Project and presents it in place; the message names
the task so the Agent can read or update it.

## Create and edit dialog

The dialog edits one draft:

- name (edit only; a new task is named after the first line of its instructions);
- instructions;
- `Repeat` (Interval, Daily, Weekdays, Weekly, Custom) with `Every`, `On`, `Time`
  in the local time zone, or a custom rule;
- `Advanced`: Notifications, `Start each run in new chat`, the Heartbeat's chat,
  Project, Workspace, Environment, the Agent, and for cron tasks its model and effort.

`Start each run in new chat` chooses a cron task (on) or a Heartbeat that
continues one chat (off) and is fixed once the task exists. Cron tasks require
instructions, schedule, and model. They target either one Project with one or more
of its folders, or `No project`. Project identity remains explicit even when
Projects share a folder. Switching Project clears the previous folder selection
and Environment. `No project` uses local execution and creates an independent
projectless workspace for each run. Project runs create Sessions in the selected
Project; execution revalidates its active state and selected folders before
starting. Heartbeat tasks require instructions, a local Chat, and schedule.

A Heartbeat targets the Chat’s stable Session. Execution resolves that Session’s
current execution reference; a Session without an available execution remains
unavailable for a Heartbeat. Native Thread identity never retargets the definition.
Only one active Heartbeat may target a given Session.
Archiving its Session pauses active Heartbeats and cancels their claimed leases in
the same Core commit. Restoring the Session leaves those tasks paused until explicitly
resumed. Deleting the Session retires its Heartbeats and fences outstanding leases.

The Environment field appears only for a Codex cron worktree task with exactly one
selected Project source. It offers `No environment`, identifies the preferred
`environment.toml` definition, and can open Settings → Environments with the
selected Project/config context.

The Agent row offers Codex, enabled Claude Profiles and enabled ACP instances; cron tasks
choose that Agent's model in a separate Model row with the shared model menu.
Codex uses its runtime model catalog and exact model, reasoning and service-tier
tuple. Claude uses discovery
from the selected Profile and Project, or the trusted host directory for a projectless
task. It lists concrete native models, with each model ID in its tooltip and search, and
only advertised effort levels. Inherited preferences
display their resolved native values. Changing Profile clears settings that do not apply to the new
backend, while a Codex catalog refresh cannot rewrite Claude choices. Claude launches
use the Profile environment, without Codex service tiers or local Environment files.
Heartbeat definitions retain the exact Profile of their target Session; a mismatched
current attachment is unavailable for execution.

Claude cron execution creates and durably links its local, managed worktree or fresh
projectless workspace before submission. The existing Core due lease and run inbox
own the entire run. Heartbeats observe the Session’s execution metadata without opening
transcript history or resuming a second native client. They recheck the target, cadence,
busy state and background tasks before launch.
ACP Cron runs use the same Core due lease, Run inbox, product Session, workspace
preparation and Runtime execution path. Heartbeats retain their target Session and
reject an attachment to a different ACP instance. ACP model selection uses the
advertised model and options of that instance; Agent tools preserve the same binding
when creating or replacing a definition. Page-linked Sessions keep their existing
links while their Heartbeat continues the selected instance.

Each Cron run receives its task name, stable Automation ID, previous run time,
and saved instructions in a new Session. Nodex does not provision an implicit
cross-run memory file or require an Agent-specific home environment variable.
Persistent notes must be explicitly requested in the task's instructions at a
location accessible to its selected Agent. Heartbeats continue the existing
Session and its available conversation context.

Scheduled turns do not wait for interactive approvals or questions. They are
bounded within the due lease; failure, timeout and interruption cancel only their exact
accepted Turn, settle the run and retain its review record.

Create stays disabled, with a tooltip naming what is missing, until the draft is
valid; success selects the new task. When a create, save or Run now is refused, its
notification shows only the reason and what to change, such as a turned-off or
removed Agent, a model or option the Agent doesn't offer, or a Heartbeat chat that
is gone. Editing saves only through `Save`, and its footer pauses or resumes the
task immediately. Closing a changed draft asks `Discard changes?` with
`Keep editing` and `Discard changes`; an untouched draft closes directly.

## Notification preferences

A scheduled task can store `notificationPolicy: "failed_runs_only"` to suppress
successful and interrupted completion notifications while allowing failed-run
notifications. `null` restores the normal notification policy. Editing another
field preserves an omitted notification preference; clearing it is explicit.
The preference never overrides the Profile's global notification settings.

Heartbeat launches bind the preference to their exact Turn, including Run now.
Other messages in the same Chat use normal notification behavior. Cron runs use
their definition's preference until accepted into an ordinary conversation;
manual follow-ups after acceptance use normal notification behavior. Notification
preferences are stored separately from prompts and model-authored output.

## Runs

Runs belong to their cron task, newest first; archived runs leave the sidebar.
A scheduled Run retains one identity before workspace creation and native launch.
After admission it binds the actual Session once; its review, read and archive
state continues to use that Run identity. A failed preparation remains reviewable
without inventing a Chat or native Thread. A run opens only after it has a Session.

Expired leases and failed retries retain their logical dispatch identity. Reclaiming
the same firing reuses its Session, launch and message identities; a new manual
dispatch or changed definition begins a separate firing. Restart may resume an
interrupted preparation that has no Session. A bound or explicitly archived Run
never starts a hidden second execution.

Run actions use the scheduled-run boundary and invalidate the canonical run inbox
rather than patching an independent renderer history.

## Deletion and Agent proposals

Deleting requires the in-app `Delete scheduled task?` confirmation. Success
removes the definition through Core, updates the query cache from the committed
result, removes its owned run rows atomically, and returns a selected task to the
landing page.

The `automation_update` tool may list/search definitions, read one, create,
update, or delete directly, or return a suggested change for user review.
Suggested cards open the same editor in the Chat's side panel and remain unsaved
until the user explicitly selects Create or Apply changes. Native MCP proposals retain the resolved Session
target, notification-policy presence, and observed definition revision through review,
including from projectless Sessions. A definition changed since the proposal was made
cannot be overwritten by saving that proposal. Direct heartbeat targets must resolve
to a known local Chat.
