# ADR 0074: Content access and native execution permissions are separate

- Status: Accepted
- Date: 2026-11-01
- Owners: Nodex maintainers
- Refines: Profile access in [ADR 0068](0068-agent-runtime-execution-authority.md)
- Supersedes: the fixed full-access native execution policy in [ADR 0068](0068-agent-runtime-execution-authority.md), [ADR 0065](0065-native-claude-code-backend.md), [ADR 0055](0055-acp-session-runtime-boundary.md) and [ADR 0071](0071-configured-acp-agents-and-explicit-management.md)

## Context

ADR 0068 removed per-resource grants so that every Agent can read and write every Project, Page
and Session in a Profile without a consent model. The same decision also fixed every native
provider to full execution access with automatic approval. Those are different authorities.
Content access is mediated by Nodex tools that already prove the caller's identity and keep
mutation safety. Native execution is the provider process acting on the computer: shell
commands, file changes and network access, which Nodex cannot review after the fact.

Running every Agent, including delegated and background work, with unrestricted native access
left no way to supervise an unfamiliar task or contain content an Agent reads.

## Decision

Content access stays Profile-wide for every Agent and no execution setting narrows it. The
Session's own Nodex tools never ask for approval.

Native execution access is a per-Session permission mode: Ask for approval, Approve for me or
Full access, ordered from narrowest to broadest. The Runtime Thread owns the mode with its model
selection and interaction mode; Core keeps no second copy. A Profile setting supplies the mode for
new Sessions, and explicit launch input wins. Plan remains an independent interaction axis.

Each provider adapter maps the mode to native enforcement: a sandbox, a native permission mode
or native permission rules. A provider offers only the modes it enforces. Unsupported modes run
as the broadest supported narrower mode without rewriting the chosen mode. A mode change applies
from the next turn and never interrupts running work.

Native permission requests become durable runtime requests with a waiting execution node and an
approval item. The person answers them with the same command, receipt and effect path as
information questions; delivery targets the exact live provider session that asked. Stop,
process loss, restart and provider turn completion close pending approvals, and replacement
execution never inherits them.

Every caller carries its own mode as an execution ceiling. Delegation, Agent-started Sessions,
messages, steering and controls inherit or narrow it and are rechecked under the command lock.
Agents cannot answer execution approvals.

Sessionless utilities run read-only without prompts because no person owns their requests.

## Consequences

- Approval attention is a first-class waiting state across the sidebar, Page activity, Inbox,
  delegated tasks and notifications.
- Mode-specific provider behavior lives at the adapter boundary; orchestration remains
  provider-neutral.
- Existing Sessions keep their stored mode. Native Codex conversations outside the Runtime keep
  their fixed policy and do not offer a permission control.

Behavior is specified in [Agent Permissions and Approvals](../product-specs/agent-permissions-behavior.md).
