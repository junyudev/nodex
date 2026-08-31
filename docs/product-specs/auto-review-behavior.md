# Auto-review Behavior

## Intent

This document is the source of truth for Auto-review behavior in Nodex.
It defines the config-backed permission model, visible preset semantics, approval request lifecycle, and required transport literals.

Other product specs should link here instead of restating Auto-review behavior in detail.

## Scope

This spec covers:

- preset resolution from Codex app-server config and config requirements
- Auto-review availability behavior and reviewer fallback
- visible Thread-stage and Settings UI for permission modes
- raw config editing rules for permission-related keys
- approval request attachment, forwarding, and resolution
- transcript effects that are specific to Auto-review

This spec does not cover:

- general thread transcript rendering outside approval-specific rows
- worktree creation, account/auth, or model selection
- backend automatic-review implementation beyond the confirmed frontend contract

## Canonical Model

- Auto-review is a permissions feature, not a cosmetic UI label.
- Permission state is main-owned and config-backed.
- Renderer does not keep a per-project localStorage source of truth for permission mode.
- The main process resolves permission state from:
  - `config/read`
  - `configRequirements/read`
- The resolved permission state is exposed to renderer as one canonical `CodexPermissionState`.
- New thread start, turn start, queued follow-ups, and thread resume all inherit their effective permission fields from that resolved state.

## Internal Presets

The resolver understands these internal preset ids:

- `read-only`
- `auto`
- `guardian-approvals`
- `full-access`

The normal visible picker exposes these visible modes:

- `auto`
- `guardian-approvals`
- `full-access`
- `custom`

`read-only` remains an internal fallback preset for requirements-constrained environments and is not part of the normal footer picker.

## Exact Preset Semantics

- `auto`
  - `sandbox_mode=workspace-write`
  - `approval_policy=on-request`
  - `approvals_reviewer=user`
- `guardian-approvals`
  - `sandbox_mode=workspace-write`
  - `approval_policy=on-request`
  - `approvals_reviewer=auto_review`
- `full-access`
  - `sandbox_mode=danger-full-access`
  - `approval_policy=never`
  - `approvals_reviewer=user`
- `read-only`
  - `sandbox_mode=read-only`
  - `approval_policy=on-request`
  - `approvals_reviewer=user`

The only behavioral difference between `auto` and `guardian-approvals` is the reviewer.
They intentionally share the same sandbox and approval policy.

## Fresh Profile Default

- When a permission scope has no persisted Nodex selection and no explicit permission choice from a non-default config layer, Nodex defaults to `guardian-approvals` when Auto-review is available.
- An explicit config choice or persisted Nodex selection remains authoritative; the fresh default never rewrites it.
- When requirements or the feature gate make Auto-review unavailable, the resolver keeps the nearest allowed non-Auto-review mode instead.
- This is a resolved product default, not an eager `config.toml` write. Choosing a mode in the UI continues to use the normal config and persistence transaction.

## Required Literals

These exact literals must exist in the implementation:

- `guardian_approval`
- `approvals_reviewer`
- `auto_review`
- `guardian_subagent`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `thread-follower-command-approval-decision`
- `thread-follower-file-approval-decision`
- `automatic-approval-review`

## Auto-review Gate

- `features.guardian_approval` may arrive as either `features.guardian_approval`, `features["guardian_approval"]`, or `configRequirements/read.featureRequirements.guardian_approval`.
- Only an explicit `guardian_approval=false` disables Auto-review. A missing value means the app should fall back to requirement-based availability, not treat Auto-review as unavailable.
- If `guardian_approval` is explicitly disabled, automatic reviewers collapse back to `user`.
- When Auto-review is unavailable:
  - Auto-review is not offered as an available preset.
  - Any raw config that still says `approvals_reviewer=auto_review` or the legacy alias `approvals_reviewer=guardian_subagent` is normalized to `user` in the effective permission state.
  - Fallback preset selection prefers the nearest allowed non-Auto-review preset.

`configRequirements/read` reviewer allow-lists are also authoritative. `auto_review` and the legacy alias `guardian_subagent` both mean the automatic reviewer for allow-list purposes. If `allowedApprovalsReviewers` omits both automatic-review literals, Auto-review must not be offered even when `guardian_approval` is enabled or absent.

This fallback is behavioral, not cosmetic.
The resolver must not surface an effective Auto-review reviewer when the gate is off.

## Requirements Filtering

- Available presets are filtered by `configRequirements/read`.
- Permission profile allow-lists constrain fixed presets:
  - `auto` and `guardian-approvals` require `:workspace`
  - `full-access` requires `:danger-full-access`
  - `read-only` requires `:read-only`
- Allowed approval policies constrain which presets are valid.
- Allowed sandbox modes constrain which presets are valid.
- Allowed approval reviewers constrain which presets are valid, with `auto_review` and `guardian_subagent` treated as the same automatic-review capability.
- If the active raw config has explicit permission keys (`approval_policy` or `sandbox_mode`) and that raw config is representable and allowed, the UI must surface `custom` as an available visible mode even when the same values fold to a fixed preset.
- If the current raw config is representable and allowed, the resolver prefers the matching preset over a fallback for the current effective mode; `custom` availability is independent of that preset folding.
- If no explicit config matches, the resolver chooses the nearest allowed fallback preset.

Preferred fallback order is:

- when Auto-review is enabled: `auto` -> `guardian-approvals` -> `full-access` -> `read-only`
- when Auto-review is disabled: `auto` -> `full-access` -> `read-only`

This fallback order resolves invalid or constrained raw app-server configuration. It is separate from the fresh-Profile selection default above.

## Custom Escape Hatch

- `custom` is a visible mode, not an internal preset.
- It exists for raw config states that are explicit and representable enough to describe.
- `custom` must remain visible when the current raw config is outside the fixed preset set, and must also remain available when an explicit config.toml permission state happens to be equivalent to a fixed preset.
- Switching away from `custom` writes a fixed preset back through the config APIs.
- Staying on `custom` does not invent a synthetic preset behind the scenes.

The composer description for `custom` is the stable summary `Uses permissions defined in config.toml`. Raw config source, path, `sandbox_mode`, `approval_policy`, and `approvals_reviewer` details belong to the dedicated Settings config surface and never size or crowd the composer menu.

## Config Keys

Permission resolution depends on these raw config keys:

- `approval_policy`
- `sandbox_mode`
- `approvals_reviewer`
- `sandbox_workspace_write.network_access`
- `features.guardian_approval`
- `features.guardian_approval` as a flat key
- `configRequirements/read.featureRequirements.guardian_approval`

## Write Behavior

- Reads use app-server config APIs, not manual TOML parsing as the source of truth.
- Writes use app-server config write APIs, not renderer-local persistence.
- The writable target is the current key-origin layer when present.
- If there is no existing origin for the key, Nodex writes to the user config file.
- The thread footer must not silently create a project config override just because the user changed the mode there.

## Effective State Shape

The resolved permission state should carry:

- selected visible `mode`
- effective internal preset
- available visible modes
- effective `approvalPolicy`
- effective `approvalsReviewer`
- effective `sandboxMode`
- effective `sandbox`
- whether Auto-review is available
- the writable config target
- the `custom` description when relevant

Thread summaries/snapshots should also carry the effective permission fields needed to preserve behavior across resume and projection:

- `approvalPolicy`
- `sandbox`
- `approvalsReviewer`

## UI Surfaces

Auto-review is split across multiple surfaces.

### Thread Footer Picker

The Thread-stage permission dropdown must use these exact visible labels:

- `Ask for approval`
- `Approve for me`
- `Full access`
- `Custom (config.toml)`

Dropdown copy:

- Title row: `How should Nodex actions be approved?`
- Learn-more affordance: `Learn more`
- `Ask for approval`: `Always ask to edit external files and use the internet`
- `Approve for me`: `Only ask for actions detected as potentially unsafe`
- `Approve for me` disabled tooltip: `Requires default sandboxed permissions in this workspace`
- `Full access`: `Unrestricted access to the internet and any file on your computer`
- `Full access` disabled tooltip: `Disabled by requirements.toml`
- `Custom (config.toml)`: `Uses permissions defined in config.toml`

Fixed modes remain visible when requirements disable them, retain their ordinary explanatory subtext, and expose the disabled reason from a focusable tooltip. `Custom (config.toml)` appears only when Custom is available or is the current resolved mode.

The composer trigger uses the accessible label and tooltip `Change permissions`, omits a redundant dropdown chevron, and accents only `Full access` with the warning foreground token. Other modes inherit the standard ghost-button color.

Selecting `Full access` closes the menu and opens a renderer-window-owned confirmation before writing the preset. The confirmation explains unrestricted file, terminal, internet, and connected-app access; Cancel leaves the mode unchanged, while Confirm applies `full-access`. The dialog remains mounted if the originating composer or Settings row unmounts.

### Settings -> Agent

The settings shell exposes a dedicated `Agent` section.

It uses this split:

- `Permissions modes`
  - `Default permissions mode`
- `Custom config.toml settings`
  - `Approval policy`
  - `Sandbox settings`
  - `Allow network access`
  - `config.toml`

These settings are config-backed views into the same resolved permission state, not a second preference model.

## Start/Resume Propagation

The resolved permission state must be applied consistently in all main-owned thread lifecycle paths:

- `thread/start`
- initial `turn/start`
- later `turn/start`
- `thread/resume`
- queued follow-ups / send-now
- main-owned fallback or prewarm start-turn helper paths

All of those paths must carry the same effective:

- `approvalPolicy`
- `sandbox`
- `approvalsReviewer`

## Approval Request Attachment

- Approval requests remain part of the canonical conversation request plane.
- They do not open a standalone approval screen.
- Command approvals attach to existing exec rows.
- File approvals attach to existing patch/file-change rows.
- Automatic approval review rows are transcript items, not separate settings or approval pages.

This attachment behavior is required for the item-attached transcript model.

## Request Types

The relevant request ingress literals are:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

Renderer and main-process request handling must treat these as item-attached requests tied to the originating transcript row.

## Automatic Approval Review Rows

- Automatic approval review uses the canonical synthetic id form:
  - `automatic-approval-review:{targetItemId}`
- The item type literal is:
  - `automatic-approval-review`
- These rows render after the main assistant/tool activity lane as trailing approval-specific transcript rows.
- Compatibility shims may still accept older camelCase incoming item types, but the canonical literal remains hyphenated.

## Approval Decision Flow

There are two distinct decision paths.

### Owner Thread

- The owner-thread path resolves pending approval requests locally in the main conversation manager.
- Request cleanup and transcript updates happen against the canonical owner conversation state.

### Follower Thread

- Follower/child-thread forwarding matters.
- Follower decisions must not reuse only the owner-thread local-resolve path.
- When the stream role is follower, Nodex forwards the decision using these exact methods:
  - `thread-follower-command-approval-decision`
  - `thread-follower-file-approval-decision`

Payloads should include the conversation/thread identity, request identity, and decision.

## Child and Background Approval Behavior

- Background child approval cards remain part of the composer shell ordering.
- Their transport must still be follower-aware when the request belongs to a follower conversation.
- Child approvals are not owner-only special cases.
- The first background child approval renders before the active-thread request card when both are present.

## Auto-Accept Behavior

- Automatic acceptance is allowed only when the effective preset is `full-access`.
- `auto` and `guardian-approvals` still require approval handling because both use `approval_policy=on-request`.
- Auto-review changes who reviews an elevated action, not whether approval is bypassed.

## Non-Goals

- Nodex does not implement a local automatic-review adjudicator.
- Nodex forwards `approvalsReviewer=auto_review` as the current app-server contract.
- Nodex accepts `guardian_subagent` only as a legacy/internal alias when reading config or requirements; it does not write that literal back to config.
- Backend automatic-review internals beyond that forwarding behavior remain inferred and should not be over-claimed.
