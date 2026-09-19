# Vendored BlockNote

Nodex vendors a narrow BlockNote subset so editor fixes can be maintained directly while app code continues importing the normal `@blocknote/*` package names.

## Upstream

- Repository: https://github.com/TypeCellOS/BlockNote
- Tag: `v0.54.2`
- Commit: `fa7f7b84ac4ab52a802aa0b2f8f922933b8358e4`
- Imported packages:
  - `packages/core` -> `third_party/blocknote/packages/core`
  - `packages/react` -> `third_party/blocknote/packages/react`
  - `packages/shadcn` -> `third_party/blocknote/packages/shadcn`
  - `packages/code-block` -> `third_party/blocknote/packages/code-block`
  - `packages/math-block` -> `third_party/blocknote/packages/math-block`
  - `packages/diagram-block` -> `third_party/blocknote/packages/diagram-block`

## License Boundary

The vendored packages above are MPL-2.0 packages. Preserve each package's `LICENSE` file and keep local source modifications documented here when rebasing.

The `@blocknote/xl-*` packages are intentionally excluded because upstream marks them as GPL-3.0-or-proprietary/commercial packages. Other BlockNote packages are also excluded unless Nodex starts consuming them directly.

## Runtime Contract

- App imports stay on the source-first `@blocknote/core`, `@blocknote/react`, `@blocknote/shadcn`, `@blocknote/code-block`, `@blocknote/math-block`, and narrow `@blocknote/diagram-block/trim-diagram-svg` surfaces.
- Math is a first-class BlockNote/NFM content type. Mermaid remains a `codeBlock` language and consumes only the Diagram package's pure SVG trimming helper; Nodex never registers the package's separate `diagram` Block or initializer.
- Root `package.json` resolves those packages through pnpm workspaces.
- Vendored package exports are source-first and point at `src` instead of `dist`.
- Upstream package `devDependencies` are omitted from the private vendored manifests so editor runtime code resolves React and other peers from Nodex instead of package-local tooling installs.
- The vendored shadcn adapter uses Base UI behind its BlockNote component Interfaces; it does not expose Base UI parts or DOM tokens to Nodex feature code.
- Tailwind scans `third_party/blocknote/packages/shadcn/src`.
- The renderer manual chunk resolver groups `third_party/blocknote/packages/` with the BlockNote/Tiptap vendor chunk.
- The standard Nodex suites run vendored tests only when they are selected explicitly; use the repository's `vp test run --config ...` commands below when maintaining BlockNote.
- BlockNote 0.54's optional Yjs v14 versioning surface is compiled and tested but is not wired into Nodex's Yjs v13 editor runtime or durable Core history authority.
- Schema extension isolates shared specs while preserving the schema's Block child acceptance and layout rules. Transaction change readers bound ordinary snapshots to the changed range, including property-only and mark-only edits; pre-UniqueID snapshots retain their read-only transient identity fallback. Table handles resolve their current Block identity after intervening edits and ignore HTML tables owned by other Block types.
- `@y/prosemirror@2.0.0-6` is patched only to publish four conversion helpers already present in its source and declaration files; BlockNote 0.54 imports those helpers from the package root for diff preview.

## Nodex Semantic Patch Ledger

The fork is maintained as product behavior, not as a list of files that must win a merge. Each row names the behavior owner and the evidence that must stay green when upstream code is replaced. `Replay` means rebuild the behavior on the new upstream seam; `re-evaluate` means first prove whether upstream now provides the same contract and delete the local patch when it does.

| Capability | Current implementation | Behavioral owner / oracle | Upgrade strategy |
| --- | --- | --- | --- |
| Collaborative authority, local transaction origins, editor-local Undo, and retained editor identity | `core/src/extensions/Collaboration/`, `core/src/editor/BlockNoteEditor.ts`, renderer NFM composition | `docs/product-specs/card-stage-rich-editor-performance.md`; `nfm-editor-undo.browser.test.tsx`; `blocknote-view-lifecycle.browser.test.tsx` | Replay on the target collaboration/Yjs extension seam. Never restore the pre-0.52 `collaboration` editor option or seed a mounted editor from an NFM projection. |
| Nested block ownership, schema composition, stable IDs, toggle collapse, and block conversion | `core/src/blocks/`, `core/src/schema/`, `core/src/api/nodeConversions/`, `react/src/blocks/ToggleWrapper/` | headless schema and NFM adapter suites; toggle and child-group tests | Re-evaluate upstream schema changes item by item, then replay only Nodex schema and NFM round-trip semantics. |
| Side-menu routing, captured drag selection, native drag lifetime, and editor interaction scopes | `core/src/extensions/SideMenu/`, `core/src/editor/editorInteractionScopes.ts`, React side-menu controllers | `docs/product-specs/nfm-block-side-menu-behavior.md`; side-menu transfer and renderer/browser tests; Electron native Block → Board smoke | Replay on the target SideMenu Extension. Preserve deepest visible editor ownership, structured cross-editor Slice transfer, and public ProseMirror selection APIs. Replace the old trigger workaround only after real click-versus-drag browser evidence passes. |
| Suggestion-session identity, IME state, async freshness, active descendant, temporary input, and deferred authoritative acceptance | `core/src/extensions/SuggestionMenu/`; React suggestion controllers and loaders | `docs/product-specs/nfm-editor-suggestion-menu-behavior.md`; core/React freshness tests; `nfm-suggestion-session.browser.test.tsx`; slash/page-mention tests | Replay onto the target Extension and React controller structure. The session remains the sole owner; popup lifecycle and async results may not recreate or outlive it. |
| Formatting/text-action selection handoff and child-surface leases | Formatting/Link toolbar Extensions plus Nodex controller composition | text-action and formatting toolbar product specs and renderer/browser suites | Re-evaluate upstream controller cleanup, then replay Nodex lease and active-editor routing without exposing renderer state through vendored Interfaces. |
| Atomic-block keyboard boundaries and document-wide selection | Core keyboard shortcuts, `getNearestBlockPos`, and renderer progressive selection | vendored keyboard/editor tests; progressive select-all and typed-owner browser tests | Contentless atomic Blocks are not empty text Blocks and must not enter Tiptap's text-cut path. Progressive select-all treats both `inline` rich text and `plain` source as editable Block content before advancing to `AllSelection`; it does not absorb `table` or `none` Blocks. Document start/end are valid `AllSelection` boundaries and resolve silently to the first/last Block. |
| Link/autolink, manual URLs, and page/thread/date mention atoms | Link helpers, React safe-URL handling, schema specs, node conversion, Nodex NFM adapter | `docs/product-specs/nfm-editor-link-behavior.md`; safe-URL, page-reference, and link suites | Replay only the Nodex URL/atom contracts after adopting the target Link Extension and schema helpers. Keep open-time protocols on the explicit product allowlist and scope the read-only app filesystem protocol to file downloads. |
| Code Block parsing, syntax loading, product language catalog, creation default, plain-text merge boundaries, and Tab/Shift-Tab indentation | `core/src/blocks/Code/`, `core/src/api/blockManipulation/commands/mergeBlocks/`, Core keyboard shortcuts, the generated `@blocknote/code-block` highlighter, and renderer Code Block composition | `docs/product-specs/nfm-editor-code-block-behavior.md`; Code Block Core/renderer/browser/Electron suites; `docs/KEYBOARD_SHORTCUTS.md` | Use the editor-wide syntax-highlighting Extension and the renderer's custom React spec. Preserve the exact generated grammar catalog, normalized/dynamic creation language, literal indentation, start-of-source Backspace no-op, content-model-aware plain-text merges with child promotion, and NFM parsing; never restore BlockNote's vanilla language select, a block-local highlighter, or the generic non-paragraph reset for plain-source Blocks. |
| Table semantics, clipboard/parser hardening, nested-list normalization, and bounded block-change reporting | Core table, Markdown, clipboard, parser, transaction-reporting, and security helpers | table product spec; focused Core/NFM conversion and escaping tests; typed-owner Chromium guard; Electron collaborative Enter smoke | Re-evaluate patch by patch. A preflight change reader must accept split, paste, and copy-drop transactions before `UniqueID.appendTransaction` assigns persistent IDs, keep temporary snapshot identities out of the dispatched document, and ignore attribution suggested-deletion copies. Retain only behavior with a product or security oracle; do not carry snapshot churn as an independent patch. |
| Popover portal ownership, exit subtree identity, inert closing state, and static-exit opt-in | React `GenericPopover`, `FloatingUIOptions`, editor interaction scopes | lifecycle, formatting, context-menu, and floating-surface browser tests | Replay on target portal contracts. The final committed subtree stays inert through exit; selection-reactive surfaces may snapshot geometry without creating a second interaction owner. |
| Source-first packages, lazy controller exports, and renderer chunk ownership | six private manifests, Vite configs, React lazy controller entry points | typecheck, renderer chunk tests, build | Reconstruct deterministically from the target manifests. Re-evaluate lazy imports against target default-UI chunks rather than copying old files blindly. |
| Equation source-with-preview editing, strict KaTeX rendering, popup accessibility, atomic Backspace boundary, and childless Math identity | Core/React SourceWithPreview plus the optional Math package | `docs/product-specs/nfm-editor-equation-and-mermaid-preview-behavior.md`; NFM/headless/renderer Equation tests | Re-evaluate upstream Math and SourceWithPreview together. Preserve source-only durability, strict KaTeX options, semantic preview states, invalid-source Done guard, atomic Backspace behavior, renderer/headless schema parity, and the product-owned popup geometry. |
| Vendored shadcn adapter, semantic side-menu button props, and Nodex icon geometry | `shadcn/src/**` | editor renderer/browser tests and visual review | Adopt the target Base UI implementation first, then replay only the intrinsic button Interface and icon geometry. Do not retain Radix selectors or `asChild`. |

No generated `dist` hunks are carried forward. Snapshots are evidence produced by retained behavior, not standalone patches. Future BlockNote changes must update this ledger when a behavior is absorbed upstream, rebuilt on a new seam, or intentionally removed.

## Upgrade Workflow

Treat BlockNote upgrades as a source rebase, not as an npm version bump. The goal is to re-import the same six packages from a newer upstream tag, replay Nodex's local source delta, then restore the workspace package contract described above.

Use a local clone instead of reading upstream files from `raw.githubusercontent.com`:

```bash
OLD_TAG=v0.54.2
NEW_TAG=vX.Y.Z
blocknote_upgrade_dir=$(mktemp -d /tmp/nodex-blocknote-upgrade.XXXXXX)

git clone --filter=blob:none https://github.com/TypeCellOS/BlockNote.git \
  "$blocknote_upgrade_dir/blocknote"
git -C "$blocknote_upgrade_dir/blocknote" checkout "$OLD_TAG"
```

Mirror the current vendored packages into the old upstream checkout and create a source delta. Exclude package manifests from this patch because Nodex's private workspace/source-first manifests are deterministic and should be re-applied after the new upstream package manifests are copied:

```bash
for pkg in core react shadcn code-block math-block diagram-block; do
  rsync -a --delete \
    "third_party/blocknote/packages/$pkg/" \
    "$blocknote_upgrade_dir/blocknote/packages/$pkg/"
done

git -C "$blocknote_upgrade_dir/blocknote" diff --output="$blocknote_upgrade_dir/nodex-blocknote-local-source-delta.patch" --binary -- \
  packages/core \
  packages/react \
  packages/shadcn \
  packages/code-block \
  packages/math-block \
  packages/diagram-block \
  ':(exclude)packages/core/package.json' \
  ':(exclude)packages/react/package.json' \
  ':(exclude)packages/shadcn/package.json' \
  ':(exclude)packages/code-block/package.json' \
  ':(exclude)packages/math-block/package.json' \
  ':(exclude)packages/diagram-block/package.json'
```

Reset the clone to the new upstream tag and replay the source delta with three-way merge support:

```bash
git -C "$blocknote_upgrade_dir/blocknote" reset --hard
git -C "$blocknote_upgrade_dir/blocknote" clean -fdx
git -C "$blocknote_upgrade_dir/blocknote" checkout "$NEW_TAG"
git -C "$blocknote_upgrade_dir/blocknote" apply -3 \
  "$blocknote_upgrade_dir/nodex-blocknote-local-source-delta.patch"
```

Resolve conflicts in the upstream clone first. Every retained hunk must map to a capability in the semantic patch ledger. If upstream now satisfies the complete behavioral oracle, drop the local hunk and update the ledger rather than preserving the former file shape.

Copy the resolved packages back into Nodex:

```bash
for pkg in core react shadcn code-block math-block diagram-block; do
  rsync -a --delete \
    "$blocknote_upgrade_dir/blocknote/packages/$pkg/" \
    "third_party/blocknote/packages/$pkg/"
done
```

After copying, restore the vendored package manifest rules:

- Keep upstream `name` and new upstream `version`.
- Set `private: true`.
- Keep source-first `main`, `module`, `types`, `source`, and `exports` entries.
- Order conditional exports from specific to fallback: keep custom conditions such as `style` before `default`, and always keep `default` last so later conditions remain reachable.
- Keep all existing public subpath exports used by Nodex.
- Change internal BlockNote runtime dependencies to `workspace:*`.
- Omit upstream package `devDependencies` unless Nodex intentionally starts running upstream package-local tooling.

Then update this file:

- Change the upstream tag and commit.
- Keep the imported package list limited to `core`, `react`, `shadcn`, `code-block`, `math-block`, and `diagram-block`.
- Keep the `@blocknote/xl-*` exclusion unless the licensing decision changes explicitly.
- Refresh the Semantic Patch Ledger so every retained local behavior names its current seam and oracle.

Finish with the standard validation commands:

```bash
vp install
vp test run --config vitest.renderer.config.ts \
  third_party/blocknote/packages/core/src/api/getBlocksChangedByTransaction.test.ts \
  third_party/blocknote/packages/core/src/schema/schema.test.ts \
  third_party/blocknote/packages/core/src/extensions/Versioning/Versioning.test.ts \
  third_party/blocknote/packages/core/src/extensions/Versioning/inMemoryVersioning.test.ts \
  third_party/blocknote/packages/core/src/yjs/extensions/Versioning.test.ts \
  third_party/blocknote/packages/core/src/extensions/SuggestionMenu/SuggestionMenu.test.ts \
  third_party/blocknote/packages/react/src/components/SuggestionMenu/SuggestionMenuFreshness.test.tsx \
  src/renderer/components/board/editor/nfm-side-menu.test.tsx \
  src/renderer/components/board/editor/nfm-slash-menu.test.tsx
vp test run --config vitest.node.config.ts \
  src/shared/block-documents/headless-blocknote-schema.test.ts \
  src/renderer/lib/nfm/blocknote-adapter.node.test.ts
vp run typecheck
vp run lint
vp run test
vp run build
```
