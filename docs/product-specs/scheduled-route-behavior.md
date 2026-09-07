# Scheduled Route Behavior

## Intent and authority

Scheduled is the Workbench route for creating, finding, editing, running, and
reviewing scheduled tasks and templates. Rust Core owns versioned definitions,
schedules, due leases, run/inbox/read/archive state, occurrences, and reminders.
The Desktop Host owns external agent execution and operating-system
notifications. The renderer owns route presentation and drafts only.

The active definition collection is bounded to 200 entries at creation. Deleted
history remains available through its bounded Core window. Renderer mutations
use the same Core revision fence and committed update event as agent-driven
`automation_update` mutations.

Scheduled tasks currently execute only with the Codex Agent Backend. Creation,
editing, loading, and execution reject every other backend binding; Nodex never
routes an unsupported scheduled task through Codex as an implicit fallback.

Core Agent definition access carries exact persisted Turn provenance. A
Project-scoped Turn can read and manage Cron tasks in that Project and Heartbeats
whose target Session currently belongs to it. Library-scoped Turns may also
manage other Projects and projectless targets. Updating a task checks both its
current target and its proposed target; moving a Heartbeat Session changes access
immediately. Read-only Turns can read authorized definitions but cannot mutate
them. Core revalidates authority and target access before replaying a mutation
receipt. Agent commands cannot claim due work or change run and lease state;
those transitions remain Host-owned.

Agent list/search windows filter task identity, name and prompt within the current
authorized target scope before applying the result limit. Continuation cursors are
bound to that scope and query. Definition commands keep a stable operation identity;
the same caller Thread can reconcile unchanged arguments in a later Turn or after
restart. Updates and deletes retain the observed definition revision. Explicit
updates replace the complete definition, so omitted optional fields reset to their
defaults. Every retry revalidates the current Turn before returning its original
committed result.

## Entry points and route state

Sidebar `Scheduled`, command palette `Manage automations`, and Thread Summary
Scheduled rows all open `/automations` while keeping the ordinary
Project/Session sidebar mounted.

Route state is canonical URL state:

- `tab` selects Tasks or Templates;
- `automationId` selects a saved definition;
- `automationMode=create` opens a new draft.

List, detail, create, missing-selection, and closed-detail states derive from
these parameters. Closing detail removes its selection/mode parameter. The
route replaces the thread stage and its header/actions with one Scheduled main
pane and a peer detail rail.

## Tasks list

Definitions sort by `nextRunAt`, with tasks lacking a next run last, then by
name. Search covers name, prompt, workspace, schedule label, kind, target Chat,
RRULE, and working directories. Results group into `Current` and `Paused`.

A task row shows its workspace fallback, schedule, `In progress` or next-run
status, and unread-run state. Row actions expose Pause/Resume on the status
control plus `Run now`, `Edit scheduled task`, and `Delete` on hover or keyboard
focus.

Automation-run lifecycle events refresh the task list, run inboxes, and the
sidebar/recent-Chat projection. Definition-change events are not a substitute
for run lifecycle refresh.

## Templates

Templates is a searchable system catalog. Search matches template name, prompt,
and schedule label. Selecting a template opens create mode seeded with its name,
prompt, and RRULE; Project and intelligence selection remain explicit user
choices.

The header uses one split create control. Its primary action is `Create via
chat` when the conversation-backed creation capability is available and
`Create manually` otherwise. `New scheduled task options` exposes both paths;
only the unavailable path is disabled.

## Detail editor

The detail rail edits one coherent draft with these fields:

- title and prompt;
- `Runs in` target kind;
- Chat or Project target;
- optional local Environment;
- repeat/interval schedule;
- Codex model, reasoning effort, and service tier;
- Previous runs for cron tasks.

Cron tasks require title, prompt, schedule, and model. They target either one
Project with one or more of its folders, or `No project`. Project identity remains
explicit even when Projects share a folder. Switching Project clears the previous
folder selection and Environment. `No project` uses local execution and creates
an independent projectless workspace for each run. Project runs create Sessions
in the selected Project; execution revalidates its active state and selected
folders before starting. Heartbeat tasks require title, prompt, local Chat, and
schedule.

A Heartbeat targets the Chat’s stable Session. Its displayed Thread and execution
target follow that Session’s current backend attachment. Detaching a Thread does
not retarget or delete the definition; a run without an active, attached Session
waits for an available target. Reattaching a Thread does not require recreating
the Heartbeat. Only one active Heartbeat may target a given Session.

The Environment field appears only for a cron worktree task with exactly one
selected Project source. It offers `No environment`, identifies the preferred
`environment.toml` definition, and can open Settings → Environments with the
selected Project/config context.

Scheduled tasks currently execute only on the native Codex backend. The model
control uses the runtime-owned Codex model catalog and preserves its exact model,
reasoning, and service-tier tuple. ACP-backed scheduled tasks are rejected at
creation and execution boundaries until the automation runtime has a real ACP
execution path; they are never redirected to Codex.

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

## Previous runs

Previous runs are available only for a selected cron definition, filtered by
that definition, and sorted newest first.
Each row derives unread, running, and archived state plus availability of
Archive, Unarchive, Delete, and Open.

Open selects the run's Chat only after that Chat is available. Run actions use
the scheduled-run boundary and invalidate the canonical run inbox rather than
patching an independent renderer history.

## Save, navigation, and deletion

Creating is an explicit `Create scheduled task` submission. Success replaces
create mode with the saved `automationId`.

Existing definitions autosave after a short debounce. Before changing route,
tab, selected row, or closing detail, the route flushes a valid dirty edit
through the same update payload. A failed save cancels navigation.

A changed create draft guards route/tab/row/detail-close navigation with
`Keep editing` and `Discard`. An untouched default draft closes directly.

Deleting from a row or detail rail requires the in-app `Delete scheduled task`
confirmation. Success removes the definition through Core, updates the query
cache from the committed result, removes its owned run rows atomically, and
returns a selected detail route to the list.

The `automation_update` tool may list/search definitions, read one, create,
update, or delete directly, or return a suggested change for user review.
Suggested cards open the existing review editor and remain unsaved until the user
explicitly selects Create or Save. Native MCP proposals retain the resolved Session
target, notification-policy presence, and observed definition revision through review,
including from projectless Sessions. A definition changed since the proposal was made
cannot be overwritten by saving that proposal. Direct heartbeat targets must resolve
to a known local Chat.
