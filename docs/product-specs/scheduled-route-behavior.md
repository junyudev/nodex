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

Cron tasks require title, prompt, Project, schedule, and model. Heartbeat tasks
require title, prompt, local Chat, and schedule.

The Environment field appears only for a cron worktree task with exactly one
selected Project source. It offers `No environment`, identifies the preferred
`environment.toml` definition, and can open Settings → Environments with the
selected Project/config context.

Scheduled tasks currently execute only on the native Codex backend. The model
control uses the runtime-owned Codex model catalog and preserves its exact model,
reasoning, and service-tier tuple. ACP-backed scheduled tasks are rejected at
creation and execution boundaries until the automation runtime has a real ACP
execution path; they are never redirected to Codex.

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
Suggested cards are presentation-only until accepted. Direct heartbeat targets
must resolve to a known local Chat.
