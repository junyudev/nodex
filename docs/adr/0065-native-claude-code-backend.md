# ADR 0065: Claude Code owns its native execution and configuration

- Status: Accepted
- Date: 2026-09-29
- Owners: Nodex maintainers
- Refines: [ADR 0056](0056-native-codex-and-capability-negotiated-agent-backends.md)

## Context

Claude Code has its own authentication, instructions, skills, hooks, MCP servers, tool permissions,
and persisted conversations. Nodex needs to preserve those semantics when a user selects Claude Code.
An ACP definition remains useful for independently implemented agents, but cannot be the authority
for native Claude session behavior.

## Decision

`claude` is an explicit backend family alongside `codex` and `acp`. Core owns the durable instance
binding and native session identity. Main owns a scoped Claude session manager; its Node Adapter
uses the official Claude Agent SDK to launch the configured installed Claude Code executable.
SDK types and process behavior stay behind that Adapter and the native message projection. Shared
conversation contracts and renderer owners contain only transport-neutral presentation and control
shapes. A conversation runtime Interface adapts each backend's reads, subscriptions and lifecycle
into one product presentation. The same connected stage, rich composer, timeline, model menu and
request cards serve every backend. Backend differences select capabilities and semantic commands;
they never select a separate conversation page. Native sessions do not manufacture Codex wire
items or acquire a Codex document writer. Codex's protocol ownership remains unchanged.

Claude Code reads user, project, and local configuration and owns tool execution. Nodex does not
copy credentials, redirect HOME, replace its tools with ACP callbacks, or reinterpret its configuration.
An optional config directory selects a native account environment. Explicit instance environment
variables overlay the Desktop environment at connection creation. Main encrypts user-supplied secrets
outside ordinary settings and exposes redacted settings reads; existing native credentials remain
with Claude Code. History reads use a separate
worker environment so two account configurations cannot race over Main's process environment.

SDK permission callbacks become scoped pending requests. Responses must name a live request in
that exact Thread; questions require answers, and closing or stopping denies outstanding requests.
Existing Claude permission rules and hooks remain native policy. Project approval preferences govern
callbacks that reach Nodex. Native tools do not acquire Nodex's Codex-only application or desktop
capabilities merely by sharing a tool name.

## Consequences

Users can select Claude Code, change its advertised model, use Code or Plan mode, invoke commands
and skills, answer questions, approve tools, observe subtasks, stop a turn, and resume the exact
native conversation after a Nodex restart. Native history is projected as a bounded recent transcript
without replaying prior prompts. Missing sessions and process failures are explicit errors.

The installed executable and inherited configuration are user-managed trusted code. Nodex does not
attest their bytes or promise protocol compatibility with every historical executable. Claude tasks
currently require a local Project; importing an existing CLI session catalog, remote execution,
image/audio attachments, and Codex-specific controls are separate features.

See [Agent Backend Behavior](../product-specs/agent-backend-behavior.md) for the product contract.
