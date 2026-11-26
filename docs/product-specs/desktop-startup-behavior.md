# Desktop Startup Behavior

Status: Active
Last updated: 2026-11-22

On Windows, the per-user login registration launches Nodex with `--startup`.
That activation acquires the normal application Scope, including the tray, Core,
Agent Runtime and hidden canonical Workbench windows. It does not show or focus a
window, including at renderer readiness or a presentation watchdog. A later
interactive launch or tray action reveals the retained window. Repeated startup
activations never become ordinary navigation. Other launches retain the startup
presentation described below. See [Windows host behavior](windows-host-behavior.md#notification-area-and-startup).

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

A missing or damaged Codex package leaves the Workbench and other Agents usable.
Nodex verifies the bundled package during startup in the background. Codex features
report availability separately from Workbench readiness.

Ordinary startup stays quiet however long it takes: the mark alone signals that Nodex is opening,
and only assistive technology hears `Opening Nodex…`. Visible status copy is reserved for real
local-data work. A Store migration immediately shows `Updating local data…`; when trustworthy
progress is available, the integer percentage never moves backward. The copy clears as soon as the
Store is ready. Status copy appears below the mark without moving it off center.

The full Workbench loads only after global initialization and that window's activation gate are
both ready. The reply that opens the gate carries everything the renderer needs to start: the
window's Space, its Window Session, runtime capabilities and diagnostics settings. The renderer
binds its Space and mounts from that one reply, and every Space request in the document reuses it,
so a window reaches its Workbench after a single round trip. A failed reply is retried by the next
request instead of being retained. The Workbench lays out beneath the mark without showing or
taking pointer input, and is marked busy for assistive technology; keyboard focus already reaches
it, so typing ahead is kept. When its initial route reports readiness (below), the mark and the
Workbench change places in one frame with a short crossfade, or at once with Reduce motion, so the
window never shows a blank Workbench, a lone sidebar or an empty pane on the way. A Workbench that
has not reported readiness three seconds after it began mounting is shown anyway. A failed mount
keeps the mark, which then presents the failure. BrowserWindow and WebContents identities, bounds,
traffic lights, focus, native material, and the macOS foreground application identity do not
change at this transition; the app remains present in the Dock and application menu.

When multiple Window Sessions restore, all receive their canonical lightweight shell, but only the
primary is shown and activated first. Each following renderer activates after the previous renderer
reports readiness or the bounded coordinator advances it. This avoids simultaneous full Workbench
imports while preserving every restored Window Session.

Workbench state owners load with the application. Settings, Automations, Inbox, conversation
views, terminal, and file editor surfaces load when their route or panel is rendered, so unopened
surfaces do not delay the initial Workbench. Their loading boundaries retain the surrounding
Workbench and its state. Renderer readiness waits for the initial route's data selection and
visible loading boundaries to commit their content; committing an empty loading fallback does
not release the activation coordinator. Later route changes do not reopen the startup gate.
This includes ordinary data-loading branches: a restored Database waits for its initial View
model, a restored Inbox, including a Project's Inbox Home, waits for its first messages and
counts, a Page waits for its detail, Document preparation, and first content sync, and a visible
Composer waits for its persisted draft and initial input to commit. Hidden
retained tabs and hidden Composer content do not delay readiness; retained conversation
lifecycles continue while their content loads. Their import failures stay within their own
recovery boundary and do not reject startup. A committed recoverable data error ends that
loading wait.

Renderer readiness diagnostics record separate durations for the native activation gate,
application module loading, diagnostics initialization, and React mount.
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

Desktop retains bounded failure evidence as soon as initialization fails, even if
Core cannot execute and verbose logging is disabled. A trusted owned renderer can
query `app:startup-failure-evidence` for the incident ID and local diagnostic path;
this query requires no Core connection and changes no visible failure presentation.
Windows storage and loader evidence are specified in the
[Windows runbook](../release-windows.md#startup-failure-evidence).

## Invariants

- Normal startup has no temporary BrowserWindow, startup-only preload, or startup renderer route.
- Before post-Core activation, the renderer can use only the bootstrap IPC surface and cannot
  attach webviews, open popups, or navigate away from the app origin.
- The startup JavaScript graph does not eagerly load React, Workbench, editor, Markdown WebAssembly,
  the message formatter, diagnostics, or telemetry code. The Workbench initializes Markdown after native activation and
  before loading the application renderer.
- The production build enforces a 24 KiB inline-document budget and a 20 KiB gzip budget for eager
  renderer bootstrap JavaScript, including parser-time classic scripts.
- Activating an ordinary Workbench loads the application renderer, every chunk it reaches through
  static imports, and the stylesheets preloaded with it. The production build measures that
  closure from its emitted chunks and enforces 10.99 MiB of JavaScript and 712 KiB of CSS, about
  2% above the measured size. A change that needs more raises the budget deliberately.
- Excalidraw, the Terminal emulator, Cytoscape, ELK, Mermaid, PDF.js and the syntax highlighter
  load only with the surfaces that use them; message and document code is colored in a worker.
  The diagnostics SDK loads only when diagnostics are on; renderer tracing records once it has.
- A Workbench surface loads its code with the first tab, panel or overlay that shows it: Pages,
  Databases, Library resources, Skills, page files, the Browser, plugin apps and first-run setup.
  Subagent avatars are files the window fetches when it shows one. The production build attributes every emitted chunk to its packages
  through the hidden source maps and fails when code from any of them is statically reachable
  from the ordinary Workbench, whichever chunk carries it, or when one of them no longer appears
  in the build.
- Main evaluates only its lifecycle, configuration, foundation services and the pre-Core window
  shell before the startup window appears. The application graph, which is most of Main's code
  and includes Markdown and the Terminal runtime with its native PTY addon, loads once that shell
  exists. The same check measures what Main evaluates first and enforces 1.28 MiB, about 2%
  above the measured size. Packages the build leaves in `node_modules`, native addons among them,
  are outside that measure, so the check also fails when Main's own code requires one before the
  startup window other than Electron, the diagnostics SDK and the message formatter.
- A packaged Nodex compiles its Main code from Node's compile cache once it has run: the
  bootstrap entry enables the cache in the account's own cache folder, then loads the Main
  application. The first launch of each version compiles from source and fills the cache;
  development builds always compile from source.
- The application origin takes part in V8's code cache. A renderer script that has run before is
  compiled from the Profile's on-disk cache in later windows and launches instead of from source;
  the cache costs disk space about the size of the renderer's JavaScript, and an updated script
  compiles from source once before it is cached again.

Runtime ownership is documented in [Architecture](../ARCHITECTURE.md), shutdown and failure
semantics in [Reliability](../RELIABILITY.md), and the early authority boundary in
[Security](../SECURITY.md).
