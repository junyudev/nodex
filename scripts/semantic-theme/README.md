# Semantic theme contract

This module owns the build-time contract between extracted theme facts and Nodex's semantic UI roles. Renderer code consumes only committed CSS artifacts; builds and CI never require a reference stylesheet.

## Maintainer workflow

Use a temporary, read-only stylesheet from any location. The module does not copy, cache, modify, or identify that input. Only a neutral `refVersion`, the profile identity, and output hashes are committed.

For Codex Electron references, follow the startup document's stylesheet links and verify where the global theme is defined before selecting the source. The current global contract is in `app-shared-*.css`; a chunk name is not a stable contract. The startup JavaScript also loads `app-initial-*.css`, but that chunk now contains component styles. Do not merge lazy component chunks into the theme source merely because they contain additional theme-like variables.

The extractor recognizes global `:root`/`:host` and `:where` theme scopes, preserves window and appearance overrides, and includes the transitive palette and typography providers needed by exported roles. `data-theme="light"` or `data-theme="dark"` selects the stylesheet's appearance variables, including inherited theme containers. Negated window selectors must retain their original coverage; an extension-only declaration cannot provide an Electron role.

This stylesheet establishes the static contract, not the final preset values.
For effective color parity, resolve the selected preset, its chrome overrides,
normalization, and account accent overlay separately. A fallback palette or a
CSS-only test cannot establish the rendered default. The runtime palette owner
is `src/renderer/lib/codex-theme-variant.ts`; its output also supplies the initial
document. Keep numeric palette verification there and cascade verification in
the computed-style browser suite.

Visual review must identify the effective appearance and persisted palette overrides
of the target window; a clean Profile can resolve to a different palette. Match the
native opaque/translucent state before comparing paint. Root-variable equality is
only an input check: also inspect actual surfaces, descendant color inheritance,
ancestor opacity, and control hover/selected/open states. Keep these measurements
in local review artifacts rather than encoding visual snapshots as source tests.

```sh
vp run semantic-theme:audit -- --source /temporary/reference.css --ref-version <version>
vp run semantic-theme:audit -- --source /temporary/reference.css --ref-version <version> --report /tmp/theme-audit.json
vp run semantic-theme:sync -- --source /temporary/reference.css --ref-version <version>
vp run semantic-theme:verify -- --source /temporary/reference.css
```

Review `audit` before `sync`. Its optional JSON report separates added, removed, and changed declarations, utilities, selectors, and dependency records while listing the active collision decisions; it never records the input path. `sync` atomically updates the generated contract, foundation, utilities, surfaces, manifest, and provenance. Providing the same content at another path produces byte-identical artifacts.

Normal development and CI use the source-free gate:

```sh
vp run semantic-theme:verify
```

This checks provenance, artifact hashes, required semantic utilities, and the scoped, transitive custom-property graph without the temporary stylesheet. A declaration only counts as a provider in the window, color-scheme, and at-rule scope where it is effective; fallback branches and explicitly declared runtime providers remain visible in the graph. The gate also rejects dependency cycles and cross-file root collisions without an ownership decision. After building the renderer, `vp run semantic-theme:verify-build` repeats the required-role checks against the CSS that survived Tailwind and bundling.

## Ownership

- `profile.ts` defines supported semantic families, utilities, scopes, and explicit collision resolutions.
- Generated files are outputs, never hand-edited.
- `theme-token-bridge.css` owns product compatibility aliases while consumers migrate.
- `theme-source.css` owns product foundation values such as radius scale and feature-specific aliases. Shared elevation tiers come from the generated foundation; legacy shadow names alias those tiers. Generated values may consume product foundations but must not silently replace them.
- `--app-color-*` values feed the shared semantic roles. Extension `--vscode-*` inputs remain scoped to the extension; product aliases needed by Electron must resolve through its semantic providers.
- Components should express shared text, status, border, background, icon, and motion roles with semantic utilities. Feature-native visual concepts remain feature-owned.

Required roles declare their actual consumer targets. A task-only role may be Electron-only; a geometry foundation used by every shell must cover every supported target. Do not widen a runtime-provider exemption to silence a missing CSS provider. Add an explicit fallback or repair the scoped bridge instead.
