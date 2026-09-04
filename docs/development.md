# Development

This document keeps contributor setup and local validation details out of the public README.

## Setup

Install the [Vite+ CLI](https://viteplus.dev/guide/install) once, then install
dependencies from the repository root:

```bash
vp install --frozen-lockfile
```

Nodex pins Node `24.15.0` in `.node-version` and pnpm `11.11.0` in
`package.json`; Vite+ resolves both declarations for the project. The exact
`vite-plus` development dependency pins the project toolchain independently of
the globally installed launcher version.

The install lifecycle runs `electron-builder install-app-deps`, which rebuilds
`node-pty` for Electron. Do not run `vp rebuild` for it: that can replace the
Electron-compatible binary with a host-Node binary. SQLite and collaborative
Document authority are native Rust code and do not use a Node addon.

### Machine-local artifact cache

Pinned Browser, Agent, and Sparkle archives are downloaded into
`<worktree>/cache.local/`. Each archive is addressed by its locked SHA-256,
verified before use, and published atomically under a cross-process download
lock. Extracted runtimes, native builds, and other source-derived outputs remain
isolated under each worktree's `.generated/` directory.

Developers with several local worktrees should keep the real cache in the
primary checkout and link every other worktree to it:

```bash
ln -s /absolute/path/to/primary/cache.local /absolute/path/to/worktree/cache.local
```

The `*.local` ignore rule excludes both the real directory and these links from
Git. The cache contains no source of truth or credentials and may be deleted at
any time; the next materialization verifies or downloads the required archives
again. Do not place `.generated` outputs, test Profiles, logs, or release
artifacts in `cache.local`.

Start the desktop app in development mode:

```bash
vp run dev
```

`vp run dev` is the single manual real-app launcher. It starts the HMR app by
default and accepts options directly, without an intermediate `--`:

```bash
vp run dev --home runs.local/perf
vp run dev --seed board/dense
vp run dev --home runs.local/perf --build
vp run dev --home runs.local/ephemeral --delete
vp run dev --auth-json /path/to/auth.json
vp run dev --agent-config-toml /path/to/config.toml
vp run dev --remote-debugging-port 9229
vp run dev --cdp 9229
vp run dev --enable runtime-metrics
vp run dev --enable database-page-reorder-menu
```

Unpackaged Desktop startup fails when `NODEX_HOME` is absent. Do not invoke the
underlying Electron or electron-vite entrypoints directly; the launcher owns
Profile isolation and supplies the required environment.

The default environment root is `<worktree>/runs.local/default`. Relative
`--home` paths resolve from the worktree root. Each environment has this layout:

```text
<home>/
├── dev-home.json
├── .nodex/                 # NODEX_HOME
│   └── agent/              # CODEX_HOME
├── workspace/              # NODEX_INITIAL_PROJECTS_DIR
└── artifacts/
```

The manifest binds the environment to this repository with a canonical UUID.
The launcher rejects a directory without that ownership manifest, another
repository's environment, a symlinked root, a concurrent launcher lease, or a
Core socket path that exceeds the macOS Unix-domain socket budget.

`--auth-json` atomically installs only the named authentication file with mode
`0600`. `--agent-config-toml` passes the named file through the portable agent
config sanitizer and also installs it with mode `0600`. Omitted flags preserve
the environment's existing files.

`--enable` is repeatable and applies a Nodex feature only to the current
invocation. Unknown slugs fail and list the catalog. Currently
`runtime-metrics` enables structured development runtime metrics.
`database-page-reorder-menu` shows the position-only `Reorder` submenu in a
Database Page context menu; it does not gate `Move to`, drag ordering, keyboard
ordering, or bulk ordering. Both features default off. Agent/app-server
features remain owned by `config.toml`. The former Library workspace and
Calendar presentation gates were retired with those product surfaces, so they
are intentionally not accepted as launcher aliases.

`--build` builds optimized release Core, CLI, and Browser Profile Helper binaries plus the
Electron application before launching without HMR. The launcher uses those
release artifacts throughout the application runtime and uses the release Core
during seed initialization. Without it, the launcher prepares
development-profile native binaries and generated resources, then starts
electron-vite with HMR. Both modes default to an operating-system assigned
DevTools port so different homes can run concurrently. Pass
`--remote-debugging-port <port>` or its `--cdp <port>` alias with an integer from
`0` through `65535` when a stable endpoint is needed. The command-line option
overrides `NODEX_REMOTE_DEBUGGING_PORT` when both are set.

The production build remains fail-closed. It hashes the Electron input closure,
build context, generated resources, and exact `out/` inventory. Packaging and
installation verify the prepared build through the same internal module;
prepared-build reuse is not a manual launcher option.

Desktop process isolation is keyed by `.nodex`. Different homes get independent
Electron storage, process locks, Core sockets and capabilities, databases,
assets, backups, and logs. The launcher holds an exclusive environment lease,
keeps the application under a dedicated process group, and gracefully stops the
authenticated Core generation before releasing the lease. Interrupts use
bounded process-group termination; the detached Core is selected by identity,
not killed by a broad signal.

`--delete` removes the whole environment only after the process group exits,
the exact Core generation stops, the lease is released, and runtime evidence is
absent. Unsafe cleanup preserves the environment and exits nonzero.

### Seeded development environments

Authoritative scenario recipes create current-schema product data through public
Core operations. `--seed <id>` applies a recipe only while initializing a new
environment and before Electron starts. `board/dense` creates a Project with
five workflow columns, ten Pages, and structured NFM content:

```bash
vp run dev --home runs.local/board-dense --seed board/dense
```

The manifest records the seed id and revision. Reopening the same home with the
same seed is a no-op and prints its provenance. A different seed, or a seed for
a home already initialized without one, fails. Later manual edits belong to the
environment and are not reset or compared with the original recipe.

The catalog is shared by Core integration and Electron E2E tests. Deterministic
UI behavior belongs in a dedicated Playwright spec such as
`tests/e2e/board-dense.spec.ts`; `vp run dev --seed ...` never starts
Playwright, focuses a Page, or performs assertions.

### Real Profile snapshots

Some defects and performance cliffs only appear with real document shapes,
long histories, managed assets, or a production-sized Store. For that evidence,
clone a published backup into a dedicated `runs.local` environment:

```bash
nodex backup create --label "before local validation"
vp run dev --home runs.local/real-profile --from-profile ~/.nodex
```

`--from-profile` never starts Core against the source Profile and never copies a
live SQLite/WAL pair. The native Core validates the latest assets-inclusive
published backup, copies its database and managed assets into a private sibling
staging directory, preserves the imported Store epoch, remints instance
secrets, verifies the database and deterministic asset-tree digests recorded
after backup integrity validation, performs clone-specific semantic checks, and
only then publishes `<home>/.nodex` atomically. Same-volume macOS copies prefer
APFS copy-on-write. Preserving the imported lineage and reusing published
integrity evidence avoid replaying LocalCommit history or rescanning every
SQLite page during provisioning. Existing dangling asset references are
preserved as part of the real production state and reported by count instead of
being silently repaired or replaced with synthetic files. Select a specific
current backup with `--backup <backup-id>` when reproducibility matters; create
a fresh backup first when the Profile has only an older manifest.

The cloned environment is a normal local development Profile: the app, Agent,
Terminal, Git, browser, and HMR behave normally against it. Backup contents do
not include `CODEX_HOME` credentials. Add `--auth-json` or
`--agent-config-toml` explicitly only when the validation requires those
capabilities. Remote observability is disabled for a `--from-profile` launch so
user content remains local by default.

The snapshot is a detached local fork, not a branch that can be merged back.
Its Store epoch and historical coordinates intentionally match the imported
backup; new local history may diverge at the same coordinates and must never be
replayed, synchronized, or exported into the source Profile.

`dev-home.json` and `.nodex/profile-snapshot.json` record immutable backup and
Store provenance. Reopen the environment with the same command or omit
`--from-profile`; later edits are preserved. Use another `--home`, or delete the
old environment after a clean stop, to test a newer backup.

Profile snapshots are local exploratory and production-shape evidence. They
must not run in CI, be committed, or produce uploaded screenshots, traces,
databases, assets, or logs containing user content. Convert any durable finding
into the smallest deterministic scenario or focused regression test that proves
the behavior without private data.

Build the app:

```bash
vp run build
```

Package local macOS installers:

```bash
vp run package
```

## Validation

Choose validation from the changed runtime and risk. For broad TypeScript work:

```bash
vp run check
vp run test
```

For a bounded change, run its focused suite and `vp run typecheck`; formatting
can be checked separately with `vp run fmt:check`. `vp run verify:source` is the
explicit full source gate, including Rust, stress, browser, and static contracts.
It is not required after every local edit.

Vite+ is the repository engineering control plane. `check:semantic`, `typecheck`,
and `lint` all execute `vp check --no-fmt`, including TypeScript 7, typed Oxlint,
and Effect diagnostics. They share the same task-result cache. `check` composes
`vp fmt --check` with that same semantic command. CI uses the same entrypoint and
policy. To measure actual analysis, use `vp run --no-cache check:semantic`; the
run option must precede the task name.
`correctness`, `suspicious`, and `perf` diagnostics are advisory warnings: keep
them visible and improve nearby code when useful, but do not treat the warning
count as an acceptance condition. Type errors, lint errors, and precise
project-owned contract errors still block the command. Unused suppression comments are advisory in every semantic entrypoint.
`vp run check`, `vp run check:semantic`, `vp run typecheck`, `vp run lint`, and `vp run fmt:check` are
deterministic root tasks with automatic input tracking and no restorable output.
They cache successful local validation without enabling cache replay for the
repository's side-effectful package scripts. `vp run typecheck` follows the same
integrated semantic path without formatting; it is deliberately not a
lint-bypassing type-only authority.

CI's typed static matrix runs `vp run check` in the `types` lane and routes the
remaining selected lanes through `verify-static.ts`. `vp run verify:static` is
the local composition of the same integrated check and repository contracts.

The complete severity rationale, scoped overrides, remediation paths, and
upgrade review process live in [Lint governance](LINTING.md).

### Working on Effect Main modules

The repository-installed Effect version is the API authority. Before changing
an Effect application Module:

1. Read [ADR 0048](adr/0048-effect-main-application-kernel.md) and the nearest
   production capability and semantic tests. Nodex's authority and dependency
   boundaries take precedence over a generic library example.
2. Read `node_modules/effect/AGENTS.md` completely, plus the `AGENTS.md` of any
   installed companion package being used, such as
   `node_modules/@effect/vitest/AGENTS.md`.
3. Search `node_modules/effect/ai-docs/src` for the relevant service, resource,
   concurrency, Stream, Schedule, or testing topic, then verify the exact API
   and semantics in `node_modules/effect/src` or the companion package's
   installed `src` directory. Context7, web documentation, and Effect `main`
   are secondary references and must not override the installed version.

Effect behavior tests use `@effect/vitest`. Prefer `it.effect` so the managed
test runtime supplies Scope and test services; use `layer(...)` or nested
`it.layer(...)` when the public capability requires a Layer and its acquisition
and release are part of the contract. A shared `layer(...)` block intentionally
shares its service instance between tests; use it for safe shared fixtures, reset
mutable test state explicitly, or provide a per-test Layer when isolation is the
contract. Import `TestClock` from `effect/testing` for
deadlines, retries, schedules, and sleeps: fork the waiting Effect, advance the
virtual clock, and observe its semantic result. Reserve `it.live` for an
intentional real-runtime integration boundary.

Do not construct a manual Effect runtime or Scope in an application unit test,
and do not replace lifecycle behavior with real sleeps or Promise-shaped test
facades. Test the final capability's admission, interruption, generation fence,
and release semantics. Run the nearest runtime-specific test command while
iterating, then the normal typecheck and Effect-boundary gate for changed Main
source.

`config/test-suites.ts` owns runtime, tier, file selection, and native
prerequisites. The thin `scripts/testing/run-tests.ts` entrypoint consumes that
catalog for aggregate, focused, related, and standalone execution. Every run is
uncached. The standard aggregate runs unit, effect-codex, core-client, Main,
renderer, and integration serially; Chromium remains an explicit browser gate.
Main and integration run Vitest under Electron so native addons use its ABI.
Renderer uses up to four workers in CI, and locally on machines with at least
8 available CPUs and 24 GiB total memory; smaller local machines use up to two.
The budget never exceeds available CPUs. Stress stays at one worker, file
isolation stays enabled, and suites do not compete through aggregate parallelism.

Before execution, the aggregate prepares its union of required Cargo targets
once. Standalone native suites prepare themselves. Cargo checks freshness and
returns the executable paths, including when `CARGO_TARGET_DIR` is customized.
Bridge tests run the prepared executable directly; test bodies never invoke
Cargo. Reuse binaries, but always create fresh writable Profiles and stores.
Cancellation terminates only this command's descendants, including detached Core
authorities; it does not manage other app instances or working trees.

Contributors and automation use the installed `vp` command. GitHub Actions
acquire the package.json-pinned version through `setup-vite-plus` and execute
`vp install`, `vp run`, and `vp exec` directly.

Owned package scripts compose other scripts through `vp run` and resolve local
binaries through Vite Task’s workspace PATH. Direct shell invocations use
`vp exec`; neither path calls `pnpm` directly.
This keeps nested work visible to the same Vite Task graph without changing the
deliberately uncached policy for side-effectful package scripts. `vp run
tooling:verify` enforces that manifest boundary.

The test commands follow production boundaries:

- `vp run test` runs the ordinary deterministic test tier across the Node, main,
  renderer, and integration runtimes.
- `vp run test:unit` runs pure shared, script, configuration, and renderer helper
  logic in Node. Under `src/renderer`, ordinary `.test.ts` files run in Node by
  default; use `.node.test.tsx` when a pure test needs TSX syntax.
- `vp run test:core-client` builds the development Core binary, then runs the
  host Node `src/main/**/*.node.test.ts` contracts and the Yjs/Yrs bridge. This is
  also the owner for new Main application directories. Stateful tests seed
  disposable Stores only through public Core APIs.
- `vp run test:effect-codex` runs the companion app-server package contracts.
- `vp run test:main` runs Electron main-process adapter and host tests.
- `vp run test:renderer` runs ordinary `.test.tsx` React behavior and explicit
  `.jsdom.test.ts` DOM behavior in jsdom. A `.test.ts` file must not rely on
  browser globals implicitly.
- `vp run test:browser` runs browser-sensitive renderer contracts in Chromium.
- `vp run test:integration` runs integration tests in Electron's Node runtime.
- `vp run test:stress` runs every catalogued stress owner, including core-client,
  one worker at a time, independently of the ordinary suite.
- `vp run verify:test-inventory` compares independent repository enumeration with
  Vitest discovery in each actual runtime. Duplicates, unowned files, omitted
  collection, and wrong tiers fail the gate. Nightly and release certification
  validate their full suite lists against the same catalog.
- `vp run test:complete` runs both ordinary and stress tiers without the
  full Electron end-to-end suite.
- `vp run test:performance` runs Core runtime and scale gates below Electron.
  Run it manually on a stable machine; the same lower-level contracts run in
  weekly Performance CI.
- `vp run core:fmt`, `vp run core:clippy`, and the Core test tiers validate
  the native authority. `vp run core:test:pr` is the fast CI tier (nextest
  plus doctests); `vp run core:test:full` adds migration compatibility, and
  `vp run core:test:nightly` runs every explicitly named ignored scale,
  performance, and reliability gate. `vp run core:test`
  remains the complete local/source-verification alias.
- `vp run core:protocol:verify` and `vp run core:module-boundaries` verify generated contracts and the Rust-only production boundary.
- Core protocol generation runs `openapi-typescript` inside `packages/core-protocol-codegen`, where its officially supported TypeScript 5 compiler runtime is pinned. That package is a generator implementation detail; TypeScript 7 remains the only repository source checker and semantic authority.
- `vp run tooling:verify` also proves that Vite+ can load the complete workspace metadata graph while keeping third-party packages outside root task execution. Keep dependencies imported by workspace-local Vite configs resolvable even when those packages are not selected by `vp run`.
- `vp run verify:effect-boundaries` keeps Effect inside the Main/script control plane, generated/shared/renderer contracts Effect-free, unstable APIs inside app-owned adapters, and runtime execution at approved composition/facade seams. Lifecycle tests use fake capabilities or `@effect/vitest` TestClock instead of real retry or escalation sleeps.
- `vp run test:e2e` rebuilds the native Core plus Electron application, then
  exercises the complete Electron/preload/IPC/Core chain. Do not invoke the
  Playwright config directly after changing Rust authority code; that can run
  against a stale `target/debug/nodex-core` binary.
  Electron E2E is retained for deliberate local/agent diagnostics and is not
  invoked by PR, Main, Nightly, Performance, or release-certification workflows.
- Real subscription-backed Agent canaries use the dedicated, single-case
  [`agent:smoke:paid` runner](paid-agent-smoke.md). The explicit command is the
  quota authorization; it fixes one worker, disables retries, copies only auth
  into a disposable Profile, and records sanitized evidence.
  Ordinary Electron E2E remains deterministic and never consumes Agent quota.

Seeded fixtures have four distinct evidence classes:

- An authoritative scenario recipe uses public Core operations and proves the normal create, mutate, and read path.
  Use it for seeded development homes, product-path Electron E2E, and Core integration correctness.
- A materialized current-schema snapshot, when profiling justifies one, is an immutable cache generated from an authoritative recipe and copied into a fresh writable Profile per test.
  It proves read/startup behavior, not creation.
- A historical or corrupt storage fixture deliberately represents an old or invalid Store for migration, repair, rollback, or corruption tests.
  Direct storage construction is valid only because that storage shape is under test.
- A pressure fixture may use controlled synthetic materialization for scale or convergence evidence.
  Pair it with a small authoritative operation-path test and do not register it as an ordinary UI scenario.

Never share a writable seeded Store between tests.
Add a snapshot cache only after measurement shows live authoritative materialization is a meaningful bottleneck; `board/dense` remains live-seeded in the initial implementation.

### Measuring engineering feedback

Use one complete semantic entrypoint after editing; `typecheck`, `lint`, and
`check:semantic` share both implementation and task-result cache. During iteration,
choose a focused or related suite with direct additional arguments:

```bash
vp run test:core-client src/shared/block-documents/yjs-yrs-conformance.test.ts
vp run test:renderer src/renderer/components/board/canvas-view.test.tsx
vp run test:renderer:related src/renderer/components/board/canvas-view.tsx
vp run test:integration src/main/rust-data-authority.integration.ts
```

`tooling:benchmark` writes machine/tool/source identity, dependency-lock fingerprint, load, exit status,
per-file diagnostics and monotonic command timings beneath
`notes.local/tooling-performance/`. POSIX benchmark commands also sample this
command's descendant RSS every second; this is a sampled sum, not an exact
allocation peak. Sampling is asynchronous, non-overlapping, and bounded to one
second; unavailable samples never delay command output or completion. Suite
phases are cumulative across workers and cannot be added
to obtain wall time. The comparison includes removed/added cases and duplicate
executions so coverage changes stay visible next to the observed timing ratio.
Different dependency locks suppress the ratio; a missing fingerprint in legacy
evidence is reported as unknown and requires checking the recorded source revisions.

```bash
vp run tooling:benchmark --scenario static-cache-hit --label after --samples 3
vp run tooling:benchmark --scenario semantic-execute --label after --samples 3
vp run tooling:benchmark --scenario renderer-cohort --workers 2 --label workers-2 --samples 3
vp run tooling:benchmark --scenario renderer-cohort --workers 4 --label workers-4 --samples 3
vp run tooling:benchmark --scenario tests-warm --label after --samples 3
vp run tooling:benchmark --scenario tests-cold-native --label cold --samples 1
vp run tooling:benchmark --compare <before-directory> <after-directory>
```

`static-cache-hit` primes the successful task outside its measured samples.
`semantic-execute` bypasses task replay. Test scenarios always execute tests;
`tests-cold-native` allocates a fresh, recorded `CARGO_TARGET_DIR` under
`.generated/` without clearing global caches. Native preparation is reported
separately and Cargo retains responsibility for freshness. Keep before/after
samples sequential, record competing load, and report three samples as a range
and median, not p95.

The experimental Vitest filesystem module cache remains disabled: the measured
cohort benefit was below the 10% adoption threshold. It caches transforms only,
not isolated module instances, environments or test results.

Set `NODEX_TEST_TIMINGS=<directory>` on a focused suite to record diagnostics.
For an import investigation, add Vitest 4's
`--experimental.importDurations.limit=20`; omit profiling from timing comparisons.
Application and stress CI jobs upload the same per-file/native/suite records on
success or failure, and static jobs upload command timings. Reusable workflows
record the checked-out source SHA, including an explicit source override. The timing reporter
retains React `act` warnings and rejects that sample even if Vitest's individual
tests passed. Fix missing awaited interaction/subscription boundaries instead
of accepting or silencing these warnings. Compare trends only
within the same runner/toolchain/scope; ordinary CI does not run repeated full
benchmarks or enforce a noisy universal wall-time threshold.

### Block drag-and-drop smoke

The Electron test named `moves a Block into a Board with native DnD
@dnd-smoke` exercises the real BlockNote handle and browser drag pipeline. Run
it after building the development Core and Electron bundle:

```bash
vp run core:build:dev
vp run build
vp exec playwright test --config playwright.e2e.config.ts --grep "@dnd-smoke"
```

Its `dragBlockToBoardWithMouse` helper remains in
`tests/e2e/electron-smoke.spec.ts` while it has one caller; move it to
`tests/e2e/support/nodex-block-dnd.ts` only when a second test reuses it. The
helper hovers the source Block, waits for the dynamic handle, presses the mouse,
moves about 12 pixels to activate native dragging, travels to the Board in many
steps, moves twice more inside the target, and releases. The final extra move is
required because the first target move may emit only `dragenter`; pages that
accept a drop in `dragover` need a subsequent move.

`locator.drop` creates a target-side synthetic `DataTransfer` and is useful for
external-payload contracts, but it does not prove the native source gesture.
Likewise, cross-tab high-pressure tests that call `blocks:transfer` directly
prove the Core transaction and renderer convergence, not the drag handle or
browser event pipeline.

When this smoke fails, follow the first missing boundary: no `dragstart` means
inspect handle visibility, remounts, activation distance, draggable state, and
overlays; `dragstart` without Nodex MIME means inspect the source callback; MIME
without `dragover` means inspect the stepped path and hit target; a completed
drop without UI convergence means inspect Core, LocalCommit, and projection
delivery. After changing either the helper or DnD runtime, require ten clean
isolated runs without gesture retries:

```bash
vp exec playwright test --config playwright.e2e.config.ts \
  --grep "@dnd-smoke" --repeat-each=10
```

Use the `.stress.` filename segment for a test that intentionally exercises
high volume, repeated lifecycle work, concurrent calls, or resource pressure:

```text
feature.stress.test.tsx
feature.stress.node.test.ts
feature.stress.integration.ts
feature.stress.browser.test.tsx
```

Keep a test in the ordinary tier when a single oversized input validates a
product boundary cheaply and deterministically. Move a case into the stress
tier when its scale or concurrency is the behavior under test. Keep
hardware-dependent timing and memory thresholds in explicit benchmark or
performance commands instead of either Vitest tier.

The native Core has the same separation. `cargo test -p nodex-core` excludes
tests marked as explicit scale or exhaustive compatibility gates. Repository
Cargo configuration defaults the I/O-heavy SQLite suite to two test threads;
an explicit libtest argument can override that default when profiling:

```bash
cargo test -p nodex-core -- --test-threads=2
```

Ordinary semantic tests clone an isolated current-schema Store template. Fresh
Store creation, exact-schema validation, upgrades, recovery, and profile-secret
generation retain dedicated tests against the real startup path.

Run `vp run core:test:nightly` when changing Canvas incremental storage,
large-data reliability, or relation projection boundaries. Store preparation
and supported-baseline migration changes belong in `core:test:migration` and
the ordinary workspace suite. `vp run core:test` includes both the full and
nightly tiers for final source verification.

Use the matching runtime when running one test file:

```bash
# Pure Node/shared logic
vp test run --config vitest.node.config.ts <test-file>

# Core client and adapter behavior
vp run test:core-client <test-file>

# Renderer/jsdom behavior
vp test run --config vitest.renderer.config.ts <test-file>

# Electron main process, local store, and native addons
vp run test:main <test-file>

# Electron integration behavior
vp run test:integration <test-file>

# A specific stress test in its owning runtime
NODEX_TEST_TIER=stress vp run test:renderer <stress-test-file>
```

Do not run `vitest.main.config.ts` or `vitest.integration.config.ts` directly.
Those configs fail fast outside Electron so that host Node cannot reach an
Electron-built native addon.

During implementation, run the narrow ordinary or stress test file affected by
the change. Run `verify:source` once after a broad final edit set is stable; it
includes the stress tier and browser suite, but not the opt-in Electron E2E
diagnostic. On macOS, release/runtime changes additionally run:

```bash
vp run verify:runtime:mac
```

`vp run test:all` remains a compatibility alias for `verify:source`; neither
command proves Apple signing, notarization, or native Intel behavior. Use the
production-like `Distribution Rehearsal` described in `release-macos.md` for
that boundary.

## Native Addon ABI Errors

Electron and the host Node executable can report the same Node version while
using different native module ABIs. `node-pty` therefore must be loaded by the
runtime it was rebuilt for. An error containing
`compiled against a different Node.js version` or mismatched
`NODE_MODULE_VERSION` values usually means the wrong runtime launched the code;
it does not necessarily mean dependencies are stale.

First, rerun the operation through the repository command that owns its runtime.
For a main/store test, use `vp run test:main <test-file>`; for an integration
test, use `vp run test:integration <test-file>`. Reinstalling is unnecessary
when the failing command invoked either Electron Vitest config directly.

If a host-Node rebuild already replaced the native binaries, restore the
repository's Electron target from the repository root:

```bash
vp exec electron-builder install-app-deps
```

To diagnose an unfamiliar environment, compare the runtime-reported ABIs:

```bash
node -p "process.versions.modules"
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p "process.versions.modules"
```

Different values are expected. Do not try to make one `node-pty` binary serve
both runtimes; keep native-addon work on Electron-owned test and application
paths. Rust Core tests and binaries are independent of this Node ABI boundary.

## Related Technical Docs

- [Architecture](ARCHITECTURE.md)
- [Lint governance](LINTING.md)
- [Engineering learnings](ENGINEERING_LEARNINGS.md)
- [Product specification](product-specs/nodex-product-spec.md)
- [Cross-feature frontend engineering conventions](FRONTEND.md)
- [Reliability model](RELIABILITY.md)
- [Security model](SECURITY.md)
- [macOS release CI](release-macos.md)
- [Landing site operations](landing-site.md)
- [CI architecture and tier ownership](CI.md)
