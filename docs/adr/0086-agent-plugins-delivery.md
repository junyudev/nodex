# ADR 0086: Nodex owns Agent Plugin installation and delivery

- Status: Superseded by [ADR 0087](0087-codex-installs-plugins-nodex-extends-them.md)
- Date: 2026-11-13
- Owners: Nodex maintainers

## Context

A person should be able to install one Plugin package and use its skills and tools
in the supported Agents for a Project. The installation also needs to support
future MCP App views that a person can open without an Agent Session. Native
backend installations have their own configuration, discovery, and process
lifetimes, so they cannot supply this shared authority.

## Decision

### Packages and activation

Nodex is a client of the open [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification).
It reads the portable layout with a root `plugin.json`, optional `skills/` and
`mcp.json`, the Codex compatibility layout with `.codex-plugin/plugin.json`,
and the Claude-style layout with `.claude-plugin/plugin.json` for skills and
MCP servers only. Portable readers are version-specific and reject unsupported
manifest schema versions. Invalid components are diagnosed at their own boundary.
Nodex-specific extensions use `app.jyu.nodex`, the application bundle identifier.
Unrecognized extension namespaces are inert.

The Host owns Plugin installations in a host-local registry in the Profile.
Source paths, approved package digests, and credentials are facts about the
machine that runs the plugin. Core remains the authority for shared product
records and keeps no mirror of those install facts. The Host publishes a
reviewed package copy and records Plugin activation explicitly per Project.
Any future shared activation policy can live in Core while the Host retains
installation and execution authority. Codex-home plugins retain native ownership.

### MCP server supervision

The Host supervises each installed plugin MCP server through a broker. The broker
owns local process launch or remote connections, credentials, and shutdown. It
can share an upstream where the installation revision, server, Project scope,
and credential principal permit it. Each Agent Session or MCP App view gets
its own authenticated, revocable lease for each Plugin server. The first
authenticated HTTP connection binds the bearer. Codex uses multiple sockets
during one MCP session. For Codex, the broker issues an MCP session ID to the
first bearer holder and requires both credentials on later requests. A lease
expires after eight hours by default, with a maximum lifetime configurable at
issuance. The broker derives access
from the verified caller and current Plugin activation. Disabling or uninstalling
revokes affected leases before runtime cleanup, so a cached tool list cannot
authorize a new call. An MCP App view can use this authority without an Agent Session.

For Agent delivery, calls already dispatched may finish after revocation. New calls
fail, and results from in-flight calls are withheld from the revoked Session.

### Codex delivery

The Agent Runtime keys the app-server by Project and Codex provider instance
when a Project has enabled Nodex Plugins. The Host projects only the current
approved skill directories outside the Codex home. The adapter selects the
projection with `thread/start.selectedCapabilityRoots`. Codex **0.167.2**
requires `capabilities.experimentalApi` at initialization for this field.
Cold resume and ordinary fork have no corresponding field, so they register
the current projection through `skills/extraRoots/set` in the Project process.
The adapter sends broker URLs and authorization headers through per-thread
`mcp_servers.<key>` config on start, cold resume, and ordinary fork. Codex
applies the Session's native MCP approval policy before dispatch. See the
[Codex app-server protocol](https://developers.openai.com/codex/app-server.md#experimental-api-opt-in).

Codex can persist and inherit selected roots. On Plugin withdrawal or generation
replacement, the Host removes the obsolete projection and revokes its leases.
The Runtime marks the Project process stale, drains in-flight work, and recycles
it when idle. Removing the root is necessary because the saved selection survives
recycling. Resume and native fork verify that inherited Plugin capabilities
belong to the current Project. Every Codex upgrade must rerun the delivery proof,
including discovery, supporting-file access, Project isolation, start/resume/fork,
and revocation in previously loaded and cold threads.

### Claude Code delivery

The Host builds a Project-scoped local Claude plugin for each enabled installation
with skills. Each SDK query gets immutable roots at the current generations.
The manifest name derives from the installation identity and qualifies each
skill's slash name. The projection copies the approved skill text and supporting
files and emits only descriptive and invocation frontmatter. Package hooks,
skill hooks, tool pre-approvals, commands, agents, and native MCP declarations
stay outside Claude's projected capabilities.

The adapter registers one lease per enabled server for each query through the
SDK's `setMcpServers` control channel. The Host scopes each lease to the Project
and verified Session, and Claude applies its normal per-Session tool permission
policy. Closing the query releases its leases and projection. Before the next
prompt after an activation or generation change, the adapter releases the old
query's leases and resumes the native conversation in a fresh query with the
current set.
See the [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript).

### Duplicate native installations

The Nodex copy takes precedence inside Nodex threads. Nodex disables the native
copy for that thread when the backend can do so safely. Claude Code applies the
marketplace entry's `enabledPlugins` override in the SDK query settings. The
override is scoped to the query and respects managed policy. If suppression
cannot be established, Nodex shows the conflict before opening the query.

### Deferred contributions

Nodex reads supported hook declarations for review. Hook execution is deferred
until it has a reviewed execution policy and backend-specific lifecycle semantics.
OpenAI-hosted app mappings describe dependencies on OpenAI services. MCP App
entry point launches use the broker and are a later capability.

## Consequences

- One installation can serve multiple Projects and Agent backends. Changes to
  activation affect only the selected Project.
- The Host owns cleanup of server processes, leases, and temporary skill
  projections. A Codex app-server recycle can affect other threads in its Project.
- Revocation controls plugin discovery and live tool access. Conversation history
  can retain earlier skill text and tool results. Filesystem access still follows
  native execution permissions.
- The Codex 0.166.0 and Claude Agent SDK 0.3.322 probes demonstrate specific
  skill discovery, MCP attachment, and lifecycle behaviors. The 0.167.2 schema
  establishes the Codex field and its gate. Full broker integration, revocation
  across running Nodex Sessions, and Agent Plugins and MCP Apps conformance
  require separate verification.

## Related decisions

- [ADR 0064](0064-native-application-mcp.md) supplies the native MCP attachment
  pattern and caller identity boundary. Plugin server leases carry their own
  Project scope. The `nodex_app` application tools retain Profile-wide access.
- [ADR 0068](0068-agent-runtime-execution-authority.md) keeps Session execution,
  provider bindings, and history in the Agent Runtime. The Host supplies the
  current activation and broker leases to that execution owner.
- [ADR 0074](0074-content-access-and-native-execution-permissions.md) retains
  per-Session native permissions and approval behavior. Plugin activation
  authorizes delivery within a Project and leaves those permissions in force.
- [ADR 0048](0048-effect-main-application-kernel.md) governs scoped Host resource
  lifetimes in Main. Plugin supervision and leases join that graph, while the
  Agent Runtime owns the provider connections under ADR 0068.
- [ADR 0082](0082-automations-replace-scheduled-tasks.md) remains the authority
  for any future Automation created from a plugin template, including its
  Owner and mode.

These decisions retain their existing authority. The
[Plugins behavior specification](../product-specs/plugins-behavior.md)
defines the release scope.
