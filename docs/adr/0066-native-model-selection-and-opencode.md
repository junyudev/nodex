# ADR 0066: Model selections retain their native runtime owner

- Status: Accepted
- Date: 2026-10-03
- Owners: Nodex maintainers
- Refines: [ADR 0056](0056-native-codex-and-capability-negotiated-agent-backends.md), [ADR 0065](0065-native-claude-code-backend.md)

Users need to choose configured models without first understanding which Agent executes them.
A Model Selection therefore carries the complete runtime instance, exact model identifier, native
options and mode. Discovery resolves the current Core execution location; selecting the same model
name from two instances remains two distinct choices. An attached Thread retains its runtime owner.

OpenCode is a native backend through its installed executable and pinned HTTP/SSE SDK. OpenCode owns
providers, authentication, native agents, tool execution and transcript history; Nodex owns the
durable binding, requested options and bounded turn observations. This preserves native provider
semantics without introducing a second provider configuration authority or translating another
runtime through Codex. Claude keeps its official SDK and ACP keeps its negotiated capabilities.

Each local OpenCode chat owns a scoped server because native MCP configuration applies to an
execution directory while Nodex application authority belongs to an exact chat and foreground turn.
An instance profile isolates native configuration, authentication and history together. External
servers retain their own process and receive no Nodex application-tool connection. Discovery creates
no conversation, and recovery requires the exact saved native owner and session instead of silently
creating a replacement.

The capability and recovery contracts belong to
[Agent Backend Behavior](../product-specs/agent-backend-behavior.md).
