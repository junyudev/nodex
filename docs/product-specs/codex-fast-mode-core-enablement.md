# Codex Fast Mode Core Enablement

## Intent

This document is the source of truth for Nodex's core Fast-mode enablement path.
It defines the single persisted service-tier preference, the UI surfaces that control it, and the request-building rules that apply it to new thread and turn requests.

Other product specs should link here instead of restating Fast-mode behavior in detail.

## Scope

This spec covers:

- the global persisted `serviceTier` preference
- the renderer-owned source of truth and shared API
- settings and composer UI surfaces that read and write that preference
- renderer fallback rules when building thread-start and turn-start requests
- main-process forwarding behavior
- queue behavior for follow-up requests
- telemetry and UI normalization from `null` to `standard`

This spec does not cover:

- rollout gating or Statsig-like systems
- slash commands
- announcement, upsell, home, or banner CTAs
- rollout-estimate calculation or metrics IPC
- per-thread Fast-mode state
- provider-specific service-tier availability, pricing, or rollout policy

## Canonical Model

- The global Fast preference is `serviceTier: null | "fast"`.
- Agent execution profiles may additionally hold named tier identifiers advertised by their model
  catalog.
- `null` means Standard/default behavior.
- `"fast"` means requests should send `serviceTier: "fast"`.
- App-server `"default"` and legacy/UI `"standard"` are boundary aliases for domain `null`; neither
  may be persisted as a named tier.
- Fast mode is global, not per-thread and not per-project.

## Source Of Truth

- The canonical owner of the preference is the renderer.
- Persistence lives in renderer `localStorage`, not `.nodex/config.toml` and not main-process config.
- The persisted key is the single Nodex-scoped storage key for the default service tier.
- All reads and writes flow through the shared service-tier settings module and hook.
- UI surfaces must not own parallel local copies of the tier.

## Shared API

- Renderer exposes one reader shape:
  - `serviceTierSettings: { serviceTier: null | "fast"; isLoading: false }`
- Renderer exposes one writer:
  - `setServiceTier(nextTier, source)`
- `source` is attribution for UI/reporting flows such as `settings` or `composer_menu`.
- Invalid persisted values normalize to `null`.
- Browser `storage` events keep the setting synchronized across multiple Nodex windows.

## UI Contract

### Settings

- Settings -> General exposes a `Service tier` row.
- The control offers exactly two choices:
  - `Standard`
  - `Fast`
- Selecting `Standard` writes `null`.
- Selecting `Fast` writes `"fast"`.
- The control reflects the persisted global setting on open.

### Composer Menu

- The thread composer `Add files and more` button opens a real dropdown menu.
- That menu includes a `Speed` flyout submenu.
- The submenu offers exactly two choices:
  - `Standard`
  - `Fast`
- The submenu reads the same shared global setting used by Settings.
- Selecting either option writes through the same shared setter used by Settings.

### Composer Model Selector

- When the global service tier is `fast`, the composer model selector shows a leading lightning-bolt indicator before the active model label.
- The indicator is inline with the label, not a separate badge.
- `standard` omits the indicator entirely.
- Nodex uses an inline leading bolt indicator whose visibility is tied to the active Fast preference.

## Request Resolution Rules

- Request-building code must distinguish between:
  - `serviceTier` omitted
  - `serviceTier: null`
  - `serviceTier: "fast"`
- Resolution order is:
  1. If the request explicitly provides `serviceTier`, use that value.
  2. If the request omits `serviceTier`, fall back to the persisted global default.
  3. If no tier override exists, omit `serviceTier` so the current thread configuration remains in
     force.
  4. If an explicit selection resolves to `null`, send `serviceTier: null`; this resets inherited
     or configured acceleration to Standard.
  5. If the effective value is a named tier, include that tier identifier.
- `null` is treated as an explicit Standard override even when the global default is `"fast"`.

## Covered Request Paths

- New thread first turn
- Normal follow-up turns
- Queued follow-up enqueue
- Edit-last-user-turn replacement turn

Internal helper flows that are not user-facing request starts, such as ephemeral title generation, are outside this core path.

## Queue Behavior

- Queued follow-ups freeze the effective tier at enqueue time.
- That frozen tier is stored on the queued follow-up record.
- When the queue drains later, the stored tier is reused.
- Changing the global setting after a follow-up is queued does not rewrite already-queued entries.

## Main-Process Contract

- Main process forwards an optional `serviceTier` that renderer already resolved.
- Main process does not read the persisted default and does not own fallback resolution.
- For `thread/start` and `turn/start`:
  - forward named tiers when explicitly selected
  - forward `serviceTier: null` when an authoritative execution profile or request explicitly
    selects Standard
  - omit the field only when there is no tier override
- The same forwarding rule applies to replacement turns started by edit-last-user-turn.

## Reporting And Normalization

- Missing, `null`, `"standard"`, or app-server `"default"` service tier is reported as `standard`.
- `"fast"` is reported as `fast`.
- Logs, RPC summaries, and UI reporting should not expose raw `null` as a user-facing tier label.

## User-Visible Behavior

- If the user selects `Fast` in Settings or the composer menu, Nodex persists the global preference as `"fast"`.
- Subsequent new requests inherit and send `serviceTier: "fast"` unless a caller explicitly overrides it.
- If the user selects `Standard`, Nodex persists `null`.
- Subsequent new requests resolve to Standard. Compound execution profiles preserve that explicit
  selection through Main so configured acceleration cannot leak into the new thread.

## Non-Goals And Guardrails

- Fast mode must remain independent from rollout and upsell systems.
- Fast mode must not become per-thread unless a later spec explicitly changes that contract.
- Naming stays explicit:
  - `serviceTier`
  - `standard`
  - `fast`
