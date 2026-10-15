# ADR 0064: Native application MCP

Status: Accepted
Date: 2026-09-08
Partially supersedes: ADR 0061's experimental dynamic content Adapter

## Context

Agents need to operate Sessions and reference the Page or Database View a user has
open. A persisted layout cannot describe transient tabs or the exact submitting
window, and a shell's selected Project does not establish a trusted Agent Turn.

## Decision

Expose application and content tools through the bundled `nodex_app` stdio MCP
server. Agents running in the Agent Runtime reach the same tools, plus the Runtime's
taskId-addressed delegation tools, through a Runtime-served MCP server registered under the
same `nodex_app` name. Its private local connection delegates to Main semantic services. The exact
backend connection generation and canonical tool observations establish invocation
identity; tool arguments and renderer presentation coordinates cannot grant authority.
Core validates Profile and Store identity, execution lifetime and transactional
preconditions. All authenticated Agents can use the current Profile's content.

Native connections acquire a scoped private bridge. Captured native call evidence
identifies the original Session and, when the Provider supplies causal evidence,
its Run. Standard ACP calls retain the actual Session and native incarnation with
an unknown Run left null. A later foreground Run never substitutes for missing
source evidence. Tool arguments cannot select the invocation's identity.

Parent, child and background calls share full Profile access, including in Plan
mode. Ordinary Turn settlement does not invalidate live background work.
Cancellation, native connection retirement and Session deletion invalidate the
corresponding execution claims before replacement work is admitted. Each operation
checks its captured execution identity before execution or receipt replay. Stable
command identities and durable receipts make ordinary retries idempotent. See
[ADR 0068](0068-agent-runtime-execution-authority.md) for execution ownership and
native attribution.

Keep the CLI as the default shell content Interface and share the existing content
contracts and Core owners with MCP. Retire local dynamic execution while preserving
historical transcript rendering. One catalog drives native discovery, capability
reporting and task configuration; unavailable execution endpoints receive no private
connection credentials or application catalog.

The renderer's Window/Scene owner provides bounded live observations and handles
presentation commands. Main retains immutable observation references, not another
persistent Scene. Optional submitted context anchors user references to the latest accepted user submission; explicit refresh selects
a new observation. Missing supplemental context does not block message admission, and later submissions do not rewrite existing observation evidence. An observed tab is an exact occurrence, not a mutable current-tab
alias. Content access remains independent of presentation access.

Page editor synchronization precedes canonical content reads and does not replace
write validators. Database display reads describe bounded occurrences and coverage;
effective queries use captured rules in a new Core read snapshot. Query snapshots,
UI revisions and mutation validators remain distinct contracts.

## Consequences

Agents can act on precise live application context without screen capture. Transport
shutdown and cancellation invalidate scoped application work. Durable mutations retain
domain operation identities and recheck execution lifetime before receipt replay.

Backend and external-service availability remain explicit capability boundaries.
Registering a tool or preserving its transcript does not establish execution support.
The owning [Agent Interface specification](../product-specs/agent-interface-behavior.md)
defines supported operations and their observable outcomes.
