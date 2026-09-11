# Semantic theme contract

This module owns the build-time contract between extracted theme facts and Nodex's semantic UI roles. Renderer code consumes only committed CSS artifacts; builds and CI never require a reference stylesheet.

## Maintainer workflow

Use a temporary, read-only stylesheet from any location. The module does not copy, cache, modify, or identify that input. Only a neutral `refVersion`, the profile identity, and output hashes are committed.

For Codex Electron references, use the stylesheet loaded by the startup document as the semantic contract source. In current bundles this is the global `app-initial-*.css` stylesheet. Do not merge declarations from lazy component chunks such as `app-primary-*.css` into the source contract just because they contain additional theme-like variables; those chunks are loaded by component routes and do not define the global startup theme.

This stylesheet establishes the static contract, not the final preset values.
For effective color parity, resolve the selected preset, its chrome overrides,
normalization, and account accent overlay separately. A fallback palette or a
CSS-only test cannot establish the rendered default. The runtime palette owner
is `src/renderer/lib/codex-theme-variant.ts`; its output also supplies the initial
document. Keep numeric palette verification there and cascade verification in
the computed-style browser suite.

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
- `theme-source.css` owns product foundation values such as radius scale. Generated values may consume those foundations but must not silently replace them.
- Components should express shared text, status, border, background, icon, and motion roles with semantic utilities. Feature-native visual concepts remain feature-owned.

Required roles declare their actual consumer targets. A task-only role may be Electron-only; a geometry foundation used by every shell must cover every supported target. Do not widen a runtime-provider exemption to silence a missing CSS provider. Add an explicit fallback or repair the scoped bridge instead.
