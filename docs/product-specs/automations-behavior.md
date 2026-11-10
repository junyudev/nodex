# Automations Behavior

## Intent and authority

Automations is the Workbench destination for standing Agent work. Core owns Automation
configuration, clock Triggers, decisions, execution leases and history. Main
executes admitted work and publishes desktop notifications. The renderer owns
drafts and presentation.

An Automation belongs to a Project or the Space and has a Member Owner, a
natural-language condition and action, an optional typed condition, mode,
execution target, enabled or paused state, lifecycle and revision. Clock Automations
store an RRULE, explicit IANA timezone and jitter salt. A heartbeat is a clock
Automation that continues a stable Session; other clock Automations start new chats per
configured folder. Source conditions select GitHub events for bounded judgement in the Coordinator conversation.

- Dry run records a decision and reason without creating a Page, proposal, chat
  or execution lease.
- Ask first holds an editable decision in the Inbox until its Owner, or an Agent acting
  for them when asked, starts, retries or skips it.
- Run starts the action under the Automation Owner's standing grant.

Only the exact Automation Owner may choose Run, change its mode, edit an Automation set to
Run, run it now or transfer it. Removing that Member retires their Automations and withdraws
unstarted decisions while retaining history. Other active Members may read Automations and
edit those set to Ask first or Dry run within scope. This applies to pause, resume and delete
as well as replacement. An Agent has exactly the authority of the Member it acts for, so it
may create an Automation in any mode, including Run, and change any Automation that Member
may. Its instructions keep new Automations to Ask first, choose Run only when the person asked
for unattended runs or clearly wants them, and ask when unsure. A change only another Member
may make can be proposed for that Owner in the same editor. Source text, runbooks and model
output never change Automation authority. Producers and lease transitions remain
Host-only. Checks run before receipt replay and again in the durable writer. A clock Run
action must still match the current standing grant when its message is dispatched.
Reviewed Ask first and manual admissions retain their frozen action; accepted Turns
are reconciled without a replacement launch after an Automation edit.

New Automations created in the desktop default to Run; an Agent's new Automation defaults
to Ask first when it names no mode. An omitted mode, Owner or timezone on replacement retains its saved value.
The active Automation collection is bounded to 200. Event condition and action text are
each limited to 16 KiB; the complete event configuration is limited to 48 KiB. Read and history windows are
bounded; search filters before its limit. Mutations retain a stable operation
identity and the observed revision. A changed Automation cannot be overwritten by a
stale editor or proposal.

## Event conditions and assessment

Event Automations select an optional Source, repositories, event kinds and labels, and
people only or anyone including bots and CI. Kinds are new issue, new pull request,
comment, review, failed check, passed check, label added and label removed. An
empty repository list selects all watched repositories; labels narrow relevant
label evidence. These typed filters only select Triggers. The written condition
and action remain authoritative for judgement.

Ingestion creates assessment intent only for completely unfollowed threads that
match an enabled event Automation. Followed-thread delivery never enters assessment.
Core retains one unsettled request per primary thread. Evidence received before
delivery coalesces into that batch; later Triggers wait for the next batch.
Core snapshots every applicable Automation and fences the batch by generation and a
policy hash. An Automation revision change retires that generation and requeues its
retained evidence under the current policy.

The Coordinator receives a durable Host input with a stable message identity.
Runtime admission receipts reconcile uncertain delivery. The two-minute deadline
starts with the carrying Run, excluding queue time. One unanswered completed Turn
receives one follow-up; another unanswered Turn or a failed Run settles the
assessment visibly as a failure. Restart retains the recipient and deadline.

Coordinator-only `automation_assessment_read` exposes bounded Trigger evidence, the
first thread items and a window around the batch, exact Automation snapshots, related
Pages including completed work, current follows and existing decisions. Long
items state their original character length and truncation. Reads use only
retained evidence and never fetch a URL, shell output or credentials.
`automation_assessment_submit` requires every applicable Automation exactly once, including
negative judgements, with revision, a factual reason and evidence IDs. Missing,
duplicate, unknown, stale and out-of-thread evidence is refused. Each matched
Automation supplies a Page proposal with a Project, title, body, its exact Agent target
and this thread. The model cannot select authority or mode.

Equivalent actions share an admission and retain all contributing Automations. Equivalence includes the saved workspace, environment configuration, runbook and service tier as well as the proposed Page, Project and Agent.
Incompatible actions require Ask first. Dry run records positive and negative
judgements without work. Ask first places an editable intake proposal in the Automation
Owner's Inbox; confirmation starts that Page and adds its origin follow. Run
atomically creates the Page with the Automation's Owner and Agent Assignee, follows the
thread as origin, and commits a launch through ordinary Page start. The launch retains the exact Agent, one selected repository root, environment configuration and runbook. The work Page owns its Workspace through ordinary Page start; its linked runbook is available to the work chat. Dispatch
rechecks the current standing grant and revision. External actors, including
bots and CI, supply evidence only; they never grant work or change Automations.

The editor's When selector switches between On a schedule and When something
happens on GitHub. Event Automations begin in Dry run. Recent decisions show matched
and unmatched judgements and their reasons; Inbox Activity includes them under
Decisions. This lets a person watch an Automation's judgement before choosing Run.

## Clock Triggers and decisions

Each observed due time produces one immutable clock Trigger with semantic key
`clock:<automation>:<schedule revision>:<due instant>`. A decision records Trigger
references, inputs, reason, frozen action and authority, state and proposal,
Page and dispatch links. States are held, admitted, completed, failed, skipped
and withdrawn. Execution attempts retain their own leases and run identities.

Only the outstanding overdue occurrence is materialized after missed time; the
clock then advances beyond now. It does not replay every interval missed offline.
A completed run measures the next occurrence from when it started, so an
occurrence that came due while it ran starts next.
Automation edits do not rewrite earlier Triggers or decision snapshots.

An Automation set to Ask first has at most one waiting decision, including a failed one awaiting
Retry. Later due times append references and update the count and latest due
time while its next run advances. Immutable Triggers remain separate evidence.
Dry run records decisions without starting work. Run decisions retain the same
dispatch identity through lease reclamation and retry.

The Inbox Activity tab includes Automation decisions under Decisions. Dry run says
`Would have started “<Automation>”`, Ask first says `Proposed “<Automation>”`, and Run says
`Started “<Automation>”`. Skipping or withdrawing records its own settlement while
retaining the original proposal. Names come from the frozen decision, so later
Automation edits do not rewrite history. The trailing Automation link opens its detail;
reasons remain separate from the description.

## Decisions that ask in the Inbox

A clock Automation's Ask first decision is an ordinary editable intake Page. A Project Automation
uses that Project's Inbox and Triage; a Space Automation uses the Library Inbox. A
heartbeat uses its Session's Project, or the Library Inbox for a projectless
Session. The title is `<Automation> · <date>`, and the body is its action text.
The Automation supplies its proposal; Nodex does not assess or suggest another action.

Editing the message changes this decision only. The Owner can choose an Agent
or model for this run; a heartbeat retains its Session's Agent. Starting freezes
the reviewed text and choice, moves the Page to Doing and admits the decision
through the Automation's execution owner. Its chat links to the Page. Images remain
on the Page. No Inbox chat outbox also dispatches it.

Retry uses the same frozen instructions and dispatch. Starting, retrying and
finishing a held decision never move its recurring clock. A failure before a
chat is reached returns the message to the Inbox with its reason and Retry.

Mark done skips a waiting decision. Return to Inbox makes it wait again only
while its Automation exists and has no other waiting decision. Sending it elsewhere,
filing it, deleting it or archiving its Page withdraws it. Mark done after a run
starts closes its Inbox work while execution continues. Deleting an Automation
withdraws waiting and admitted-but-unstarted decisions; their messages remain
readable and say the Automation was deleted. Run now confirms an existing held
decision using its current message. Until the person edits the message,
revision-fenced action changes refresh its text; afterward their text wins.

## Execution

Automations retain exact Agent instance, model, effort and service tier. A missing,
disabled or mismatched instance cannot admit work and never falls back to a
different backend. Readability does not depend on Agent availability. Automation
scope and execution Project remain explicit even when Projects share a folder.
Project execution revalidates active lifecycle and selected sources. Space
execution uses a fresh independent projectless workspace for each run.
A run's Agent acts on behalf of the Owner whose standing grant admitted it from its
first Turn, even when another Member wrote last in a heartbeat's chat.

The target stores Project and folders, local or worktree execution, Environment,
Agent selection, optional runbook Page and optional continued Session. Codex,
configured Claude Profiles and ACP instances use the same lease and run owner.
Claude workspaces are linked durably before submission; Claude never inherits
Codex service tiers or local Environment files. ACP retains its exact instance
and advertised model options. Environment selection appears only for a Codex
worktree target with exactly one Project source.

A heartbeat resolves its stable Session's current execution reference without
opening transcript history or resuming a second native client. Only one active
heartbeat targets a Session. Archiving the Session pauses its Automations and fences
claimed leases atomically; restoring leaves them paused. Deleting the Session
retires them. The clock alone sets a heartbeat's cadence: recent activity in its
chat never postpones a due beat, and what a beat does about that activity belongs
in its instructions. A heartbeat that repeats every so many minutes or hours beats
one interval after its previous beat started, however long that beat ran; one that
outlasts its interval is followed at once. Intervals of an hour or more land
within five minutes either side of that time, fixed per beat, so heartbeats that
began together do not all start in the same second. Busy state, background tasks and foreground eligibility are
rechecked before launch, and a beat that cannot start yet keeps its dispatch and
starts once the chat is free. A person-admitted heartbeat still waits for a busy
chat, but bypasses its foreground requirement.

Run now creates a durable manual dispatch and uses the same execution path as a
clock occurrence. Committed Automation changes wake the Host without waiting for its
safety poll. Before native dispatch, the Host rechecks the exact Run, decision
and live lease after workspace preparation; a withdrawn preparation cannot start. Dry run still records only. Stable run, launch, Session and
message identities exist before preparation; a crash can retry unfinished
preparation without creating a second execution. A bound or archived run never
starts a hidden replacement. Terminal failures and timeout or interruption
cancel only the exact accepted Turn. Automated Turns do not wait for interactive
questions or approvals.

Each new chat receives the Automation name and ID, previous run time and action text.
Heartbeats continue their existing Session. There is no implicit cross-run
memory file. A runbook is a live Library Page read at execution time, with its
title and key; each chat links to it and may update its instructions for later
runs. A missing or deleted runbook fails visibly until another Page or None is
selected. Runbook content cannot edit Automation authority.

The saved `failed_runs_only` notification preference suppresses successful and
interrupted completion notifications while retaining failures. Null restores
normal policy; omitted preferences are preserved. The preference binds the exact
originating Turn, including heartbeats and Run now, so personal follow-ups in
the same chat use normal notifications. Global notification settings still apply.

## Automations surface

The rail, command palette and Page Automations property open `/automations`. The sidebar
shows Automations, Search and New automation. Active Automations sort by next run, then paused
Automations, then name; Active and Paused filters, search, loading and error recovery
retain the existing behavior. Rows show name, mode, schedule, next run or paused
state, waiting Inbox attention, running state and unread runs. Their actions are
Pause or Resume, Run now, Edit and Delete. Pause and Resume are optimistic and
roll back with an error toast on failure.

The selected Automation shows its condition, action, schedule, target and recent
decisions with reasons. Cron runs can expand beneath it, newest first; a held
decision opens its Inbox. Runs open only after Session binding, mark themselves
read and can be archived. A heartbeat opens its continued chat while retaining
the Automations sidebar. Unavailable selections return to the landing page.

The editor keeps name, action, schedule, workspace, Agent/model, notification and
runbook controls. Mode offers Dry run, Ask first and Run. Owner appears when the
Space has more than one Member. The timezone is explicit and retained when the
Host changes local zone. Changing Project clears incompatible folder and
Environment choices. The continued-Session choice is fixed once an Automation exists.
Create remains disabled with the missing requirement until valid. Save is
explicit; changed drafts ask before discard, and deletion asks for confirmation.

A Page's Schedule action creates a clock Automation following it, with `Follow the
runbook.` as the action and Advanced open. A nameless Automation uses the runbook
title, else its first action line. Template selection seeds the same editor;
templates that change a repository ask first.

URL state uses `automationId` for selection, `automationMode=create|edit` for the dialog,
`templateId` or `runbookPageId` for creation seeds and `runSessionId` for an open
run. Saved `/scheduled` routes and locations redirect to `/automations`. They do not maintain another configuration surface.

## CLI and Agent interface

`nodex automations list|show|create|update|pause|resume|delete|run` uses Core directly.
Create and update accept `--file <path|->` Automation JSON. Update requires
`--if-revision` and `--status active|paused`; pause, resume and delete require
`--if-revision`. Writes accept `--idempotency-key`. Run records a manual dispatch.
`automations_update` provides Agent list, view and direct edits under the same Owner and
revision checks as the Agent's Member, and proposals for a change only the Automation's Owner
may make. Proposed changes remain unsaved until the Owner selects Create or Apply changes.

Page recurrence and reminders remain schedules for human work; they never start
Agent execution. See [ADR 0082](../adr/0082-automations-replace-scheduled-tasks.md).
