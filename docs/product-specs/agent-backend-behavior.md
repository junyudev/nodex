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

Text, pasted text, file references, skills and review/browser annotations without image evidence
reach native and ACP text prompts. Unsupported image attachments or inline Agent configuration
fail before submission and leave the draft available for correction. Individual capabilities such
as steering, queued follow-ups, fork, native review and desktop tools remain backend-specific;
unavailable actions never route a native session ID into Codex. Stop remains available while a
native turn runs, including when another draft is being composed.

Pending tool decisions use the shared approval form and expose only supported decisions. Questions
use the shared questionnaire, including multiple selections and free text. Authentication methods
appear as sign-in actions in that same composer. Generic tools keep inspectable inputs/results;
native subtasks appear as activity in the same timeline.

## Starting and reopening tasks

- The model menu lists Codex and enabled Claude Code and ACP Agent instances. Codex remains selected by
  default.
- Claude Code and ACP tasks require an active local Project with a primary workspace. Projectless and remote-host
  execution are unsupported in the initial release and are not silently redirected to Codex.
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
from the desktop process PATH; Agent settings can select an executable and an optional absolute
Claude config directory. Authentication stays in Claude Code: use `claude auth login` in a terminal
for the selected account, then reopen the task. Existing Claude login credentials remain native.

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
used for execution. Discovery sends no prompt, saves no Claude session and releases its process
after initialization. At most two discovery processes run concurrently.

The shared model menu displays versioned names and concrete IDs returned by Claude, including
gateway-specific IDs. SDK aliases resolve to those IDs before selection; context suffixes and
plan-routing aliases retain their meaning. Older executables that do not report a resolved ID
retain their advertised name and value without an invented version. Claude default follows native
configuration and displays its resolved model when advertised. Failed discovery leaves that default
available and reports the failure. Project or instance changes cannot reuse another scope's catalog.
The live session uses the same catalog projection and retains the concrete model reported at startup.
The same menu exposes Effort when the selected model advertises supported levels. It offers Default
and only the native levels reported for that model: Low, Medium, High, Extra High, and Max. Default
clears the session override; Claude Code remains responsible for native defaults and policy limits.
Selecting another model retains a supported effort and otherwise resets it to Default. Model and
effort changes apply to the next turn and are saved with the chat, without changing Claude's global
settings. Code and Plan modes control the native permission mode. These controls are available
between turns.

The conversation shows streamed text, thinking, tool calls and results, subtask progress, compaction,
and reported usage. Final assistant records replace their matching streamed blocks. Context usage
comes from the latest main-agent request, while cost is the SDK's cumulative estimate for the live
query. Tool approval offers a single-use decision; questions accept single or multiple choices and free text. Incomplete,
foreign, and stale responses are rejected. Stop denies pending requests and interrupts the turn;
if Claude does not settle within five seconds, Nodex closes the process and requires reconnecting.

Core retains the native session UUID independently of the instance binding. Reopening reads a
bounded recent transcript and resumes that exact UUID without submitting a prompt. Claude Code
retains the complete history. Saved model and effort choices are restored before the next prompt;
without a saved choice, the last real main-thread model in the transcript is restored, even if it is
no longer listed in the current catalog. Unsupported saved effort resets to Default. Subagent and
synthetic error records do not change the selection. An unavailable native session requires a new
task; Nodex never substitutes a fresh conversation under the old identity. Closing a task does not delete its Claude
Code history. Native subtasks appear in the transcript; they do not become Codex subagent tabs.

Claude Code currently supports text tasks in local Projects. Existing CLI conversation import,
remote-host execution, image/audio attachments, native Codex review/history/fork controls, and
Nodex's Codex-only application and desktop tools are not exposed by this backend.

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

Claude Code owns native tool execution and applies its configured permission rules and hooks before
callbacks reach Nodex. For callbacks that do reach Nodex, Ask/custom/missing Project modes require
an interactive decision. Approve for me and full-access modes allow tool callbacks; questions always
require an answer. A Nodex approval does not grant Codex desktop or application-tool capabilities.

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
- Prompt admission and durable active-state projection form one interruption-safe lifecycle. A
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
