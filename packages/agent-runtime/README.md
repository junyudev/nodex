# Agent Runtime

Agent Runtime owns execution Threads, Runs, provider sessions, queued work,
delegated tasks, transcripts, command receipts and execution recovery. It runs
outside Electron Main and writes a dedicated `agent-runtime.sqlite` database
beneath its absolute home. Content and desktop capabilities remain host-owned.

The process starts with `--home <absolute-directory> --cwd <execution-directory>`.
`NODEX_AGENT_RUNTIME_PROVIDER_INSTANCES` carries the provider-instance map; each
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
wire-projected updates, so large tool output is fetched on demand. There is no
public full-transcript snapshot operation.
`thread.read` and `thread.authority` expose control metadata without hydrating history.
Authority includes the Thread's resolved execution directory, branch and workspace path.
`tasks.overview` pages active and completed task metadata independently, starting with four active
and ten completed tasks; prompts, progress and result bodies are never read for this overview.
`execution.observe` emits only Run status and Thread deletion metadata; filtered observers use
type-specific SQL queries and live channels before retaining events. Every subscription returns
its explicit ownership token for scoped cancellation.

The process registers the four provider drivers and execution MCP tools. OpenCode instances
select their native 1.x or 2.x adapter from their executable. ACP's stdio bridge commands use
a separate entry path without acquiring the engine or provider runtimes.
Desktop launch, worktree setup, content authorization and schedules compose
through their host boundaries. The complete production assembly is retained in
`src/orchestration-v2/runtimeLayer.ts`; its execution layer shares the same stores,
workers and request queues with the independent host. Scheduling capabilities are
reported only when a scheduler is supplied.

`NODEX_AGENT_RUNTIME_HOST_TOOLS` supplies the host's MCP tool descriptors and
activates Turn admission. Before native execution, `host.request` with operation
`turn.prepare` sends the exact project, Thread, Run, attempt, provider session and
native generation to the host. The host replies with `host.result` and optional
trusted instructions. The same callback channel proxies host tool calls and
preserves observed native Turn and MCP request metadata. Responses bypass the
bounded command queue so native execution can await host decisions without
blocking its replies.
`attachments.persist` validates image payloads and retains snapshot source metadata. Stable
content identities and atomic file publication preserve original assets across retries.

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

Host tools require the currently admitted foreground attempt. Active native
background work prevents ambiguous session credentials from acquiring a newer
Run's content authority. App-owned delegated children use their own admitted
Turn. The host remains responsible for content authorization and ownership.
MCP profiles remain bound to the native incarnation that initialized them; each tool request
captures its admitted actor before reading the body and revalidates it at execution.

Command receipts bind the complete immutable request. Identical submissions replay their
original result; changed command or user/MCP message content cannot reuse an accepted identity.
Server-owned completion mailboxes retain their intentional undelivered-message updates.
Claude custom model traits are compiled at the native boundary, including thinking-off effort
limits and permitted context-window suffixes.

The package retains provider replay fixtures and lifecycle, transaction, recovery,
delegation and bounded-transport verification. Run focused tests with this package's
`vite.config.ts`. Its strict TypeScript configuration is independent of Electron
and renderer projects.

Source provenance and license notices are recorded in `UPSTREAM.json` and
`LICENSE.t3code`. Bundled distribution must retain those notices.
