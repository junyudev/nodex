# Page Editor Agent Config Behavior

Status: Active
Last Updated: 2026-10-14

This document is the source of truth for the editable Page editor `:agent-config{}` inline atom and the execution settings it applies when its prompt starts.

## Product surface

The inline chip and its popover are always named `Agent config`. The chip uses the monochrome Nodex mark; only Mode and Model appear in its compact secondary summary, while the tooltip and popover retain the complete explicit configuration.

The popover has two controls:

1. `Mode`: Inherit, Default, or Plan.
2. `Model`: the same Model, Effort, and Speed selector used by the Composer.

Native Codex currently has one runtime-owned provider, so the Model menu omits a redundant Provider row. The document still preserves `provider="openai"` as a stable, portable identifier whenever the user makes an explicit intelligence selection. ACP is a separate task backend binding, not a provider choice inside this Codex selector.

Environment, Harness, Personality, Tools, credentials, and raw configuration are not edited here. `Reset` clears every explicit Agent config value and returns the atom to inheritance.

## Nodex Markdown contract

Agent config is an inline directive:

```text
:agent-config{mode="plan" provider="openai" model="gpt-5.6-sol" reasoning="high" speed="fast"}
```

Canonical attributes serialize in this order:

```text
mode, provider, model, reasoning, speed
```

Only non-empty attributes serialize. Stable Provider and Model identifiers are document data; display labels, backend bindings, credential state, and secrets are not. `speed` is the product term for the runtime service tier. `speed="standard"` records an explicit Standard choice; an omitted speed inherits.

Omitted fields inherit from the target task or new-task defaults. A Model without a Provider resolves against native Codex, and the only accepted explicit Provider is `openai`. An empty `:agent-config{}` is valid and expresses complete inheritance.

Unknown, malformed, unavailable, or unsupported explicit values remain visible for correction and fail closed at send time. They are never silently replaced with another Provider, Model, Effort, Speed, or Mode.

When multiple Agent config atoms occur in one prompt, the last non-empty explicit value for each field wins. An omitted field never clears an earlier explicit field.

## Prompt compilation

Agent config is application-owned execution metadata. Prompt compilation removes the atom from model-visible text and carries the structured fields in the prompt sidecar. Structured prompt input is authoritative; a raw prompt recognizes Agent config only when the atom occupies its own line.

Any prompt containing an Agent config atom starts a normal next Turn. It is never steered into an already running Turn. If the Session is active, Nodex queues the resolved Model, Effort, Speed, and planning intent with that message; later Composer changes cannot replace them.

## Runtime resolution

Main validates every explicit value against the current Agent Runtime provider catalog used by Composer. Agent config is supported only for native Codex; it never changes a Session's Agent connection implicitly.

For a new native Codex Session, Agent config is resolved before execution metadata, Session binding, or managed-worktree creation. One canonical launch captures the resolved Model, Effort, Speed, and Mode for the execution Thread and its first Run. A failed preflight creates no execution or worktree.

Agent config preparation preserves the admitted first submission's `launchId` and `clientUserMessageId` through immediate and pending-worktree launches. Consuming the configuration sidecar never creates a second submission identity or bypasses the normal paginated-history and first-message presentation contracts.

For an existing native Codex Session, one message command captures its resolved intelligence and planning choices. The Runtime applies them when that Run starts. Editing a queued message updates its text and captured preferences in the same command; a config-bearing queued Run cannot be promoted into steering. Unsupported providers, catalog values, and Agent connection changes fail before message admission. These operations read bounded catalog and Thread metadata without hydrating transcript history.

Explicit Agent config fields take precedence over caller overrides, current task settings, and application defaults. Inherited fields preserve that existing precedence.

## Execution identity

Agent config selects planning and intelligence settings. It carries no content
permissions: authenticated calls can use all content in the current Profile's
Library. Plan mode changes how work is planned, while execution identity and
cancellation continue to follow the calling Session and native connection.

Authentication remains runtime-owned. Credentials never enter Nodex Markdown, prompt sidecars, pending-worktree payloads, logs, test fixtures, or screenshots.
