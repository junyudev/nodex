# Thread Summary Panel Behavior

## Intent and ownership

The Thread Summary panel is a derived view of one attached root Chat. It gives
the user compact access to the active task's schedule, environment, plan,
outputs, auxiliary conversations, processes, Browser state, and sources without
creating another conversation or runtime authority.

The selected Session Scene owns whether its pinned summary is open. Workbench
owns pinned/popover placement and responsive shell geometry; see
[Workbench Shell](workbench-shell.md). This document owns the summary's section
model, row behavior, and navigation outcomes. Canonical conversation, Git,
Automation, Browser, Computer Use, and process Modules remain the data owners.

The summary action is available only for an attached root Chat. A full-width
right panel hides it. While the summary is closed and the Chat has live
background tasks, the action carries a small dot in its icon's color and its
name counts them, such as `Toggle summary · 2 background tasks`. Pinned mode persists its open preference; the responsive
popover is dismissible presentation and does not rewrite that preference. A
resize changes placement according to the remaining chat-pane width. The
transcript and Composer share the same animated horizontal offset; the summary
slides and fades at the pane edge without scaling. See [Workbench Shell](workbench-shell.md#layout)
for responsive placement, focus, and motion behavior.

## Section model

The summary projects keyed sections in this order:

1. Automations
2. Environment
3. Plan
4. Outputs
5. Side chats
6. Subagents
7. Background
8. Computer Use
9. Browser
10. Sources

Optional empty or unsupported sections are omitted rather than rendered as
disabled placeholders. Sources is the deliberate exception: it remains
available for the attached Chat and can present its empty state. The section
projector owns order, visibility, counts, headerless presentation, and initial
auto-collapse; JSX does not reintroduce independent visibility branches.

Sections with headers support explicit expand/collapse. A collapsed section may
show its count beside the title; expanded sections do not repeat the count.
Headerless sections render their content directly. A finished background-agent
section may initially collapse until the user changes it, after which the user's
choice wins.

## Automations

Automations shows the first active heartbeat Automation attached to the Chat. It
comes from the canonical Automations read model, never from Board
schedules or transcript tool labels.

The row shows the Automation name, optional schedule summary, and next-run
information. Activating `Open Automation` opens the Workbench Automations
route with that exact Automation selected. Automation definition and run behavior
is specified in [Automations Behavior](automations-behavior.md).

## Environment and Git actions

Environment is visible only for a non-projectless attached Chat with a
resolvable Git working directory. Environment shows Git source changes and may
appear alongside Outputs, which shows deliverables. Projectless Chats keep
deliverables in Outputs even when their working directory is a Git repository.

`Changes` aggregates staged, unstaged, and branch-review state. It shows only a
loading state, non-zero additions/deletions, or no trailing value. Activating it
opens Review using the first available source in this order: staged, unstaged,
then branch.

`Commit or push` is a native Git workflow, not a Review shortcut. Its disabled
explanation distinguishes loading, unavailable repository/branch state, no
changes to commit, and no commits to push. Once accepted, the summary row owns
the visible workflow phase and cancellation action while the dialog closes.

The commit dialog can include unstaged changes, generate a missing commit
message from the staged diff, commit, commit and push, or push existing branch
commits. Empty generated output aborts instead of inventing a commit subject.
Push establishes upstream when an `origin` remote is available. Completion
refreshes the summary's Git and branch projections.

A detached checkout with a valid Git HEAD exposes `Create branch`. A managed
worktree that remains on the repository default branch keeps its branch selector
and adds the same setup action. Starting Commit/Push or Create PR from a state
that requires a branch first runs this `Work here` setup and continues the
original action only after branch creation succeeds.

`Create pull request` opens the native PR workflow. If the current branch
already has a PR, the action becomes `Open pull request`. Creating a PR may
commit selected local changes, push the branch, generate a missing title/body,
and create a draft or ready PR. Missing GitHub CLI, unknown branch state, or an
active PR workflow disables the action with a specific explanation. The summary
row shows the active phase and cancellation state and refreshes Git/PR state
after success.

Branch and execution-location selectors are full-row controls: the selected value
appears once in the row label and the trailing icon communicates only menu
affordance. The attached-Chat menu is titled `Continue in`. The new-chat
Composer separates `Location` from `Configure local environment`, whose
worktree, branch, and Environment controls follow
[Worktree Creation Behavior](codex-worktree-creation-behavior.md).

For an attached local Codex or Claude Chat, `Continue in` opens the actual
execution handoff workflow. Confirming moves the same Chat, native conversation
and uncommitted Git state between the Project checkout and a managed worktree.
The row derives Local or Worktree from the Chat's durable location; selecting or
confirming a destination never changes that label before commit. New-Chat
preferences and unsent drafts remain independent. Progress follows the shared
handoff owner, and an unresolved recovery disables another move. Unsupported
backends and execution hosts have a location row without an interactive menu.
See [Moving a Chat](codex-managed-worktree-lifecycle-behavior.md#moving-a-chat).

## Plan, Outputs, and Sources

Plan renders the current structured task plan from the conversation projection.
It does not reconstruct a plan by scraping transcript prose.

Outputs lists what the Chat's Agents produced for you to open, newest turn
first and at most five rows; a resource several turns produced appears once, at
its most recent turn. One deliverable model per completed turn feeds both this
section and the cards after that turn's response (see
[Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md)):

- files the Agent cites as output, or links as a document in its last message;
- documents, web pages, spreadsheets and images the Agent created or edited that
  Git does not see: ignored by the Chat's repository, outside it, or with no
  repository at all;
- generated images and image views;
- Google Drive resources, a single local website URL, and app-generated resources.

Outputs and Environment divide a turn's files. A tracked file, or an untracked
one Git would show in Review, is a source change owned by Review and
Environment unless the Agent explicitly cites or links it as an output. A
projectless Chat's filesystem deliverables are the files inside its output
directory, whatever their Git state. Deleted files, source citations, scratch
paths and inline visualization sources are never outputs.

Every file is confirmed on the Chat's execution host: unconfirmed files stay
hidden while loading and missing files disappear. When confirmation fails,
explicit outputs and projectless deliverables remain, but an edited Project
file whose Git state is unknown is not promoted.

Rows and turn cards show file-type artwork and name a generic entry file by its
folder, such as `report/index.html`. File outputs use the same side-panel file
intent on both surfaces: eligible local HTML opens rendered in Nodex's Browser;
other files, including images and remote files, open in Files on the Chat's
execution host. Website, Google Drive and app URLs use the shared link destination
settings and activation modifiers. A website represented by a local HTML path
uses file opening instead.

Open in choices offer an explicit in-app preview, actual native destinations,
and their system-default designation when known. Local files additionally offer
Show in Finder, Show in File Explorer or Show in File Manager, and Download a
copy. Website choices offer explicit Nodex Browser opening, available native
browsers and Copy link. Native choices do not change the preferred opener.
Destination discovery has a loading state. Context-click and Shift+F10 retain
the same file and URL context-menu actions used by message links.

Sources is an icon-only accessible list. It does not add a duplicate text-pill
representation of the same integrations, and it shows `No sources yet` when no
source has been projected.

## Side chats, Subagents, and Background

A Side chat row uses only the side-chat tab title. It opens the owning panel tab
and replaces its ordinary icon with the shared activity spinner only while that
conversation is responding. Panel loading, open, or expiry state is not repeated
as row text.

Subagents uses the canonical root-scoped overview and shared identity from
[Codex Subagent Behavior](codex-subagent-behavior.md). Inline agents appear as a
compact strip that prefers up to four unfinished agents, or the last four
finished agents when none remain active. The root panel groups metadata-only
rows as Active and Done, initially shows at most four Active and ten Done rows,
and exposes exact totals only after discovery is complete. An Agent chat's sections
count every subagent from the start, including rows on pages not yet loaded. It uses the same
runtime/history status rules as inline activity; unnamed rows are omitted.
Waiting rows retain elapsed time, and the Done section is absent when its count
is zero. Show more expands the already discovered collection; Show less restores
the initial limits without loading child transcripts.

Overview rows use objective or status summary text and never assistant answer
text. Selecting a row verifies root membership and hydrates only that child's
bounded sparse detail; siblings remain metadata-only. A ready child detail is
interactive only when its child and writer state permit it and otherwise stays
read-only. Avatar identity and row preview text remain static across status
changes.

Background lists work an Agent left running after the tool call that started
it, not child-agent metadata. Every Chat presents it the same way; the source
differs. For a Codex Chat attached to a remote host the rows are its background
terminals: selecting one opens the same live Process output surface as Process
Manager, a terminal with a process stops alone, Stop all cleans every terminal,
and the section's `View all processes` action opens the Workbench-owned dialog.
Process status and action behavior remain summarized in
[Codex Workspace Behavior](codex-workspace-behavior.md).

For a Runtime Chat, such as Claude Code or a local Codex Chat, Background lists
the background shells, terminals, monitors and other tasks the Session's Agents
reported as still running,
including while the Agent is replying and including work a delegated
conversation left running, which names that conversation after the task. These
are the same facts that keep the Chat's sidebar spinner turning, so the list
always explains it. Each row shows the name the Agent gave the work, a shell,
bell or generic icon for its kind, and how long it has run; its tooltip adds the
exact command. Selecting a row opens the end of its output beneath it, following
new output every two seconds, or says the Agent cannot show output for that
task. Hovering a row reveals Stop; with two or more tasks the section header
offers Stop all, which stops exactly the listed tasks and never the Agent's
reply or its subagents. A stopped row reads `Stopping…` until the Agent ends the
task, and a task still listed fifteen seconds after an accepted Stop can be
stopped again. See [Agent Runtime Behavior](agent-runtime-behavior.md).

## Computer Use and Browser

Computer Use is a headerless row rendered only while the canonical Main
control-surface snapshot reports the current task active and the native host
action is available. Its action changes that task's shown/hidden preference; a
placeholder row is never rendered without a working host action. The preference
survives reload, archive, and close, and is removed with permanent task deletion.
Main owns activity sources, placement, native presentation, and teardown; the
renderer only projects the latest bounded revision.

The complete cross-backend behavior is specified in [Desktop control surfaces](desktop-control-surfaces.md).

Browser rows come from the Browser summary model. A row shows title, display URL,
favicon or Browser fallback, and the Browser Use working state. Its native title
may expose the full raw URL; panel location is not repeated as trailing copy.
While Browser Use is active, the title/URL may use the explicit classic working
shimmer and the overlaid Browser-use pointer remains static. Settled rows render
neither working shimmer nor a spinner overlay.

The thread scroll viewport, sticky footer, Home surface, and floating summary
report observed anchor, obstacle, passthrough, and animation geometry to the
remote-hosted PiP owner. Geometry never asserts task activity or visibility.
Unmount clears that host geometry so a stale task cannot continue positioning
the native layer. Native Browser presentations can focus their exact source tab;
the same stack can move between an eligible primary window and the auxiliary
desktop-pet host without changing task truth.
