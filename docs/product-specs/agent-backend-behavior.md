# Agent Backend Behavior

## Scope

Every Agent Thread has one explicit backend binding. Codex is the default native backend. An
enabled Profile-local ACP Agent instance can be selected when starting a new task in a local
Project. A Thread never changes backend implicitly and never falls back to another backend when its
configured runtime is unavailable.

## Starting and reopening tasks

- The new-task surface lists Codex and enabled ACP Agent instances. Codex remains selected by
  default.
- ACP tasks require an active local Project with a primary workspace. Projectless and remote-host
  ACP execution are unsupported in the initial release and are not silently redirected to Codex.
- Starting an ACP task creates the durable Thread with its explicit backend binding before the first
  prompt. Main derives the workspace and permission mode from that durable authority; renderer does
  not submit either value.
- After the Agent opens and its protocol session identity is bound, starting returns the durable
  Thread and initial conversation snapshot immediately. Main runs the first prompt in the
  application lifecycle and streams its progress through the normal observation path; navigation
  is not blocked on the Agent finishing the turn.
- Main stores the ACP protocol session identity separately from the Agent instance binding. Reopening
  the Thread uses negotiated `session/load` when supported and never replays an old prompt.
- If the Agent no longer has the stored session, Nodex clears the stale protocol identity and reports
  that a new task is required. It does not create a replacement conversation with ambiguous history.
- Rename, pin, unread, archive, restore, and delete use the durable Session authority. Codex-owned
  refinements are invoked only for Codex Threads. Archiving or deleting an ACP task closes its live
  Agent process; archiving a Project is blocked by an active ACP turn and otherwise closes every
  Project-owned ACP process after the durable archive commit.

## Conversation behavior

ACP conversations render from a bounded canonical projection. The UI can show user and Agent
messages, thinking/context summaries, tool calls, plans, usage, compaction, session information, and
turn stop reasons without depending on raw ACP payloads. Unknown extension metadata is ignored.

Mode, configuration, authentication, load/resume/fork labels, and content support appear only when
negotiated. Codex-only Browser, review, history, side-task, and native subagent controls are not
presented as ACP capabilities. The Claude Agent can use Nodex-owned client filesystem and terminal
callbacks. Those callbacks are limited to the Thread's canonical Project workspace, reuse the
supervised Terminal runtime, retain bounded output, and terminate with the ACP session.

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

The current Claude Agent integration is an explicit user-managed local-code authorization. Package
and executable probes establish compatibility, not byte provenance. See [Configuration](../CONFIGURATION.md)
and [Security](../SECURITY.md) for the trust boundary.

## Reliability and bounds

- Each live Agent process belongs to the Main application Scope and is terminated on Thread close,
  fatal transport failure, or application shutdown.
- Live ACP processes have a fixed pressure bound. Once reached, a new session fails explicitly until
  another session closes or completes idle eviction; Nodex does not silently evict an observed task.
- NDJSON records, concurrent callbacks, update ingress, stderr diagnostics, projected turns, updates
  per turn, and projected bytes are bounded.
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
