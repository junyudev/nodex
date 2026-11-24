# Continuous integration

Nodex separates merge feedback, deterministic reliability coverage, scale
signals, and release certification. A test belongs to the cheapest layer that
can prove its contract; a curated Electron Playwright set covers core product
workflows in Nightly CI, with the full suite available for local diagnostics.

## Workflow tiers

- `.github/workflows/ci-main.yml` verifies landed changes after the fast local
  check. It selects static groups, application suites, affected Rust crates,
  protocol and Store migration contracts, and native Windows x64 coverage from
  the newest green Main CI ancestor to the tested `main` commit. One push run
  stays active while GitHub keeps the newest push pending. Comparing against
  the last green commit covers intervening changes even when a pending run is
  replaced. Main CI runs the full plan when it cannot find a trusted green
  ancestor. Manual runs have independent concurrency groups.
- `.github/workflows/ci.yml` offers the same selected gates on optional pull
  requests and merge groups, with `required` as their aggregate result.
  Pull requests compare against their PR base. Merge groups compare
  `base_sha` and `head_sha` to cover combined changes. New PR updates supersede
  earlier runs for that PR. Each merge group has its own concurrency key.
  Drafts without `ci:full` select only relevant source-ownership and CI
  contracts. The run summary marks the reduced plan. Marking the PR ready or
  adding `ci:full` reruns classification with the ordinary selection.
- `.github/workflows/ci-nightly.yml` runs every deterministic static and Rust
  gate, and all default application suites including browser on Linux and
  standard `macos-26`. Two macOS application suites can run at once, leaving
  three macOS slots for stress, runtime contracts, and curated Electron E2E.
  The `nightly complete` aggregate requires all of these jobs. Paid-agent and
  UI performance tests remain excluded.
- `.github/workflows/codeql.yml` scans GitHub Actions, JavaScript/TypeScript and
  Rust weekly and on manual dispatch, so security scanning never competes with
  verification for runner slots. CodeQL default setup stays off; GitHub rejects
  this workflow's uploads while it is on.
- `.github/workflows/performance.yml` is the weekly owner for Core runtime
  benchmarks and explicitly ignored scale contracts. Performance regressions
  are diagnosed below Electron rather than through UI timings.
- `_certify-release-source.yml` runs the full deterministic source and runtime
  gates for an exact release SHA without signing secrets. Its `release-source`
  environment and shared protected-main guard dominate every reusable consumer
  before the SHA is checked out or executed. It issues a SHA-and-tree-bound
  certificate. Nightly and Rehearsal distributions refuse to
  build unless that certificate matches the checked out Git tree.
- `_macos-distribution.yml` owns signing, notarization, packaged CLI/Core
  probes, application startup, architecture bundles, and certificate
  propagation. The packaged startup probe requires a valid Core descriptor;
  merely keeping an Electron process alive is not sufficient.
- `_windows-distribution.yml` owns both native Windows installer builds and the
  installed-app startup/upgrade/uninstall probes. Official callers require the
  same source certificate and identity as macOS. All three architectures must
  succeed before protected signing, Bundle assembly, and promotion.

Nightly certification supplies exhaustive exact-SHA evidence. Stable promotion
verifies the published Nightly and reuses its build outputs. Main CI checks that
source version surfaces agree and that `CHANGELOG.md` and the change files under
`changes/` are well formed.

Every aggregate gate fails closed: a selected job must succeed; skipped,
cancelled, missing, and failed results are rejected. Manual PR/Main dispatch
can request full deterministic source coverage, but still cannot select
Electron E2E, stress, performance, or macOS runtime in the merge loop.

## Main CI verdict

The `main complete` summary and the `main-ci-verdict` artifact carry the same
JSON. Version 1 contains `runId`, `runAttempt`, `status` (`success` or `failure`),
`range`, `commits` (oldest first, each with `sha`, `subject`, and Git `author`), `failingGates`
(each with `id` and `result`), and `failingJobs` (each with `name`, `result`,
`url`, `failedSteps`, and `failedTests`). Read the named artifact from the
current run attempt. It is replaced on reruns.

A `range` has `baseSha`, `headSha` and `basis`. Use `last-green` for complete
range attribution. When GitHub history cannot identify a trusted base,
`push-before` records the available push range, or `head-only` records just
the tested commit. Both fallbacks trigger full verification. Use the range
basis before routing failures automatically. A null `failingJobs` or
`failedTests` means GitHub evidence could not be read. An empty list means
that no matching job or named test failure was found. Test names come from
recognized Vitest, Cargo and nextest failure lines.

### Red-main issue

When verification fails on a push to `main`, the aggregate job opens a
`main-ci-red` issue with the verdict and run link, creating the label as needed.
Further red runs add their verdicts to the open issue. A green push comments
with the verified commit and run, then closes the issue. Cancelled runs and
manual dispatches leave the issue alone. A new issue starts Nodex's fix-forward
automation. Only the aggregate job has issue-write permission.

## Windows tier

For Main CI, optional PRs, and merge groups, the classifier selects one x64 job for
changes to native Rust, Windows platform boundaries, process, path or shell
handling, packaged runtime and installer inputs, or the Windows workflows.
The job checks the native platform library, packaged runtime staging,
installer maintenance and Core named pipes, and Windows Desktop Tools under
Electron.

`.github/workflows/windows.yml` runs the Rust workspace and application unit,
Core-client, Main, renderer and integration suites on `windows-latest` (x64) and
`windows-11-arm` (arm64). The nightly schedule, `codex/windows-**` pushes, and
manual runs also build, silently install, and probe the unsigned NSIS
installers through the reusable Windows distribution, with updates disabled.
A manual run with `installer_run_id` re-probes its installers without rebuilding.
These jobs use no signing credentials and publish neither a Release nor an
update feed.

The packaged probe requires the exact Electron host's ready isolated-run claim,
a compatible Core descriptor with a named-pipe endpoint, the installed Core's
artifact digest, a successful authenticated Core handshake, and a completed Agent
Runtime execution handshake using verified standalone Node. The isolated probe
explicitly starts the otherwise lazy execution process without provider credentials.
Its bounded readiness record binds the exact host PID and isolated run ID and contains
only execution identity and Node provenance. Electron process
liveness alone cannot pass. It shuts down the owned Core generation, silently
uninstalls, and rejects remaining installation files, protocol registration or
shortcuts. Startup diagnostics remain a separate artifact from the installer.
See [the Windows release runbook](release-windows.md).

Test ownership, discovery and prerequisites live together in `config/test-suites.ts`.
The typed suite planner selects Rust setup; each suite prepares its own native
artifacts before execution. Main and integration use Electron's Node ABI on both
Windows CPUs and the runners' interactive desktop; Xvfb is Linux-only.

The native Rust setup verifies the MSVC host CPU and caches Cargo dependency
sources by runner architecture, toolchain and lockfile. Writable Cargo targets
remain independent per job; a dependency cache hit never substitutes for a build
or test. Application installs use the shared Vite+ dependency cache.

## Affected test selection

`CiGatePlan` owns both suite selection and one of three test modes:

- `none`: no application test suite is selected.
- `related`: source ownership selects suites related to safe, repository-relative
  changed paths. Renderer work normally selects `unit`, `renderer`, and `browser`;
  Main/Core/Shared paths select their runtime consumers.
- `full`: dependency, configuration, deleted-path, unknown, and explicit-full
  changes run every selected suite. Deleted paths fail closed because they
  cannot participate in Vitest's import graph.

Pre-merge and Main CI use the classifier to choose suites, then validate every
file in each selected suite through the test result cache. A file with missing,
changed, or unobservable inputs executes. Browser remains one Chromium unit.
Nightly and release certification execute their complete suites independently.

Linux CI splits unit, renderer, Core-client, and Agent Runtime into two shards
each by repository-relative file path. Adding a test does not move existing
files. The application matrix uses one job per selected suite on average.
Shards and shorter suites share jobs to stay within that budget on every
plan. Each selected shard must succeed independently of cache reuse.

The reusable application matrix owns `unit`, `effect-codex`, `agent-runtime`,
`core-client`, `main`, `renderer`, `integration`, and `browser`. Browser is a
Vitest suite with a managed Chromium prerequisite. Main and integration
continue to run through Electron's Node ABI so native addons are exercised by
the correct runtime. Application cells do not regenerate third-party notices or
other build resources; the generated static contract and real build/package
flows own those artifacts.

Browser contracts use Playwright's locked full Chromium through the `chromium`
channel in both headed and headless runs. The browser revision remains tied to
the lockfile; the system Chrome installation is not a prerequisite.

The Linux CI browser runner collects retired isolated test realms after each
completed file. Chromium can retain their shared-memory objects in anonymous
`memfd` storage, which the upstream `/tmp` free-space guard cannot observe.
The versioned Vitest patch makes `VITEST_CHROMIUM_GC_FORCE` bypass that disk guard;
the typed suite runner enables it only for Linux browser contracts. Collection
uses the existing CDP cleanup and remains best effort, with success or failure
visible in `vitest:browser:gc` diagnostics. Other suites and local browser
commands keep their normal environment.
When upgrading Vitest, preserve this cleanup contract or replace it with verified
upstream behavior, and inspect the uploaded live resource evidence.

Linux Chromium setup bounds system dependency installation to eight minutes.
Before a timed-out install may retry browser-only, its owned process groups,
including root-owned package-manager descendants, must stop. Cleanup uses
noninteractive `sudo` only for that installer and fails closed if ownership or
termination cannot be verified; cancellation errors never permit a fallback.
The browser suite still validates the installed Chromium and host libraries.

Browser CI records Playwright process and Vitest browser transport/provider
diagnostics, dependency optimization, and HMR through
`DEBUG=pw:browser,vitest:browser*,vite:deps,vite:hmr`. Passive CI listeners record
outer-page navigation, page/context closure, browser disconnection, and HTTP
server errors or closure. Session identity and page/browser state distinguish
these events from normal per-file iframe replacement; browser API disconnect
logs retain the WebSocket close code and reason. Failed Linux browser jobs also print
runner memory, filesystem space and inodes, and process RSS after failure.
Available cgroup counters also retain OOM events, peak memory and the memory limit.
The Linux browser job's existing one-second process sampler retains live shared
memory, mapped-region counts and kernel limits, and process-resource evidence in the uploaded timing artifact's
`*-browser-resources.jsonl` file.

CI implementation changes are routed by the same ownership rule. Ordinary
workflow orchestration runs CI contracts only; changing
`_app-tests.yml`, `_rust-checks.yml`, or `_static-checks.yml` additionally runs
the complete reusable owner it can affect. Changes confined to `scripts/ci`
run types, source ownership, CI contracts, and the Node unit suite. Unknown paths
still fail closed to every deterministic source gate.

Every TypeScript source or project configuration change selects the lightweight
`source-ownership` static group. It compares the actual compiler graphs with the
owned source inventory, so independently routed Landing changes
cannot introduce files outside their checker projects. Landing source changes
retain their own build and test owners alongside this check.

Documentation paths do not widen an accompanying executable change. A source,
dependency, or workflow edit with its owning documentation therefore receives
the same plan as the executable edit alone; docs-only and landing-plus-docs
remain explicit narrow plans.

Changed test files use the repository filename convention to select exactly one
owning suite. Explicit stress
files remain Nightly-owned. Vitest configuration, TypeScript project
configuration, lockfiles, CI orchestration, and deleted files promote selection
to `full`.

## Static jobs

The reusable workflow schedules types, UI contracts, and repository contracts
in separate Linux jobs. Selected source ownership, CI contracts, dependency
security, generated resources, and landing checks share one job and one
dependency install. Each group still reports its own command timing, and the
shared job fails if any selected check fails.

## Dependency security

The `dependency-security` static group runs `vp pm audit --level low` through the
repository's pinned package manager. It checks production, development, optional,
and transitive JavaScript dependencies. Changes to a workspace manifest, lockfile,
`pnpm-workspace.yaml`, or `.npmrc` select the required audit gate, including changes
that accompany application edits. A landing dependency manifest receives the same
dependency gates as the other workspace manifests.

Nightly CI and release certification run the audit again to catch newly disclosed
advisories in unchanged dependency versions. This check uses current registry data
and is not cached as a deterministic source check. Registry failures fail closed.
Accepted advisory policy belongs to [Security](SECURITY.md#dependency-maintenance).

## Rust lanes

`_rust-checks.yml` runs formatting, Clippy, nextest/Rustdoc, protocol
verification, and migration as independent jobs. Formatting remains
workspace-wide. For ordinary crate changes, Clippy and tests resolve the
directly changed workspace package plus every transitive reverse dependent
from `cargo metadata`. Root manifests, lockfiles, toolchains, unknown crate
paths, dependencies, explicit-full runs, nightly, and release certification
fail closed to the whole workspace.

Canonical local commands remain in `package.json`:

- `vp run core:test:pr`: workspace nextest plus Rustdoc contracts.
- `vp run core:test:migration`: supported Store baseline and convergence.
- `vp run core:test:scale`: explicitly named ignored scale contracts.
- `vp run core:test`: complete local Rust verification.

Every ignored Rust test is listed in `.config/ci/ignored-rust-tests.json` and
must have a direct package-script owner. `vp run
ci:verify-ignored-rust-tests` prevents silent drift.

## Electron E2E

`vp run test:e2e:nightly` rebuilds and runs individual cases tagged `@automatic`
in Nightly CI and locally. It uses one worker and excludes paid Agent and
performance cases. The job stages the locked runtime for scripted Agent tests,
retains failure traces and error contexts in `test-results/`, and uploads failure
diagnostics and command timings. See [development documentation](development.md)
for admission criteria and the [E2E triage table](../tests/e2e/TRIAGE.md) for other cases.

`vp run test:e2e` and `vp run test:e2e:performance` remain local diagnostics for
the production Electron/preload/Main/Core composition. PR, Main, Performance,
and release certification do not run Electron E2E.

The native PTY integration contract runs under Electron with a test-owned shell
home and startup file. It registers its observation before process creation,
checks a controlled startup gate, and waits for shell readiness before writing
commands. Output and exit are acknowledged by live events with bounded failure
diagnostics; personal shell configuration, sleep polling, and consumer scheduling
are not test prerequisites. Effect test clocks remain reserved for application
timing contracts; native process readiness uses the live clock.

Each scenario owns a disposable Profile with isolated Nodex/Core/Electron
state. The local-only [`agent:smoke:paid`](paid-agent-smoke.md) runner is the
only subscription-backed Agent E2E entry point; invoking it with one explicit
case is the user approval. CI must never invoke it.
Native DnD tests must continue to use the realistic mouse helper described in
`AGENTS.md`; direct typed-transfer tests remain the scalable convergence owner.

## Caches and timing evidence

Rust-bearing jobs use sccache through `.github/actions/setup-rust-ci`, the only
place that enables it. The cache only saves time: when sccache cannot be
downloaded after a retry, the job builds uncached with a warning. Browser
Vitest jobs use `.github/actions/setup-playwright`, keyed from the lockfile and
package manifest. Mutable Stores and Cargo target directories are not treated
as correctness caches.

Application CI archives only passing-input records and audit history.
The cache key includes suite, shard, runner image, and runtime versions. GitHub
looks on the current ref before falling back to the base or default branch.
PR runs publish to their merge ref, and Main pushes publish to `main`.
Archives are capped at 8 MiB compressed per shard and refreshed when there
is new passing evidence or an audit invalidates the prior archive. Set the
`NODEX_TEST_CACHE` Actions variable to `off` to execute every file in the same
matrix. Each shard logs its hit and execution counts and raw and compressed sizes.

Wrap meaningful commands with `scripts/ci/run-timed.ts`. Historical workflow
evidence is available through:

```bash
vp run ci:report-timings -- \
  --workflow CI \
  --limit 20 \
  --output notes.local/ci-timings.json
```

Compare repeated successful first attempts before changing tiers, workers,
runner sizes, or artifact topology; keep failure and cancellation rates visible
alongside p50/p90 timing.
