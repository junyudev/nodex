# Codex Workspace Behavior

## Scope

This document owns the product-level lifecycle around Chats: creation,
Project/projectless ownership, workspaces and worktrees, external discovery,
forks and Side chats, runtime integrations, and account/intelligence selection.
Visible turns, requests, tools, search, virtualization, and composer rendering
are specified in [Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md).
Multi-window publication and recovery are specified in
[Codex Owner/Follower Streaming](codex-thread-owner-follower-streaming.md).

## Chat identity and ownership

Project Chats belong to durable Project Sessions and link to one app-server
Thread. A Page may mention a Chat or send an immutable Page snapshot to it but
never owns the Chat. The sidebar may discover interactive root Threads created
by other local app-server clients and materializes them into Sessions.

A Workspace-owned **Linked chat** edge may associate a Page with a durable
Project Session. It records an explicit user action only: Open in new chat,
Send to chat, or Page Run Section. It is many-to-many, survives Window Scene
and optional Thread lifecycle changes, and grants neither Project nor Agent
Page access. Ordinary Page navigation, Scenes, mentions, references, links,
prompt text, and recent-Page state never infer an edge. Explicit removal is
idempotent and removes only the relationship.

Only first materialization may infer Project ownership from the longest matching
configured source root. Once recorded, Project identity or explicit projectless
identity is durable and never reinterpreted from a later cwd observation.
Moving a Chat between Projects is an explicit domain action.

A Chat may move between active Projects from either sidebar drag-and-drop or
its native context menu. The destination must cover every source folder of the
current Project; a destination folder covers itself and nested source folders.
When coverage is missing, Nodex asks before expanding the destination Project,
names every folder that all Chats in that Project would gain access to, and
makes no change when the user cancels. After confirmation, the Project source
expansion, Chat membership, workspace metadata, and writable roots commit as one
atomic change against the confirmed Project revision. A loaded app-server Thread
is synchronized after that commit; an unloaded Thread adopts the persisted
workspace when it is next resumed. Moving a Project Chat to Chats removes its
Project membership without discarding its existing workspace or writable-root
context.

Archived, deleted, internal helper, Side chat, reviewer, and parent-linked child
Threads do not become root sidebar Chats. If late ancestry proves that a row is
a child agent, Nodex removes its root-Chat presentation while preserving it for
the parent conversation.

## Starting and resuming

Opening an ordinary `New chat` atomically ensures and selects the one durable
default-draft Session for that Project, or the separate projectless scope.
Repeated New Chat actions return that exact Session, including its existing
composer, attachments, Scenes, and Terminal tabs. Explicit Page-backed, fork,
and externally materialized threadless Sessions are ordinary Chats and are not
eligible for this reuse.
Creating an explicit Page-backed Chat commits the ordinary Session and bounded
initial Page relationships in one Core transaction before Scene presentation.
If any Page cannot be authorized, no Session or relationship is created. A
later Scene failure keeps the valid durable Chat and relation. Send to chat and
Page Run Section first resolve a durable Session, then idempotently establish
the relationship, and only then start the Thread or Turn; a Codex send failure
does not compensate the already established user relationship.
The default-draft role does not reserve a visual slot: the Session participates
in the same persistent Project or projectless Chat order as every other Chat.
Dragging it changes that Session order, and first Thread attachment preserves
the chosen position.

First submit starts the Thread and first Turn on the same Session and links them.
Core refuses to replace an existing link with a different Thread, so concurrent
first sends have one winner and Main removes the losing unlinked app-server
Thread.
The successful link graduates that Session from the default slot; archiving the
draft also releases the slot, while restore and unlink do not reclaim it. The
initiating window keeps the draft surface until the canonical conversation and
optimistic first user Turn are visible; a durable Thread link alone never causes
a misleading empty transcript.

A direct local Project Chat runs from the primary source when present and a
generated per-Chat workspace otherwise. `New worktree` requires a primary Git
source, creates a managed worktree, optionally runs the selected Environment
setup, and starts the Thread there. Setup failure preserves a recoverable Session
and draft and does not create duplicate Sessions on retry. The complete target,
Git/setup, pending-route, handoff, and initialization-activity contract lives in
[Codex Worktree Creation Behavior](codex-worktree-creation-behavior.md).
The execution-location identity, post-creation snapshot/removal/restore,
retention, owner-transfer, and handoff contracts live in
[Codex Managed Worktree Lifecycle Behavior](codex-managed-worktree-lifecycle-behavior.md).

Stopping an ordinary Turn leaves the Chat resumable. Resume starts a userless
continuation with current Thread settings and creates no synthetic user message.
An archived Thread must be explicitly restored before resume.

## Projectless Chats

A projectless Chat has no Project authority and receives a generated workspace
under the user's Documents/Nodex collection. It persists cwd, output-directory,
and workspace-browser-root hints. Scratch work belongs under `work/`; user-facing
deliverables belong under `outputs/`. A persistent fork or Side chat inherits
the same workspace boundary.

Projectless Chats support conversation, Browser, exact-file previews, and
Terminal only when a cwd is available. They never infer Project ownership from
path containment and cannot open Project-only Database or Pages capabilities
without explicit access/context.

## Forks, Side chats, and child agents

A persistent fork creates an independent durable Chat from an eligible Turn.
An older-Turn fork asks for confirmation unless the user disabled that prompt.
The fork request carries the stable Turn identity directly to transcript authority and asks for a
metadata-only child response; neither the parent nor child complete history is loaded first.
Session-backed forks materialize and link the new Session before the bounded child tail is
published. The request captures one app-server host generation and revalidates the durable source
host immediately before dispatch. Execution-location commits use the same per-Thread causal lane,
so a concurrent handoff either waits for that fork or makes the stale fork fail before RPC.

A Side chat is a temporary excluded-history fork for a focused question. It
inherits the parent workspace identity and exact execution host, lives only in
a right/bottom panel tab, is excluded from durable Chat navigation, and is
discarded when closed. Creation uses parent metadata plus the stable source identity and is
independent of the parent's resident history size. It may not recursively create another Side chat.
Selected transcript text may prefill its composer without submitting.

Inline child agents remain descendants of one root Chat and open through the
single read-only Subagents surface rather than becoming root Sessions. Summary
presentation is defined in [Thread Summary Panel Behavior](thread-summary-panel-behavior.md).

## Sidebar availability

The sidebar keeps the last successful bounded Workspace snapshot while Core is
temporarily busy. A failed refresh may therefore return that snapshot with
stale provenance instead of replacing known Chats with an empty result. The
next refresh remains eligible to reconcile canonical state. On a cold start,
where no successful snapshot exists yet, a Core failure stays an explicit
retryable failure; it is never converted into a successful empty sidebar.

## Browser, Computer Use, Files, and Terminal

Browser pages, Computer Use, filesystem reads, and PTYs are Main-owned runtimes
attached through exact Window Session and Chat identities. Selecting another
Chat does not rewrite a runtime's owner. Browser Use captures the owning Scene
at Turn start and may materialize a visible or retained Browser surface without
destroying the page when panels hide.

Exact file previews may open outside a Project tree after top-level window
ownership is verified. Tree browsing stays within an explicit canonical root.
Editable files use bounded reads, recoverable drafts, compare-and-swap save,
watcher refresh, and explicit external-change conflict presentation. Bounded
image previews use ephemeral object URLs that are revoked when the file or
surface changes. PDF previews decode the binary response into PDF.js,
render every page through a dedicated worker-backed canvas pipeline, and add
selectable text plus inert-form annotation layers. Pages fit the panel by
default, support percentage and Ctrl-wheel zoom without losing the reading
anchor, track page navigation during scroll, and keep distant pages out of the
render window. Embedded destinations stay inside the preview; external HTTP(S)
links cross a validated Main-process navigation boundary.

Terminal PTYs start from the Chat cwd or Project primary source and have one
active Window Session input lease. Moving or closing a presentation does not
silently kill the PTY; explicit kill, backend exit, Project cleanup, and app
shutdown own termination. Before first send, a Session Terminal uses the real
Project Session identity with no conversation identity; Thread attachment may
add the real Thread association without replacing the PTY.

The native PiP layer is Desktop-Host presentation, not transcript or Scene
authority. It is shown only for a real active stream and is dismissed by the
owning runtime lifecycle. Thread Summary exposes only a host-backed show/hide
action.

Process Manager is the shared Workbench surface for registered background
processes across known Chats. It joins registry identity with live app-server
processes and Terminal-action sessions, polls only while open, and preserves
registered-but-missing rows instead of inventing live metrics. `Open output`
focuses the owning Chat when needed and opens the same live process-output
surface used by Thread Summary. Start/Restart require a retained command and
working directory; Stop acts on the exact live process or Terminal session.

## Intelligence and account state

A new Chat selects a provider, model, harness, reasoning effort, service tier,
collaboration mode, and personality from current host catalogs. Existing Chats
retain immutable provider/harness identity while allowing only catalog-approved
same-Thread changes to mutable intelligence settings. Forks and scheduled/child
execution inherit the source's latest durable profile.

Fast Mode is a global preference with the focused contract in
[Codex Fast Mode Core Enablement](codex-fast-mode-core-enablement.md). Provider
credentials and authenticated account state remain Main-owned and never enter
renderer persistence. Import of external-agent data is explicit, selective,
and never imports credentials, approval policy, or another product database.

Within one Profile, Main owns one generation-fenced app-server lifecycle.
Concurrent consumers join the same cold start; stop, failed initialization, and
reconnect retire the previous generation before another process can become
authoritative. A recovered connection refreshes and republishes the canonical
account snapshot. Until that snapshot is known, renderer account controls stay
unresolved rather than treating a transport failure as a signed-out account.

## Task actions and export

Chat actions support the applicable Pin/Unpin, Rename, Archive, Side chat,
working-directory/thread/deeplink copy, and Markdown export operations. Export
first obtains complete canonical visible history, then serializes that view; it
does not introduce another transcript store or app-server export endpoint.
