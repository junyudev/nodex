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
right panel hides it. Pinned mode persists its open preference; the responsive
popover is dismissible presentation and does not rewrite that preference.

## Section model

The summary projects keyed sections in this order:

1. Scheduled
2. Environment
3. Plan
4. Outputs
5. Side chats
6. Subagents
7. Tasks
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

## Scheduled

Scheduled shows the first active heartbeat Automation attached to the Chat. It
comes from the canonical scheduled-Automation read model, never from Board
schedules or transcript tool labels.

The row shows the Automation name, optional schedule summary, and next-run
information. Activating `Open scheduled task` opens the Workbench Scheduled
route with that exact Automation selected. Scheduled definition and run behavior
is specified in [Scheduled Route Behavior](scheduled-route-behavior.md).

## Environment and Git actions

Environment is visible only for a non-projectless attached Chat with a
resolvable Git working directory. It is mutually exclusive with Outputs:
projectless Chats keep deliverable artifacts in Outputs even when their working
directory happens to be a Git repository.

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

Branch and start-location selectors are full-row controls: the selected value
appears once in the row label and the trailing icon communicates only menu
affordance. The attached-Chat menu is titled `Continue in`; the new-Chat
composer continues to use `Start in`.

## Plan, Outputs, and Sources

Plan renders the current structured task plan from the conversation projection.
It does not reconstruct a plan by scraping transcript prose.

Outputs contains user-facing artifacts and resources:

- generated images and image views;
- assistant file references and Markdown file links;
- completed-turn edited-document artifacts;
- Google Drive links, website previews, and app-generated resources.

Ordinary source edits remain in Review or Environment. A source path enters
Outputs only when the completed-turn artifact model classifies it as a supported
deliverable. For projectless Chats, the persisted output-directory hint limits
filesystem artifacts to that deliverable directory.

URL outputs open through the browser route, images open the local image preview,
and files or local websites open a renderer-local Files preview before falling
back to the desktop file opener.

Sources is an icon-only accessible list. It does not add a duplicate text-pill
representation of the same integrations, and it shows `No sources yet` when no
source has been projected.

## Side chats, Subagents, and Tasks

A Side chat row uses only the side-chat tab title. It opens the owning panel tab
and replaces its ordinary icon with the shared activity spinner only while that
conversation is responding. Panel loading, open, or expiry state is not repeated
as row text.

Subagents uses the canonical root-scoped overview and shared identity from
[Codex Subagent Behavior](codex-subagent-behavior.md). Inline agents appear as a
compact strip that prefers up to four unfinished agents, or the last four
finished agents when none remain active. The root panel groups metadata-only
rows as Active and Done, initially shows at most four Active and ten Done rows,
and exposes exact totals only after discovery is complete. Unknown evidence
stays unresolved instead of becoming Done, Waiting rows retain elapsed time,
and the Done section is absent when its count is zero. Explicit `Show more`
loads the expanded metadata window; `Show less` returns to the bounded initial
window.

Overview rows use objective or status summary text and never assistant answer
text. Selecting a row verifies root membership and hydrates only that child's
bounded sparse detail; siblings remain metadata-only. A ready child detail is
interactive only when its child and writer state permit it and otherwise stays
read-only. Avatar identity and row preview text remain static across status
changes.

Tasks represents registered background processes, not child-agent metadata.
Rows can open the same live Process output surface as Process Manager, and the
section's `View all processes` action opens that Workbench-owned dialog. Process
status and action behavior remain summarized in
[Codex Workspace Behavior](codex-workspace-behavior.md).

## Computer Use and Browser

Computer Use is a headerless row rendered only while the desktop host reports a
real toggleable PiP stream. Its action shows or hides that stream; a placeholder
row is never rendered without a working host action. The host owns stream truth,
placement, and teardown.

Browser rows come from the Browser summary model. A row shows title, display URL,
favicon or Browser fallback, and the Browser Use working state. Its native title
may expose the full raw URL; panel location is not repeated as trailing copy.
While Browser Use is active, the title/URL may use the explicit classic working
shimmer and the overlaid Browser-use pointer remains static. Settled rows render
neither working shimmer nor a spinner overlay.

The thread scroll viewport, sticky footer, and floating summary report their
anchor and obstacle geometry to the remote-hosted PiP owner. Unmount clears that
host geometry so a stale Chat cannot continue positioning the native layer.
