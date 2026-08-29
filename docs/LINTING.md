# Lint Governance

Nodex treats lint output as two different products:

- **Errors are merge gates.** They represent compiler failures, high-confidence
  correctness contracts, or a precise Nodex-owned invariant with a documented
  replacement.
- **Warnings are advisory.** The `correctness`, `suspicious`, and `perf`
  categories are enabled as warnings so nearby code can be improved without
  turning repository-wide heuristic output into unrelated mandatory work.

Warnings must remain visible, but their count is not an acceptance condition.
Do not add `--max-warnings 0` or `--deny-warnings` to the canonical commands.

## Canonical commands

```bash
# Cached integrated format, Effect-patched TypeScript 7, typed Oxlint, and typecheck gate
vp run check

# Full lint output, including stale suppression comments
vp run lint

# Compact output for a coding agent
vp lint --format agent --report-unused-disable-directives
```

`effect-tsgo patch --oxlint` runs during dependency preparation. Both
`lint.options.typeAware` and `lint.options.typeCheck` remain enabled, so Vite+
owns one integrated TypeScript, Effect, and Oxlint interpretation. The fixture
mode used by `vp run tooling:verify` disables typed analysis only for isolated
synthetic files that are intentionally outside the TypeScript project graph.

Unused disable directives are warnings. Remove them when encountered. A real
exception may use a narrow inline disable with a concrete reason; broad file or
directory suppressions require a scoped config override and an invariant-based
rationale here.

## Category and override matrix

The root policy is:

| Source                          | Default severity | Purpose                                                                  |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `correctness`                   | warning          | Likely defects that still need repository-specific signal review         |
| `suspicious`                    | warning          | Potentially wrong or confusing constructs                                |
| `perf`                          | warning          | Improvement opportunities whose cost depends on the runtime and hot path |
| TypeScript compiler diagnostics | error            | The program must remain type-correct                                     |
| Explicit Nodex contracts        | error            | Stable, low-false-positive project invariants                            |

Individual rules override their category. Scoped overrides override the root
rule only in the named runtime or boundary.

### Explicitly disabled heuristics

These rules are disabled because their current signal conflicts with an
accepted Nodex pattern or creates mechanical churn without a stable invariant.
The underlying risk can still be enforced later by a narrower project rule.

| Rules                                                                                    | Why they are off                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint/no-await-in-loop`                                                                | Core, process, migration, and test workflows often require ordered backpressure; parallelization is a semantic decision rather than a generic lint fix.                                                                                  |
| `eslint/no-shadow`, `eslint/no-underscore-dangle`                                        | Decoder callbacks, reducers, generated-adjacent adapters, and test probes use local names or marked internal fields intentionally; renaming them does not improve correctness.                                                           |
| `eslint/no-control-regex`, `eslint/no-empty-pattern`, `eslint/no-useless-escape`         | Protocol parsing, callback signatures, and deliberately explicit regular expressions make the generic syntax heuristic unreliable.                                                                                                       |
| `oxc/no-map-spread`, `oxc/no-accumulating-spread`                                        | Immutable projection updates are the normal renderer/shared pattern. Syntax-only spread rules also report fixed two- or three-entry adapters; genuinely unbounded hot paths must be optimized from measured local evidence.              |
| `react/no-children-prop`                                                                 | Programmatic composition and app-owned slot adapters can pass `children` explicitly; the JSX preference is not a correctness boundary.                                                                                                   |
| `react/no-array-index-key`                                                               | Static SVG nodes, parser segments, shimmers, and sliding calendar buffers intentionally use positional identity. Editable/reorderable domain rows must carry stable ids in their model instead of relying on this syntax-only heuristic. |
| `react/react-in-jsx-scope`                                                               | Nodex uses the modern JSX transform and does not require a runtime `React` binding.                                                                                                                                                      |
| `typescript/await-thenable`                                                              | Effect-compatible and adapter-owned awaitable boundaries produce too many non-actionable diagnostics for a repository-wide contract.                                                                                                     |
| `typescript/consistent-return`                                                           | Visitors, callbacks, and state transitions intentionally combine value and early-void branches; TypeScript contracts own the return shape.                                                                                               |
| `typescript/no-base-to-string`, `typescript/restrict-template-expressions`               | Diagnostics, identifiers, and view-model logging intentionally stringify typed values; boundary-specific serializers are enforced where wire stability matters.                                                                          |
| `typescript/no-duplicate-type-constituents`, `typescript/no-redundant-type-constituents` | Generated/protocol projections and conditional aliases can look redundant after expansion while preserving a useful source contract.                                                                                                     |
| `typescript/no-meaningless-void-operator`                                                | Explicit `void` is the accepted marker for intentionally detached or discarded results; `no-floating-promises` still guards unsafe Promise loss.                                                                                         |
| `typescript/no-unnecessary-boolean-literal-compare`                                      | Explicit boolean comparisons are sometimes clearer at nullable, decoded, or policy boundaries and are not a defect.                                                                                                                      |
| `typescript/no-unnecessary-type-assertion`, `typescript/no-unnecessary-type-conversion`  | Boundary adapters and test setup retain explicit intent that can disappear after type expansion; removing it mechanically is low value.                                                                                                  |
| `typescript/no-unnecessary-type-parameters`, `typescript/no-unsafe-type-assertion`       | Transport helpers, schema adapters, and canonical projections use generics and narrowing assertions to express API intent; safety belongs at the runtime validation boundary.                                                            |
| `typescript/unbound-method`                                                              | Nodex commonly passes `this`-free capability and mock methods as values; the generic rule cannot prove those app-owned contracts.                                                                                                        |
| `unicorn/consistent-function-scoping`                                                    | Keeping a helper next to the workflow that owns it is preferable to repository-wide hoisting churn.                                                                                                                                      |
| `unicorn/no-array-sort`, `unicorn/no-array-reverse`                                      | In-place ordering is sometimes intentional, and many call sites already clone first; `typescript/require-array-sort-compare` separately enforces explicit sort semantics.                                                                |
| `unicorn/no-array-fill-with-reference-type`                                              | The syntax-only heuristic also reports unrelated app-owned methods named `fill`, so it cannot express the actual shared-reference risk.                                                                                                  |
| `unicorn/no-new-array`                                                                   | Typed array construction and dynamic-size allocation are legitimate; literal syntax is only a style preference.                                                                                                                          |
| `unicorn/no-useless-fallback-in-spread`, `unicorn/no-useless-spread`                     | Explicit fallback/spread shapes often document normalization and ownership boundaries even when a local type expansion makes them appear redundant.                                                                                      |
| `unicorn/prefer-array-find`                                                              | It reports last-segment and last-match pipelines such as `filter(...).at(-1)`, where `find` is not semantically equivalent.                                                                                                              |
| `unicorn/prefer-set-has`                                                                 | Current membership catalogs are tiny fixed unions, short status-code strings, or one-shot model arrays. Allocating a Set is not a stable performance win; repeated large lookups should build a measured local index.                    |

The following related heuristics remain advisory warnings rather than being
disabled: `typescript/no-implied-eval`,
`typescript/no-unnecessary-type-arguments`, React default-prop rules,
unmodified-loop conditions, and the remaining performance rules. Their current
output is bounded and points to potentially meaningful improvements.

`unicorn/prefer-add-event-listener` remains advisory for shared DOM targets. It
is disabled only in the named FileReader, IndexedDB, Animation, and MessagePort
adapters that exclusively own a fresh target's one handler slot and explicitly
replace or clear it. Test-only constructor/nominal class fixtures disable
`typescript/no-extraneous-class`; `src/renderer/env.d.ts` disables
`unicorn/require-module-specifiers` because `export {}` is its required module
marker. One-shot test Provider fixtures also disable
`react/jsx-no-constructed-context-values`; production providers retain the
referential-identity gate.

`unicorn/require-post-message-target-origin` also remains advisory for real
`Window.postMessage` calls, but is disabled in the Git worker, worktree worker,
and MCP App MessagePort adapters. Those APIs use Worker/MessagePort transfer-list
overloads and do not accept a target origin.

## Error contracts

Every explicit error must identify an owning invariant and an actionable
replacement. If a legitimate pattern cannot satisfy the rule, first narrow the
rule scope or add an app-owned boundary; use an inline disable only for an
isolated exception and state why.

| Rules                                                                                                                                                                                                                      | Scope and invariant                                  | Remediation                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint/no-extra-boolean-cast`, `eslint/no-unreachable`, `eslint/no-unsafe-finally`, `eslint/no-unsafe-optional-chaining`, `oxc/const-comparisons`, `typescript/no-misused-spread`, `typescript/no-unsafe-enum-comparison` | Repository-wide high-confidence correctness failures | Rewrite the control flow or operation so its runtime and type behavior are explicit. Tests may opt out of the two unsafe rules when probing nullable/failure behavior.    |
| `eslint/preserve-caught-error`                                                                                                                                                                                             | Repository-wide causal error chains                  | Wrap failures with `{ cause: error }`; use `AggregateError` when primary and cleanup failures must both remain inspectable.                                               |
| `typescript/no-floating-promises`                                                                                                                                                                                          | Repository-wide async ownership                      | Await the Promise, return it, attach an intentional rejection handler, or use explicit `void` only when the lifecycle is intentionally detached.                          |
| `typescript/require-array-sort-compare`                                                                                                                                                                                    | Repository-wide deterministic ordering               | Supply a comparator that expresses numeric, lexical, timestamp, rank, or domain order.                                                                                    |
| `nodex/no-manual-effect-runtime-in-tests`                                                                                                                                                                                  | Effect tests                                         | Use `@effect/vitest` and its managed test runtime instead of `Effect.runPromise` or `ManagedRuntime.make`.                                                                |
| `nodex/no-ambient-profile-authority`                                                                                                                                                                                       | Main Profile settings modules                        | Consume the immutable settings path and environment snapshot from `MainConfig`; never rediscover them from the OS home, current directory, or mutable process globals.    |
| `nodex/no-native-title-tooltip`                                                                                                                                                                                            | Intrinsic JSX elements                               | Use `NodexTooltip` or an app-owned primitive with a `tooltip` prop; native `title` timing and styling are not product UI.                                                 |
| `@tanstack/query/*` rules in `tanstackQueryRules`                                                                                                                                                                          | TanStack Query consumers                             | Use stable clients/dependencies, preserve option ordering, avoid rest destructuring, and return a real query value.                                                       |
| `no-restricted-imports`                                                                                                                                                                                                    | Renderer and renderer tests                          | Import app-owned context menus/icons, and import the owning block-document module directly in tests. The app-owned implementation modules are the scoped escape boundary. |
| `react/exhaustive-deps`, `react/rules-of-hooks`                                                                                                                                                                            | Renderer                                             | Preserve Hook call order and declare every reactive dependency; move non-reactive work behind the appropriate event or owner boundary.                                    |
| `react/iframe-missing-sandbox`                                                                                                                                                                                             | Renderer embedded documents                          | Add the narrowest functional iframe sandbox and verify the embedded document in Electron; never grant capabilities merely to silence the rule.                            |
| `react/jsx-no-constructed-context-values`                                                                                                                                                                                  | Renderer Context providers                           | Reuse a static value or memoize the provider contract from its primitive dependencies so consumers do not observe false identity changes.                                 |
| `react/no-unstable-nested-components`                                                                                                                                                                                      | Renderer reconciliation identity                     | Never create a component type during another component's render. Data-bearing render-prop callbacks are allowed because their receiving owner controls lazy invocation.   |
| `react/only-export-components`                                                                                                                                                                                             | Workbench Fast Refresh boundaries                    | Keep component exports separate from non-component values, or move shared values to an owning helper module.                                                              |
| `better-tailwindcss/no-conflicting-classes`, `better-tailwindcss/no-unknown-classes`                                                                                                                                       | Opt-in Tailwind repair command                       | Resolve conflicting utilities or use the documented app-owned class namespace. The plugin remains opt-in because its complete analysis is materially heavier.             |

The Effect recommended preset is scoped to the Main Effect control plane and
app-owned adapters. Its error rules guard invalid Effect types and control flow:
`class-self-mismatch`, `effect-fn-implicit-any`, `floating-effect`,
`floating-effect-in-vitest`, `missing-effect-context`, `missing-effect-error`,
`missing-layer-context`, `missing-return-yield-star`,
`missing-star-in-yield-effect-gen`, `non-object-effect-service-type`,
`overridden-schema-constructor`, `schema-literal-non-finite`, and
`schema-opaque-instance-member`. Follow the rule's Effect-aware diagnostic;
Node/platform access belongs in `src/main/platform`, the companion protocol package's internal
platform seam, or an explicitly allowlisted process entry. Only those frontiers disable the two
intentional warnings (`global-random` and `node-builtin-import`).

## Maintenance

After upgrading Vite+, Oxlint, TypeScript, or `@effect/tsgo`:

1. Run `vp lint --report-unused-disable-directives --format json` and group new
   warnings by rule and runtime.
2. Keep a new warning when samples are actionable and the output remains
   bounded. Do not promote it merely because it is new.
3. Disable a heuristic only after representative samples show an accepted Nodex
   pattern or consistently non-actionable output, and record the reason above.
4. Promote a rule to error only after fixing existing violations and documenting
   its invariant, scope, remediation, and escape boundary.
5. Add a focused `tooling:verify` fixture for every Nodex-owned rule or gate
   behavior. Do not create a warning-count baseline.
