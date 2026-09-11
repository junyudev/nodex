# Desktop Startup Behavior

Status: Active
Last updated: 2026-09-11

## Promise

Opening Nodex presents the user's restored application window immediately and keeps that physical
window through local-data preparation and Workbench readiness. Startup is a state of the real app
window, not a splash dialog that is later exchanged for another window.

## First frame

- The first visible content is the Nodex mark centered in the restored window bounds.
- The base mark is part of the application document and remains visible when application modules,
  React, stylesheets, IPC, Core, or the Store are delayed.
- The initial document and mounted Workbench use the same resolved appearance palette. The opaque
  startup background uses the shared underlying surface, including before application scripts run.
- On macOS, the startup surface uses the same native material policy as the Workbench. Reduce
  transparency, an unfocused or oversized surface, or an unsupported platform selects the normal
  theme-matched opaque fallback.
- The shimmer is decorative, pauses while the document is hidden, and becomes a static mark when
  Reduce motion is enabled.

## Progress and transition

Fast starts remain quiet. After 1.8 seconds, ordinary startup may show `Opening Nodex…`. A real
Store migration immediately shows `Updating local data…`; when trustworthy progress is available,
the integer percentage never moves backward. Opening the initial Project then shows
`Opening workspace…`.

The full Workbench loads only after global initialization and that window's activation gate are
both ready. React replaces the startup document in place. BrowserWindow and WebContents identities,
bounds, traffic lights, focus, native material, and the macOS foreground application identity do not
change at this transition; the app remains present in the Dock and application menu.

When multiple Window Sessions restore, all receive their canonical lightweight shell, but only the
primary is shown and activated first. Each following renderer activates after the previous renderer
reports readiness or the bounded coordinator advances it. This avoids simultaneous full Workbench
imports while preserving every restored Window Session.

## Failure and recovery

Core, Store, capability-graph, or renderer-import failure retains the Nodex mark in the same window,
announces an alert, and offers `Restart Nodex`. Restart relaunches the application through the
scoped shutdown path. Closing the last failed window quits instead of leaving a windowless process;
Dock activation while the failure window exists focuses that window rather than creating another
one. A native error dialog is reserved for failures that prevent the renderer document itself from
loading.

## Invariants

- Normal startup has no temporary BrowserWindow, startup-only preload, or startup renderer route.
- Before post-Core activation, the renderer can use only the bootstrap IPC surface and cannot
  attach webviews, open popups, or navigate away from the app origin.
- The startup JavaScript graph does not eagerly load React, Workbench, editor, diagnostics, or
  telemetry code.
- The production build enforces a 24 KiB inline-document budget and a 20 KiB gzip budget for eager
  renderer bootstrap JavaScript.

Runtime ownership is documented in [Architecture](../ARCHITECTURE.md), shutdown and failure
semantics in [Reliability](../RELIABILITY.md), and the early authority boundary in
[Security](../SECURITY.md).
