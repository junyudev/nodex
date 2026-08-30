# NFM Editor Agent Config Behavior

Status: Active
Last Updated: 2026-09-04

This document is the source of truth for the editable NFM `<agent-config />` inline atom and the execution settings it applies when its prompt starts.

## Product surface

The inline chip and its popover are always named `Agent config`. The chip uses the monochrome Nodex mark; only Mode and Model appear in its compact secondary summary, while the tooltip and popover retain the complete explicit configuration.

The popover has exactly three controls:

1. `Mode`: Inherit, Default, or Plan.
2. `Model`: the same Model, Effort, and Speed selector used by the Composer.
3. `Permissions`: the same permission selector used by the Composer.

Native Codex currently has one runtime-owned provider, so the Model menu omits a redundant Provider row. The document still preserves `provider="openai"` as a stable, portable identifier whenever the user makes an explicit intelligence selection. ACP is a separate task backend binding, not a provider choice inside this Codex selector.

Environment, Harness, Personality, Tools, named permission profiles, credentials, and raw configuration are not edited here. `Reset` clears every explicit Agent config value and returns the atom to inheritance.

## NFM contract

Agent config is a self-closing inline atom:

```text
<agent-config mode="plan" provider="openai" model="gpt-5.6-sol" reasoning="high" speed="fast" permission="auto" />
```

Canonical attributes serialize in this order:

```text
mode, provider, model, reasoning, speed, permission
```

Only non-empty attributes serialize. Stable Provider and Model identifiers are document data; display labels, backend bindings, credential state, and secrets are not. `speed` is the product term for the runtime service tier. `speed="standard"` records an explicit Standard choice; an omitted speed inherits.

Omitted fields inherit from the target task or new-task defaults. A Model without a Provider resolves against native Codex, and the only accepted explicit Provider is `openai`. An empty `<agent-config />` is valid and expresses complete inheritance.

Unknown, malformed, unavailable, or unsupported explicit values remain visible for correction and fail closed at send time. They are never silently replaced with another Provider, Model, Effort, Speed, Mode, or permission.

When multiple Agent config atoms occur in one prompt, the last non-empty explicit value for each field wins. An omitted field never clears an earlier explicit field.

## Prompt compilation

Agent config is application-owned execution metadata. Prompt compilation removes the atom from model-visible text and carries the structured fields in the prompt sidecar. Structured prompt input is authoritative; a raw prompt recognizes Agent config only when the atom occupies its own line.

Any prompt containing an Agent config atom starts a normal next Turn. It is never steered into an already running Turn because `turn/steer` cannot carry execution overrides. If the task is active, Nodex queues the complete prompt sidecar or asks the user to wait.

## Runtime resolution

Main validates every explicit value against the same app-server model catalog used by Composer and against the current permission state before transport.

For a new native Codex task, Agent config is resolved before task or managed-worktree creation. The resolved Model, Effort, Speed, Mode, and permission are frozen for a pending worktree and used by both `thread/start` and its first Turn. A failed preflight creates no task or worktree.

Agent config preparation preserves the admitted first submission's `launchId` and `clientUserMessageId` through immediate and pending-worktree launches. Consuming the configuration sidecar never creates a second submission identity or bypasses the normal paginated-history and first-message presentation contracts.

For an existing native Codex task, Model, Effort, and Speed changes use one compound settings transaction before the Turn starts, matching Composer's settings ownership. Unsupported providers, catalog values, or backend changes fail before the Turn request. A task's native Codex or ACP backend binding never changes implicitly.

Explicit Agent config fields take precedence over caller overrides, current task settings, and application defaults. Inherited fields preserve that existing precedence.

## Permission safety

Selecting a permission in Agent config changes only the document atom; it does not change the Project's default permission mode.

Document content is never an authorization token. `permission="full-access"` is accepted only when the target Project already has verified Full access through the normal Composer or Permissions confirmation flow. Otherwise Main rejects the prompt before any task or Turn transport. Other permission modes must also be currently available; Approve for me requires Auto-review availability.

Authentication remains runtime-owned. Credentials never enter NFM, prompt sidecars, pending-worktree payloads, logs, stories, or screenshots.
