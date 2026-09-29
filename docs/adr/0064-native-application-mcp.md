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
server. Its private local connection delegates to Main semantic services. The exact
backend connection generation and canonical tool observations establish invocation
identity; tool arguments and renderer presentation coordinates cannot grant authority.
Core continues to validate frozen Turn policy and resource access for each operation.

Claude Code connections acquire their own scoped private bridge. Main freezes the
exact accepted foreground Turn from current Core Thread and Project authority;
the bridge issues invocation claims from that record rather than accepting Thread,
Turn or Agent coordinates from stdio requests. Settlement, admission failure,
connection replacement and shutdown revoke those claims. Every operation verifies
the current native identity, profile and execution location, then rereads the exact
persisted authority before executing or replaying a receipt. A new input cannot reuse
an already accepted Turn identity; operation retries return their original admission.

A shared stdio connection cannot reliably distinguish a foreground Claude caller
from a native background Agent or watcher. While any such task is live, all Claude
application-tool claims are suspended, including foreground calls. Clearing the
roster permits new claims only for a still-active foreground Turn; older claims
remain invalid. Native background application tools stay unavailable until the
transport establishes trusted actor correlation for every invocation.

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
shutdown and Turn retirement cancel scoped application work. Durable mutations retain
domain operation identities and recheck authorization before receipt replay.

Backend and external-service availability remain explicit capability boundaries.
Registering a tool or preserving its transcript does not establish execution support.
The owning [Agent Interface specification](../product-specs/agent-interface-behavior.md)
defines supported operations and their observable outcomes.
