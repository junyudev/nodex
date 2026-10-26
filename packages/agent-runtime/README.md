# Agent Runtime

Agent Runtime owns execution Threads, Runs, provider sessions, queued work,
delegated tasks, transcripts, command receipts and execution recovery. It runs
outside Electron Main and writes a dedicated `agent-runtime.sqlite` database
beneath its absolute home. Content and desktop capabilities remain host-owned.

The process starts with `--home <absolute-directory> --cwd <execution-directory>`. Its first
stdin line is the bootstrap frame (`type: "bootstrap"`, see `src/nodex/Bootstrap.ts`); the
process refuses to start without it. Its `providers` map carries the provider instances; each
entry selects the `codex`, `claudeAgent`, `opencode` or `acpRegistry` driver and its canonical settings.
Named instances retain independent executables, homes and environments.
ACP instances can set `config.inheritEnvironment: false`; their supplied environment is then the
complete native environment, including any explicitly selected authentication or proxy values.
`providers.configure` replaces the in-memory instance map. Idle changes apply immediately;
foreground and native background work retain their current instance until their work ends.
Configuration values do not enter command receipts or the execution database.

The process accepts one JSON request per stdin line and writes JSON responses and
notifications to stdout. Diagnostics use stderr. The public contract is
[`src/nodex/Interface.ts`](src/nodex/Interface.ts). A `ready` notification includes
its persisted identity, process generation, database path and credential-protected loopback MCP
endpoint. Recovery completes before readiness and command admission.

`thread.snapshot` reads the bounded SQL history window and emits a compact wire
projection with cursor and omission markers. `thread.history` follows an opaque
cursor. `thread.item` hydrates one item's bounded detail, verifying captured ancestry for inherited
fork items. `thread.item.full` returns the explicitly requested canonical item for copy/export,
up to the single-response budget of 15 MiB. Event observations carry
wire-projected updates, so large tool output is fetched on demand. File changes keep each file's
diff and measured line counts on the wire; a diff past the per-item budget is withheld whole. There is no
public full-transcript snapshot operation.
`thread.read` and `thread.authority` expose control metadata without hydrating history.
Authority includes the Thread's resolved execution directory, branch and workspace path.
`tasks.overview` pages active and completed task metadata independently, starting with four active
and ten completed tasks; prompts, progress and result bodies are never read for this overview.
`execution.observe` emits only Run status and Thread deletion metadata; filtered observers use
type-specific SQL queries and live channels before retaining events. Every subscription returns
its explicit ownership token for scoped cancellation.

The process registers the four provider drivers and the task tools described below. OpenCode instances
select their native 1.x or 2.x adapter from their executable. ACP's stdio bridge commands use
a separate entry path without acquiring the engine or provider runtimes.
The engine is the single production composition `layerProduction` in
`src/orchestration-v2/runtimeLayer.ts`: execution services, the provider continuation worker and
hourly pruning of settled outbox receipts older than seven days (failed receipts and cancelled
provider retirements remain). `src/nodex/Runtime.ts` supplies only platform capabilities and
explicit policy overrides, and parked workers start after startup recovery completes. Desktop
launch, worktree setup, content operations, scheduled tasks and usage-limit auto-resume remain
host-owned. The public Runtime service composes ACP management and native session import around
the engine; the host links imported Threads to product Sessions.

## Agent tools

Every provider attaches one MCP server named `nodex_app` (`NODEX_APP_MCP_SERVER` in
`src/mcp/NodexAppMcpServer.ts`). Claude reports its calls as `mcp__nodex_app__<tool>`, Codex as
server `nodex_app` with the bare tool name, OpenCode as `nodex_app_<tool>` or
`nodex_app-<thread>_<tool>`. The server carries two families. Host Session and content tools
address product Sessions by sessionId. The Runtime's task tools address delegated children by
taskId only; the Runtime conversation that backs a task never appears in tool inputs or results.

| Tool                | Purpose                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `list_agent_models` | Provider instances, models and options a task can run, and what it inherits        |
| `delegate_task`     | Start a child task (`async` by default; `wait` blocks up to `timeoutMs`)           |
| `task_status`       | Read status and result; reading a settled result acknowledges its wake             |
| `task_wait`         | Wait for a task to settle within a bounded budget                                  |
| `task_send`         | Follow up in a task's conversation; after it finished, the follow-up is a new task |
| `task_read`         | Page a task's conversation, or the caller's own when `taskId` is omitted           |
| `task_cancel`       | Stop a task like a user Stop, including the tasks it delegated                     |
| `stop_workflow`     | Stop a Claude workflow the caller's own conversation started                       |

Task tools resolve a taskId to its conversation through the indexed task owner, then reuse the
conversation read, send and acknowledgement logic. Mutations keep stable command identities
derived from `clientRequestId` or the native call, so retries replay durable receipts.
`src/nodex/Instructions.ts` is the guidance every provider receives for these tools.

## Host bridge

The bootstrap frame's `hostTools` supplies the host's MCP tool descriptors and
activates Turn admission; provider credentials never enter the process environment.
Before native execution, `host.request` with operation `turn.prepare` sends the exact project, Thread, Run, attempt, provider session and
native generation to the host. The host replies with `host.result` and optional
trusted instructions. The same callback channel proxies host tool calls and
preserves observed native Turn and MCP request metadata. Responses bypass the
bounded command queue so native execution can await host decisions without
blocking its replies.
`attachments.persist` validates image payloads and retains snapshot source metadata. Stable
content identities and atomic file publication preserve original assets across retries.
Deleting a Thread removes an attachment file only when no live Thread still shows it, including
forks whose captured Run prefix contains the referencing message; an indexed reference table
proves this without reading message bodies.

`storage.snapshot.acquire` drains admitted public writes, rejects new writes, verifies that no
active, queued, native background or unknown work remains, and suspends idle providers. It holds
the database writer transaction while returning an online SQLite copy, attachments directory and
environment identity file. A Profile capture copies that closure and native provider storage
before `storage.snapshot.release`. Snapshot release bypasses the request queue; disconnecting
also releases the fence and removes the temporary database copy.

Before opening SQLite, every runtime holds `<home>/.writer.lock` with a private `owner.json`
containing `{pid,token}`. Offline Profile capture holds the same exclusive directory. Live or
malformed ownership refuses admission; stale recovery requires a proven absent PID and the same
owner token under an exclusive nested `.recovering` claim. Scope release verifies the exact
token, and a PID reused by another process conservatively retains ownership.

All Agents can read and write the current Profile across Projects and Sessions. Plan selects
planning intent and does not restrict content or native execution. Providers use full access and
automatically approve authorization requests; information questions still await a user answer.
Project coordinates determine placement, working directory, list selection and lifecycle.
Ordinary Session creation binds its product identity before the first Run begins.

MCP profiles remain bound to the native incarnation that initialized them. Native call metadata
captures the original Session, Run and attempt, including background work after its parent Turn
ends. Each call revalidates that exact identity. Cancellation and incarnation retirement invalidate
old calls. Independent native notifications and HTTP ingress use a bounded registration barrier,
so a request never borrows a newer foreground Run. Closing an incarnation removes its HTTP
profiles and call registrations. Admission retains at most 4096 profiles and 128 native calls.

Stable command identities and durable transactional receipts replay accepted results across
retries and reconnects. Accepted no-op commands also retain a receipt. Scratch launch retries
read the accepted creation workspace. Rollback selects its original accepted target and shares
the Thread's command lane across native work, preventing a delayed rollback from erasing a newer Run.
Attachment publication preserves existing copies; pending uploads use content-derived identities
and serialize admission through rollback. Context compaction creates one durable maintenance Run
per request and uses the normal native lifecycle and Host preparation boundary.
Claude custom model traits are compiled at the native boundary, including thinking-off effort
limits and permitted context-window suffixes.
Restored Claude history uses the SDK's `SessionStore`: the configured account supplies authentication,
while the SDK privately materializes captured root and subagent transcripts for resume. Continued
entries are durably mirrored into the Profile, including native forks. Missing managed history and
mirror failures reject execution rather than falling back to another history owner. Each native
transcript is admitted whole within 128 MiB and 250,000 entries; larger transcripts fail explicitly.
Restored Codex history uses its captured native home and the current configured provider policy.
The Host obtains current credentials privately for ephemeral login and refresh; execution receipts,
configuration and formal native history captures never persist those credentials.

Codex uses the repository release lock for managed installation and the shared
`@nodex/effect-codex-app-server` schema and RPC exports. The repository
`codex:schemas:generate` and `codex:schemas:verify` commands cover both Desktop and
Agent Runtime consumers; this package has no separate protocol pin or generator.

The package retains provider replay fixtures and lifecycle, transaction, recovery,
delegation and bounded-transport verification. Run focused tests with this package's
`vite.config.ts`. Its strict TypeScript configuration is independent of Electron
and renderer projects.

Source provenance and license notices are recorded in `UPSTREAM.json` and
`LICENSE.t3code`. Bundled distribution must retain those notices.
