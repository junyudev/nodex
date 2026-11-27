# ADR 0092: Visuals run in offline guests

## Status

Accepted.

## Context

Visuals need offline executable chart source, accurate browser text metrics and
interactivity inside a Page. Agents need the same layout engine on Desktop and on
a team Space Host. The document authority stores the source as an ordinary code
block.

## Decision

Oxc validates and instruments the Visual source in native code in the Host and
with a lazy WASI binding in the Desktop renderer. The runtime is a dedicated
sandboxed Electron document with a one-time same-window admission, an isolated
Session and a strict CSP. React and the allowed charting modules resolve from a
Nodex protocol. Only the host resolves Page data. The guest receives structured
data and executes the compiled program in its main world. Nodex measures DOM
geometry and constructs a restricted, theme-inlined SVG in an isolated world.
The guest takes no pointer input: the Page hit-tests data points and text from
that geometry and owns every interaction.
Only the host controls capture deadlines and grant lifetimes.

A Visual check uses the same runtime in an offscreen Electron window. The team
Space Host runs Electron in Node mode and starts a short-lived Electron worker
for this operation. The worker receives the job and authorized source bytes
over stdio. It owns a disposable Chromium profile. A headless Linux launch uses
`xvfb-run -a -s "-screen 0 1280x1024x24 -nolisten tcp"` and Electron's
`--ozone-platform=x11 --disable-dev-shm-usage --disable-gpu` switches, with the
Chromium sandbox enabled.

## Consequences

Core needs no Visual storage model. A generic Block-to-Page lookup lets CLI
callers bind a check or snapshot to the same Page that owns its Block. Captures
can be recreated from identical source, resolved data, appearance and runtime.
A page-local edit never writes a separate render document. The host and guest
protocol is independent of conversation inline visualizations.

See [Visual behavior](../product-specs/visual-block-behavior.md) and
[Visual guest isolation](../SECURITY.md#visual-guest-isolation).
