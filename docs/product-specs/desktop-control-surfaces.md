# Desktop control surfaces

Nodex presents Browser Use, control of supported browser profiles, and Computer Use through one native desktop-control system. The task transcript remains the durable record; live screenshots, remote layers, native placement, and cursor state are bounded ephemeral projections owned by the Main process.

## Availability

The built-in Browser is available when its verified runtime is ready. Control of an existing browser profile additionally requires a supported browser family, the installed native host, and a connected allowed extension instance. Browser Settings reports the live provider state as checking, unavailable, needs repair, waiting for extension, or ready. Agents can select the existing-browser backend only in the ready state.

Computer Use is available only when its verified helper and operating-system requirements are ready. A failure in one control backend does not weaken or implicitly enable another. ACP tasks and remote Codex executions do not acquire local desktop-control surfaces.

## Native picture in picture

An admitted local task becomes active when Browser Use has an open session or Computer Use has an active item. A task can have both sources; ending one source does not hide the other. Browser presentations retain only the bounded latest accepted raster for each open presentation. Computer Use remains a native remote layer and is not copied into renderer history.

The native stack attaches to the focused eligible Nodex window, then the most recently eligible window, or the only eligible window. It follows native window movement without renderer animation frames and disables both stack-placement and companion-window motion when the system requests reduced motion. The stack may move to the restricted companion overlay; that overlay has no restorable Workbench Session and does not own task state. When the same Browser surface is already visible in the selected Nodex window, its duplicate native presentation is temporarily suppressed without changing the user's visibility choice.

Clicking a built-in Browser presentation focuses its exact task tab. Clicking an existing-browser presentation focuses the exact connected extension instance and tab. A stale, disconnected, or mismatched instance is ignored rather than falling back to another profile.
Presentations produced by the policy-gated CDP backend are display-only and do not borrow the built-in Browser focus route.

## Visibility and lifecycle

Users can show or hide one active task, hide all active tasks, or globally suppress native picture in picture. Main persists the global setting, maximum display size, and per-task visibility in the local Profile. Reloading, closing, or archiving a task preserves its choice; permanently deleting the task removes it.

Renderer windows read a bounded revisioned snapshot and submit intents. They do not own active-task truth, the complete visibility map, native callbacks, Browser images, or window attachment. A local Codex connection loss immediately retires the old generation and releases its live presentations. Reconnection starts empty and accepts only new-generation control activity.

## Failure and privacy behavior

Malformed or oversized Browser images are rejected before native decoding. Main bounds presentation count and estimated decoded bytes per session, task, and process. Diagnostics contain only bounded operation/result fields, coarse timing, backend/family, revision, and a salted task hash; they never contain screenshots, URLs, page titles, prompts, or raw extension payloads.

If the native host, Computer Use service, or browser extension disconnects, Nodex keeps task and preference truth in Main, releases identities that can no longer be addressed, and reconciles only against a newly verified service or extension instance. Auxiliary UI failure cannot fail the Agent protocol generation.
