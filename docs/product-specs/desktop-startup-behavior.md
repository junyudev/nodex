# Desktop Startup Behavior

Status: Active
Last updated: 2026-10-16

## Promise

Opening Nodex presents the user's restored application window immediately and keeps that physical
window through local-data preparation and Workbench readiness. Startup is a state of the real app
window, not a splash dialog that is later exchanged for another window.

## First frame

- The first visible content is the Nodex mark centered in the restored window bounds. It fades in
  over a fraction of a second, so a fast start never pops a full-strength mark in and out.
- The mark is a quiet, translucent material that lets the window surface show through in each
  appearance, not a solid glyph. A soft highlight sweeps across it on a slow, steady cadence.
- The base mark is part of the application document and remains visible when application modules,
  React, stylesheets, IPC, Core, or the Store are delayed.
- The initial document and mounted Workbench use the same resolved appearance palette. The opaque
  startup background uses the shared underlying surface, including before application scripts run.
- On macOS, the startup surface uses the same native material policy as the Workbench. Reduce
  transparency, an unfocused or oversized surface, or an unsupported platform selects the normal
  theme-matched opaque fallback.
- The shimmer is decorative, pauses while the document is hidden, and becomes a static mark when
  Reduce motion is enabled. Reduce motion also skips the fade-in.

## Progress and transition

Fast starts remain quiet. After 1.8 seconds, ordinary startup may show `Opening Nodex…`. A real
Store migration immediately shows `Updating local data…`; when trustworthy progress is available,
the integer percentage never moves backward. Opening the initial Project then shows
`Opening workspace…`. Status copy appears below the mark without moving it off center.

The full Workbench loads only after global initialization and that window's activation gate are
both ready. React replaces the startup document in place. BrowserWindow and WebContents identities,
bounds, traffic lights, focus, native material, and the macOS foreground application identity do not
change at this transition; the app remains present in the Dock and application menu.

When multiple Window Sessions restore, all receive their canonical lightweight shell, but only the
primary is shown and activated first. Each following renderer activates after the previous renderer
reports readiness or the bounded coordinator advances it. This avoids simultaneous full Workbench
imports while preserving every restored Window Session.

Workbench state owners load with the application. Settings, Automations, conversation views,
terminal, and file editor surfaces load when their route or panel is rendered, so unopened
surfaces do not delay the initial Workbench. Their loading boundaries retain the surrounding
Workbench and its state. Renderer readiness waits for the initial route's data selection and
visible loading boundaries to commit their content; committing an empty loading fallback does
not release the activation coordinator. Later route changes do not reopen the startup gate.

Renderer readiness diagnostics record separate durations for the native activation gate,
bootstrap queries, application module loading, diagnostics initialization, and React mount.
Failed startup includes only phases that were attempted, including the failed phase. Browser
profiling is best effort and cannot prevent startup or replace the original failure.

## Failure and recovery

Core, Store, capability-graph, or renderer-import failure retains the Nodex mark in the same window,
announces an alert, and offers `Restart Nodex`. Restart relaunches the application through the
scoped shutdown path. Closing the last failed window quits instead of leaving a windowless process;
Dock activation while the failure window exists focuses that window rather than creating another
one. A native error dialog is reserved for failures that prevent the renderer document itself from
loading.

After React takes ownership of the document, a failed surface import or render retains an
in-application Nodex mark and `Restart Nodex` action. A failed initial surface reports startup
failure; a failure in a later optional surface retains the surrounding Workbench.

## Invariants

- Normal startup has no temporary BrowserWindow, startup-only preload, or startup renderer route.
- Before post-Core activation, the renderer can use only the bootstrap IPC surface and cannot
  attach webviews, open popups, or navigate away from the app origin.
- The startup JavaScript graph does not eagerly load React, Workbench, editor, diagnostics, or
  telemetry code.
- The production build enforces a 24 KiB inline-document budget and a 20 KiB gzip budget for eager
  renderer bootstrap JavaScript, including parser-time classic scripts.

Runtime ownership is documented in [Architecture](../ARCHITECTURE.md), shutdown and failure
semantics in [Reliability](../RELIABILITY.md), and the early authority boundary in
[Security](../SECURITY.md).
