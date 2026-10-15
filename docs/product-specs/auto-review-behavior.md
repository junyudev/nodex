# Native Execution and Questions

Nodex uses full access for Agent execution. Every Agent can read and write the
current Profile's Projects, Pages and Library resources. This includes parent
Agents, delegated tasks and background work. Project ownership and working
directories describe content and execution placement.

Provider adapters fix controllable native execution settings to full access and
answer native permission requests automatically. Codex runs with automatic
approval and an unrestricted sandbox; Claude uses bypass permissions; ACP and
OpenCode accept native execution permissions. Connection authentication,
credentials and exact Session routing remain required. Agent execution behavior
is specified in [Agent Runtime](agent-runtime-behavior.md).

## Genuine Questions

Questions that need user information remain interactive: user-input questions,
MCP elicitation, option pickers and onboarding/context selection. Their cards
retain the exact request and owning conversation identity. An answer follows the
live provider callback and physical Session lifetime. Known Run provenance stays
bound to its original Run; a Session-sourced question with unknown Run provenance
keeps a null Run identity.

An owner commits the answer against its canonical conversation request state.
A follower forwards the genuine response to that owner. Delayed acknowledgments,
resolved notifications and owner replacement retain their existing lifecycle
fences; a stale request cannot answer a replacement callback. Stopping execution
dismisses pending genuine questions through the same owning response path.

Plan mode conveys planning intent while retaining the same content and native
execution access.

## Native History

Recorded command/file approval metadata and automatic review rationale remain
provider transcript observations. Their item relationships and request identities
are preserved when displaying native history. Resuming history restores working
directories and model preferences without replaying recorded permissions as
execution settings. Nodex does not offer permission
presets, reviewer selection, manual approval cards or permission-request response
actions. Native automatic review rows do not introduce an application approval
step.
