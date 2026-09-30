# Agent Backend Behavior

## Scope

Every Agent Thread has one explicit backend binding. Codex is the default native backend. An
enabled Profile-local Claude Code or ACP Agent instance can be selected when starting a new task in a local
Project. A Thread never changes backend implicitly and never falls back to another backend when its
configured runtime is unavailable.

## Shared conversation surface

Every backend uses the same conversation page, rich prompt editor, Markdown timeline, activity
expansion, model menu and request cards. The model menu's Agent selector chooses a backend before
starting a task; changing it preserves the draft. An attached task retains its backend. Model and
Code/Plan selections are applied before the first prompt, and subsequent changes use the same menu.

Text, pasted text, file references and review/browser context reach native and ACP prompts. Claude
also accepts attached PNG, JPEG, GIF and WebP images, including browser evidence and app snapshots,
and invokes selected skills through native command syntax. The last selected skill is the leading
invocation; other selected skills remain inline references and the complete prompt/context becomes
its arguments, matching Claude's one-invocation-per-message contract. Unsupported attachments or inline Agent
configuration fail before submission and leave the draft available for correction. Individual capabilities such
as steering, queued follow-ups, fork, native review and desktop tools remain backend-specific;
unavailable actions never route a native session ID into Codex. Stop remains available while a
native turn runs, including when another draft is being composed.

Pending tool decisions use the shared approval form and expose only supported decisions. Questions
use the shared questionnaire, including multiple selections and free text. Authentication methods
appear as sign-in actions in that same composer. Generic tools keep inspectable inputs/results;
native subtasks retain their own activity and can be opened from the shared Tasks menu.

## Starting and reopening tasks

- The model menu lists Codex and enabled Claude Code and ACP Agent instances. Codex remains selected by
  default.
- Interactive Claude Code and ACP tasks require an active local Project with a primary workspace.
  Scheduled Claude tasks can also create a disposable projectless workspace. Remote-host execution
  is unavailable and is not silently redirected to Codex.
- Starting a Claude Code or ACP task creates the durable Thread with its explicit backend binding before the first
  prompt. Main derives the workspace and permission mode from that durable authority; renderer does
  not submit either value.
- After the Agent opens and its protocol session identity is bound, starting returns the durable
  Thread and initial conversation snapshot immediately. Main runs the first prompt in the
  application lifecycle and streams its progress through the normal observation path; navigation
  is not blocked on the Agent finishing the turn.
- Main stores the ACP protocol session identity separately from the Agent instance binding. Reopening
  the Thread uses negotiated `session/load` when supported and never replays an old prompt.
- If an ACP Agent no longer has the stored session, Nodex clears the stale protocol identity and reports
  that a new task is required. It does not create a replacement conversation with ambiguous history.
- Rename, pin, unread, archive, restore, and delete use the durable Session authority. Codex-owned
  refinements are invoked only for Codex Threads. Archiving or deleting a Claude Code or ACP task closes its live
  Agent process; archiving a Project is blocked by an active Agent turn and otherwise closes every
  Project-owned Agent process after the durable archive commit.

## Native Claude Code

Claude Code uses the installed executable and official Agent SDK. The default instance runs `claude`
from the desktop process PATH. Agent settings can add, name, enable or remove independent profiles,
each with its own executable, config directory, environment and custom models. An account path must
be absolute or start with `~/`, which Nodex resolves against the host home before saving it.
Authentication stays in Claude Code: use `claude auth login` in a terminal
for the selected account, then reconnect the task. Reconnection reads the latest profile without
replaying a previously submitted prompt. Existing Claude login credentials remain native.

Agent settings also edit the instance's environment as name/value rows. Pasting literal `KEY=value`
or `export KEY="value"` lines imports the rows; shell expansion and commands are rejected. Duplicate
names are invalid. A named empty value overrides an inherited value with the empty string; removing
the row resumes inheritance. Instance values override the Desktop environment for new connections,
including native history recovery, while a live connection retains its original environment. A saved
change does not interrupt a running turn or require restarting Nodex. Claude's own settings retain
native precedence. Config directory remains the only setting for account location; HOME and the
launcher's nesting markers cannot be overridden through environment rows.

Variables default to sensitive, except recognized URL, model and numeric tuning names. Users may
change that designation. Sensitive values are encrypted with the operating system's secure storage
and stored outside ordinary Profile settings; settings reads return only a saved-secret marker.
Leaving that marker unchanged preserves the value. Editing replaces it, including with an explicit
empty string, and removing the row removes its stored ciphertext. Secure storage must be available
to save or launch with secrets. Plain values remain in Profile settings. These are explicit user
inputs; Nodex never imports existing Claude credentials into this store.

User, project, and local settings, `CLAUDE.md`, skills, subagents, hooks, and configured MCP servers
are loaded by Claude Code. The composer exposes the commands and skills advertised by the SDK.
Before the first prompt, Nodex discovers models from the selected instance's executable in the
selected Project, with the same configuration directory, environment and native settings sources
used for execution. Discovery sends no prompt, saves no Claude session, suppresses hooks, MCP and IDE
integration, and releases its process after initialization. Its bounded cache includes the resolved
profile configuration and Project. Profile, configuration and Project changes refresh it
automatically. Visible catalogs revalidate on expiry; returning to the app revalidates an expired
catalog, and transient failures use bounded retry backoff. A failed refresh retains the previous
catalog for that same scope. The model menu has no manual refresh action. Changing scope or closing
the consumer cancels its request and releases its process. At most two discovery processes run
concurrently. An executable/version check does not claim authentication succeeded.

`Force reload skills` refreshes the selected conversation provider's advertised
skills and commands. For Claude it bypasses the native discovery cache and
updates the same scoped composer catalog; it never reloads another provider.
Providers without a refresh capability do not expose that command.

The shared model menu displays versioned names and concrete IDs returned by Claude, including
gateway-specific IDs. SDK aliases resolve to those IDs before selection; context suffixes and
plan-routing aliases retain their meaning. Older executables that do not report a resolved ID
retain their advertised name and value without an invented version. Native configuration selects
the initial model; discovery identifies its concrete value before the first prompt. Failed discovery
reports the failure without inventing model choices. Project or instance changes cannot reuse another
scope's catalog. Live metadata distinguishes requested preferences from applied native settings.
The menu shows the resolved model, effort and Speed state without inherited-default choices; an
unobserved value remains unresolved. Profile custom models specify a concrete ID and explicit effort,
Fast, adaptive thinking, thinking-disable and context traits. Nodex does not guess gateway capabilities
from a model name.

New Claude chats use the shared execution-location selector. Work locally runs in the selected
Project's primary folder; New worktree creates an owned managed worktree from the selected branch,
ref or working-tree state. The selected local Environment runs its setup in that worktree before
Claude starts. Setup environment changes are retained with the worktree and reloaded when the chat
reopens; explicit Claude Profile values take precedence, and setup cannot change the native account
or history directory. The chat retains its exact execution folder and allowed Project sources.
Attached local chats can move between that folder and a managed worktree through
the shared [handoff transaction](codex-managed-worktree-lifecycle-behavior.md#moving-a-chat).
The same Nodex Chat and exact native session UUID retain their history. Native
history lookup remains scoped to that session's account and history directory,
independently of its current working directory.

Core admission precedes Agent launch and worktree ownership publication. Failed preparation or an
explicitly rejected admission removes the unowned allocation. A committed link survives cancellation
and readback failure. An uncertain Core reply retains the allocation and its cleanup protection while
Nodex checks the original Session and exact execution location; uncertainty never causes deletion of
a potentially attached worktree.

Effort offers only the levels supported by the selected model: Low, Medium, High, Extra High, and Max.
Off belongs to Effort and appears only when that model can completely disable thinking. Adaptive
thinking support alone does not imply this capability. Selecting a regular effort reenables thinking,
including when that effort was already selected. Models that can disable thinking but have no effort
levels offer Off and On. A model's limits may lower the backing effort when disabling thinking.
Speed offers Standard and Fast when the selected model supports native Fast mode; those choices
disable or enable that native preference. Context appears only when multiple distinct supported values
are available.
Context applies to the concrete model resolved by the active native Query,
including a model inherited from Claude's configuration. Nodex verifies the
reported context before saving it; an unresolved model or refused context fails
explicitly. Default clears the override, reopening the same idle native session
without a model flag when necessary to restore inheritance. Draft choices remain
unsent preferences, while live Context reflects applied native state.
Changing a model or effort retains independent settings and drops an incompatible thinking-disable
override. Changing models also clears a Context override that the destination
model does not advertise; compatible Context choices remain intact. Native defaults
and policy limits determine the effective values. Requested preferences
and Code/Plan mode are saved with the task without changing Claude's global settings. Changes that
require rebuilding a Query wait for no foreground turn, pending decision, queued steering or live
background work.

The conversation shows streamed text, thinking, tool calls and results, subtask progress, compaction,
and reported usage. Final assistant records replace their matching streamed blocks. Context usage
comes from the latest main-agent request, while cost is the SDK's cumulative estimate for the live
query. Independent message blocks and child actors retain native identity; streamed inputs and
structured command, file, search and MCP results use the shared tool cards. Plans, task progress,
rate limits and compaction remain visible. Tool approval offers one use and, only when Claude supplies
safe permission suggestions, a session choice. Native decline defaults and restrictions on persistent
approval are respected. Questions accept single or multiple choices and free text. Resume dialogs
and MCP elicitation use their native response contracts. Incomplete,
foreign, and stale responses are rejected. Stop denies pending requests and interrupts the turn;
if Claude does not settle within five seconds, Nodex closes the process and requires reconnecting.
Stop interrupts the foreground turn. Live background and ambient tasks remain visible, protect their
Query from idle eviction, and have explicit task stop controls. Background requests are not discarded
when the foreground finishes. SDK result correlation decides which accepted user inputs settled;
queued steering can become a subsequent native turn and retains its own admission receipt.

Core retains the native session UUID and canonical history directory independently of the instance
binding. Reopening reads a bounded recent transcript and resumes that exact UUID without submitting
a prompt. Forked chats inherit their source's native history directory. Claude Code
retains the complete history. Earlier turns can be loaded into the bounded presentation window.
The live window retains up to 64 recent turns; loading history can expand it to 512 turns within
a 2 MiB transcript budget. Each older page admits at most 512 KiB of content, or one bounded turn,
and continues from the oldest message actually admitted. A full window disables further loading
instead of evicting current turns or running-task observations. Updates above the 1 MiB delta budget
invalidate the local replica and re-read the exact snapshot; subsequent streaming remains active.
History images are read on demand from the exact profile/session/message identity into temporary
owned media; base64 content is excluded from transcript snapshots. Core stores requested preferences,
whether the UUID was saved, and a bounded set of UUID-matched terminal facts, timestamps, observed
usage, compaction summaries and generated-file outcomes. Native history without a known terminal
fact retains an unknown outcome. Truncated tool text can be read on demand from the exact native
message and tool identity; the larger read budget still reports any remaining truncation. Effective
startup values, subagent records and synthetic errors do not replace requested preferences. Without
a saved override, native inheritance remains selected. An unavailable native session requires a new
task; Nodex never substitutes a fresh conversation under the old identity. Closing a task does not delete its Claude
Code history. A legal native reset or rollback changes the saved native identity through an expected-ID
guard. Fork creates a separate native conversation and Nodex task in the source execution location,
retaining its managed worktree and allowed workspace roots; native UUID remapping preserves
matching terminal facts. Editing the last user turn rolls it back before submitting its replacement;
editing the only turn starts a fresh unsaved native identity. Steering and compaction use native
controls. Read-only task details remain observations rather than durable Codex Threads.

Diagnostics expose native health, account, agents and MCP status. An explicit title action uses a
bounded auxiliary Query with tools, hooks, MCP and persistence disabled; ordinary sends do not run a
hidden paid helper. Existing CLI conversations can be connected through the shared
[native conversation chooser](native-conversation-connection-behavior.md), retaining their native UUID
and history directory. Audio, remote-host execution and Codex
desktop/review controls remain outside the native backend's current capability contract.

## Native application tools

Local Claude tasks use a scoped `nodex_app` connection for authorized Page and Data Source
operations, Project SQL queries, Project and Session metadata, native conversation history,
Session messaging, scheduling, terminal observation and workspace dependencies. Discovery and
auxiliary title queries receive no Nodex tool connection. The capability response lists the
connection's real catalog; live Workbench controls and pull-request attachment are unavailable
for Claude.

Main grants the bridge authority only after accepting the exact foreground Turn and freezing
its current Core policy. Plan mode remains read-only. Tool arguments cannot select the calling
Thread, Turn or Profile generation. Each call verifies the current native identity, Profile and
execution location and rechecks the frozen authority, including receipt replay. Failed admission,
settlement, process closure and stale binding revoke access. An accepted input identity cannot be
reused for another prompt; operation retries retain their original admission.

All Claude application calls pause while any native background task or ambient watcher is
live. The shared native transport does not identify every caller reliably, so a child cannot
inherit a later foreground Turn's authority. Once background work ends, a still-running
foreground Turn can issue fresh calls; revoked calls never become valid again. Native background
application tools are an explicit unavailable capability.

## Claude automations

Scheduled Claude tasks retain an explicit configured Profile binding. The existing Scheduled
editor selects that Profile, concrete model and supported effort through the shared Agent menu;
Inherited preferences display their resolved native values. Profile environment values apply to launches.
Project worktree runs can use a local Environment configuration; local checkout and projectless runs
cannot. Codex service tiers do not apply to Claude.

Cron execution uses the ordinary durable definition, due lease, run inbox and Session owners.
Project runs use the selected local folder or an owned managed worktree; projectless runs use a
fresh work/output workspace. The workspace is linked to Core before launching Claude. Unowned
failed worktrees are removed, while a successfully linked workspace survives later owner-metadata
repair failures. No runtime or backend fallback is selected.

Heartbeats target the existing stable Session and require its current attached Thread to retain
the same Claude Profile. The shared native conversation owner publishes eligibility only while
the conversation has no pending prompt, approval, question or background work. Execution rereads
that state and the definition revision. Scheduled turns are unattended: interactive decisions fail
instead of waiting for a renderer response. Execution is bounded within its due lease and cancels
the exact accepted Turn on failure, timeout or interruption. Failed runs remain reviewable.

## ACP conversation behavior

ACP conversations render from a bounded canonical projection. The UI can show user and Agent
messages, thinking/context summaries, tool calls, plans, usage, compaction, session information, and
turn stop reasons without depending on raw ACP payloads. Unknown extension metadata is ignored.

Mode, configuration, authentication, load/resume/fork labels, and content support appear only when
negotiated. Codex-only Browser, review, history, side-task, and native subagent controls are not
presented as ACP capabilities. The Claude Agent can use Nodex-owned client filesystem and terminal
callbacks. Those callbacks are limited to the Thread's canonical Project workspace, reuse the
supervised Terminal runtime, retain bounded output, and terminate with the ACP session.

Native Browser, Chrome, Computer Use, and Picture-in-Picture control surfaces are available only to
an admitted local Codex execution generation. ACP tool names or unknown extension metadata never
activate those surfaces. An ACP backend may gain a control surface only through a future explicitly
negotiated capability with its own host, identity, lifecycle, and trust contract; Nodex does not infer
one from superficially similar tools.

When session opening requires one unambiguous Agent-owned authentication method, Main authenticates
and retries the open request once. When several Agent-owned methods are advertised, the initialized
process stays alive and the conversation surface asks the user to choose one; only then does Main
open and durably bind the protocol session. Terminal authentication is not advertised by the current
client and fails explicitly rather than leaving an unusable task. While interactive authentication is
pending, Main keeps the not-yet-submitted first prompt inside that live session. Successful
authentication first binds the protocol session and then consumes that prompt exactly once. The
prompt is not persisted, cannot survive a Main restart, and is never replayed during recovery.

One prompt runs at a time. Long-running prompts have no product wall-clock timeout. Stop sends ACP
cancellation and keeps accepting already-admitted updates until the Agent reports a cancelled turn.
Ordinary request rejection and request cancellation return the session to ready state with a
recoverable conversation error. An authentication-required response returns to the authentication
surface. Process loss, protocol corruption, bounded-queue pressure, timeout, resource loss, or an
invalid lifecycle response closes the live session.

## Permissions and trust

ACP permission decisions are made in Electron Main from the Project permission mode. “Ask for
approval”, custom, and missing modes fail closed until an interactive approval surface owns the
request. “Approve for me” and full-access modes may select only an Agent-offered allow-once option.
Renderer cannot approve by altering an IPC payload.

The ACP Claude Agent integration is an explicit user-managed local-code authorization. Package
and executable probes establish compatibility, not byte provenance. See [Configuration](../CONFIGURATION.md)
and [Security](../SECURITY.md) for the trust boundary.

Claude tasks offer Ask for approval, Approve for me and Full access. These choices read and save
the Core Project or projectless permission preference independently of Codex configuration and
requirements. Ask uses Claude's default permission mode and asks for requests that reach Nodex.
The permission control waits for the Core preference or current native policy to be known. A choice
made before the first prompt saves that preference for the task's initial launch.
Approve for me keeps that native mode and automatically allows eligible tool requests; it does
not run a separate risk reviewer. Questions and requests marked default-to-no still require a
decision. Full access selects Claude's `bypassPermissions` mode. Plan keeps native Plan mode
and read-only application authority under every permission choice. Custom Codex configuration
is not a Claude permission option; an existing custom or missing preference falls back to Ask.

Claude Code owns native tool execution and policy enforcement. Nodex re-reads the current
permission preference for native callbacks and subsequent inputs, and a live selection waits
for the SDK to accept its mode before saving the preference. SDK rejection or cancellation before
persistence preserves the old selection. Once persistence starts, a bounded handoff finishes the
Core commit and native policy synchronization before honoring cancellation. A failed or uncertain
commit closes the session rather than claiming that the previous preference was restored; reopening
reads Core's actual preference. Live metadata distinguishes the selected permission preference from the
effective native mode. A Nodex approval does not grant Codex desktop capabilities. Application
tools retain their separately frozen Core Project or Library authority for the exact accepted
turn, with Plan requests read-only.

## Reliability and bounds

- Each live Agent process belongs to the Main application Scope and is terminated on Thread close,
  fatal transport failure, or application shutdown.
- Live Claude Code and ACP processes have a fixed pressure bound. Once reached, a new session fails explicitly until
  another session closes or completes idle eviction; Nodex does not silently evict an observed task.
- Both conversation projections bound turns, updates per turn, and projected bytes. Claude Code
  bounds pending decisions and history-worker memory; the SDK owns its wire transport. ACP also
  bounds NDJSON records, callback concurrency, ingress, and stderr diagnostics.
- Closing or failing a session invalidates stale in-memory handles. Independent Threads do not share
  a lifecycle lock, and per-Thread serialization lanes are released when no operation uses them.
- Prompt admission and durable active-state projection form one interruption-safe lifecycle. Rejected
  busy requests cannot settle another turn, failed admission revokes its application-tool claims, and
  stale profile/workspace handles fail closed. A
  request interruption or application shutdown clears the active projection instead of leaving a
  ghost-running Thread.
- Renderer observations are reference-counted across windows and split views. The first observer
  keeps the live Agent session resident; losing the last observer starts a bounded idle-retention
  grace. Returning during the grace cancels eviction. An in-progress turn is never evicted and is
  rechecked after the grace; an idle unobserved session is closed, while Core retains the durable
  Thread and protocol-session identity needed for an explicit reopen.
- Renderer registers one Thread-directed observation before opening a session. Observation owners,
  unique observed Threads, and duplicate leases are bounded. Open/read returns the initial snapshot;
  subsequent updates are exact, bounded revision deltas. Stale deltas are ignored and a revision
  gap triggers a fresh snapshot read, preventing open/read/live-update races without broadcasting
  resident transcripts to unrelated windows.

## Related decisions

- [ADR 0055: ACP sessions are isolated scoped backend resources](../adr/0055-acp-session-runtime-boundary.md)
- [ADR 0056: Codex stays native while external agents negotiate capabilities](../adr/0056-native-codex-and-capability-negotiated-agent-backends.md)

- [ADR 0065: Native Claude Code backend](../adr/0065-native-claude-code-backend.md)
