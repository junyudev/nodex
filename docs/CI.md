# Continuous integration

Nodex separates merge feedback, deterministic reliability coverage, scale
signals, and release certification. A test belongs to the cheapest layer that
can prove its contract; Electron Playwright remains an opt-in local diagnostic
tool and is never an automated quality gate.

## Workflow tiers

- `.github/workflows/ci.yml` owns the pull-request `required` check. Its typed
  classifier selects static groups, affected Vitest suites, affected Rust
  crates, protocol verification, and Store migration contracts. It never runs
  stress, macOS runtime, Electron E2E, or UI performance tests.
- `.github/workflows/ci-main.yml` applies the same targeted classifier to the
  exact landed diff. Main is a fast canary, not a second exhaustive PR run.
- `.github/workflows/ci-nightly.yml` runs every deterministic static, Rust,
  application, browser, stress, and macOS runtime contract. It contains no
  Electron UI automation and no hardware-sensitive scale threshold.
- `.github/workflows/performance.yml` is the weekly owner for Core runtime
  benchmarks and explicitly ignored scale contracts. Performance regressions
  are diagnosed below Electron rather than through UI timings.
- `_certify-release-source.yml` runs the full deterministic source and runtime
  gates for an exact release SHA without signing secrets. Its `release-source`
  environment and shared protected-main guard dominate every reusable consumer
  before the SHA is checked out or executed. It issues a SHA-and-tree-bound
  certificate. Stable, nightly, rehearsal, and recovery distributions refuse to
  build unless that certificate matches the checked out Git tree.
- `_macos-distribution.yml` owns signing, notarization, packaged CLI/Core
  probes, application startup, architecture bundles, and certificate
  propagation. The packaged startup probe requires a valid Core descriptor;
  merely keeping an Electron process alive is not sufficient.

An exact four-file stable release transition (`CHANGELOG.md`, `Cargo.lock`,
`Cargo.toml`, and `package.json`) remains a narrow PR/Main mode. Release
certification, rather than Main CI, supplies the exhaustive exact-SHA proof
before distribution.

Every aggregate gate fails closed: a selected job must succeed; skipped,
cancelled, missing, and failed results are rejected. Manual PR/Main dispatch
can request full deterministic source coverage, but still cannot select
Electron E2E, stress, performance, or macOS runtime in the merge loop.

## Affected test selection

`CiGatePlan` owns both suite selection and one of three test modes:

- `none`: no application test suite is selected.
- `related`: Vitest's static import graph selects tests related to safe,
  repository-relative changed paths. Renderer work normally selects only
  `unit`, `renderer`, and `browser`; Main/Core/Shared paths select their actual
  runtime consumers.
- `full`: dependency, configuration, deleted-path, unknown, and explicit-full
  changes run every selected suite. Deleted paths fail closed because they
  cannot participate in Vitest's import graph.

The reusable application matrix owns `unit`, `core-client`, `main`, `renderer`,
`integration`, and `browser`. Browser is a normal Vitest suite with a managed
Chromium prerequisite; it is not a Playwright UI workflow. Main and integration
continue to run through Electron's Node ABI so native addons are exercised by
the correct runtime. Application cells do not regenerate third-party notices or
other build resources; the generated static contract and real build/package
flows own those artifacts.

CI implementation changes are routed by the same ownership rule. Ordinary
workflow orchestration runs CI contracts only; changing
`_app-tests.yml`, `_rust-checks.yml`, or `_static-checks.yml` additionally runs
the complete reusable owner it can affect. Changes confined to `scripts/ci`
run types, CI contracts, and the Node unit suite. Unknown paths still fail
closed to every deterministic source gate.

Documentation paths do not widen an accompanying executable change. A source,
dependency, or workflow edit with its owning documentation therefore receives
the same plan as the executable edit alone; docs-only and landing-plus-docs
remain explicit narrow plans.

Changed test files use the repository filename convention to select exactly one
owning suite, and Vitest `related` runs the test path directly. Explicit stress
files remain Nightly-owned. Vitest configuration, TypeScript project
configuration, lockfiles, CI orchestration, and deleted files promote selection
to `full`.

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

## Local Electron diagnostics

`vp run test:e2e` and `vp run test:e2e:performance` are retained for agents and developers who need to
inspect the production Electron/preload/Main/Core composition. No scheduled,
required, nightly, performance, or release workflow invokes these commands.
They are diagnostic evidence, not a release certificate.

Each scenario owns a disposable Profile with isolated Nodex/Core/Electron
state. The local-only [`agent:smoke:paid`](paid-agent-smoke.md) runner is the
only subscription-backed Agent E2E entry point; invoking it with one explicit
case is the user approval. CI must never invoke it.
Native DnD tests must continue to use the realistic mouse helper described in
`AGENTS.md`; direct typed-transfer tests remain the scalable convergence owner.

## Caches and timing evidence

Rust-bearing jobs use sccache through `.github/actions/setup-rust-ci`. Browser
Vitest jobs use `.github/actions/setup-playwright`, keyed from the lockfile and
package manifest. Mutable Stores and Cargo target directories are not treated
as correctness caches.

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
