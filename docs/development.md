# Development

This document keeps contributor setup and local validation details out of the public README.

## Setup

Install the [Vite+ CLI](https://viteplus.dev/guide/install) once, then install
dependencies from the repository root:

```bash
vp install --frozen-lockfile
```

Nodex pins Node `24.22.1` in `.node-version` and pnpm `12.15.0` in
`package.json`; Vite+ resolves both declarations for the project. The exact
`vite-plus` development dependency pins the project toolchain independently of
the globally installed launcher version.

Upgrade `vite-plus` and the `@voidzero-dev/vite-plus-core` alias together across
workspace manifests and overrides. Keep Vitest, its browser provider, and the
major-5 utility overrides aligned with the version reported by
`vp toolchain vitest`; install dependencies and run `vp pm audit --level low`
after refreshing those pins.

Dependency updates must satisfy pnpm's minimum release age (24 hours by default).
Do not add release-age exclusions to resolve peer conflicts. Run `vp install`,
`vp exec pnpm peers check`, and `vp pm audit` after changing the dependency graph.

### Retained dependency and peer decisions

- Vendored BlockNote packages share one version; keep the code-block peer
  declaration aligned with its workspace Core dependency.
- Base UI `1.9.0` queued popup focus must respect an already focused open descendant
  in the same floating tree. Its runtime patch covers both module formats; retain
  the controlled-frame menu regression when updating the package.
- `@vitest/browser` `5.0.5` retains WebSocket close codes and reasons in its
  existing debug log. The patch changes diagnostics only; remove it when upstream
  provides equivalent disconnect attribution.
- `@pierre/diffs` supplies `@pierre/theme@2.0.0`. Trees `1.0.0-beta.6` pins
  theming `1.0.0`, so its dependency is overridden to `1.0.2`, which supports
  Theme 2 and preserves the color normalization API used by Trees.
- Excalidraw `0.18.1` still pins Radix Tabs `1.0.2`. Override only that dependency
  to `1.2.1` for a React 19-compatible Tabs closure; its Root, List, Trigger, and
  Content API supports Excalidraw's diagram dialog.
- TanStack Query's lint plugin brings typescript-eslint, whose JavaScript compiler
  API requires TypeScript `<6.1`. `packages/query-lint-runtime` supplies the
  plugin's isolated TypeScript `5.9.3` runtime, as Core protocol generation does.
  Load the rules through `@nodex/query-lint-runtime` and keep the root TypeScript 7
  checker and editor runtime independent; revisit the pin when updating the plugin
  or typescript-eslint.
- OpenCode's client declares an exact Effect peer. The workspace deliberately
  shares one Effect version with its protocol and schema packages; only that
  client version accepts it through `peerDependencyRules.allowedVersions`.

### Runtime and build tooling

Rust `1.99.1` is pinned in `rust-toolchain.toml` and the Cargo workspace's
`rust-version`. Rustup supplies the matching formatter and Clippy; CI reads the
same toolchain file. `vp run core:build:dev` prepares native helpers and stages
Core, CLI, and Browser Profile Helper executables under
`.generated/rust-dev-runtime` on the supported shared-build path. `vp run dev`
uses that preparation automatically. `vp run core:binaries:prepare:dev` runs
only the Rust binary preparation and staging step.

Search WASM regeneration uses `vp run page-search:wasm:generate`. It requires
the `wasm32-unknown-unknown` Rust target and `wasm-bindgen-cli 0.2.129`, matching
the search kernel crate and generator pin.

Keep the root `yaml` development dependency aligned with Agent Runtime's version.
It supplies Vite's optional peer so workspace test helpers and the root runner
resolve one Vitest instance.

The renderer uses the React plugin's native JSX and Fast Refresh transforms.
React Compiler runs through `@rolldown/plugin-babel` and `reactCompilerPreset`,
with first-party source filtering and a separate development transform cache.
Resolve the asynchronous Babel plugin before returning configuration to Electron Vite.
Keep Babel's mutable native hook filter attached when wrapping its transform.

The install lifecycle prepares pinned Electron, then runs `electron-builder install-app-deps`, which rebuilds
`node-pty` for Electron. Do not run `vp rebuild` for it: that can replace the
Electron-compatible binary with a host-Node binary. SQLite and collaborative
Document authority are native Rust code and do not use a Node addon.

Optional dependencies are installed for the current operating system and CPU.
Prepare additional architectures explicitly in a dedicated checkout by setting
`supportedArchitectures` before installation; this installs optional packages,
not cross-compiled native addons.

### Worktrees

Follow [Worktrees and local artifacts](../AGENTS.md#worktrees-and-local-artifacts).
For example, create a `board-drag` task worktree from any working directory:

```bash
git -C "$HOME/repo/nodex" worktree add -b codex/board-drag "$HOME/repo/nodex/.agents/worktrees/board-drag"
```

### Machine-local artifact cache

Pinned Browser, Agent, Sparkle, and workspace dependency archives automatically
use the Git primary checkout's `cache.local/`, including when invoked from a linked
worktree. No worktree symlink is needed. Source directories outside a Git checkout
use their own `cache.local/`. Materializers that accept `--cache` use it as that
runtime family's cache directory.

Archives are addressed by their locked SHA-256. Verified extracted third-party
trees are also cached by content identity and extraction recipe, so equal inputs
across worktrees download and extract once. Cross-process locks, verification,
and atomic publication protect both cache layers. Corrupt entries are rebuilt;
different pinned versions can coexist.

Electron retains its upstream machine-wide ZIP cache and shares verified extracted
distributions through the same immutable cache. Set `NODEX_BUILD_CACHE_DIR` to an
absolute directory to isolate all Nodex runtime and native build cache families;
an explicit materializer `--cache` still selects that family's directory directly.

Materialization creates independent outputs under each worktree's `.generated/`.
Files use copy-on-write clones where the filesystem supports them, with regular
copies as a fallback. Editing, signing, or deleting a worktree's runtime cannot
change the shared cache or another worktree's files. Writable Core and native bridge builds,
`node_modules`, Rust `target`, Profiles, and other source-derived outputs remain
isolated per worktree.

For the shared cache location and task slug, follow
[Worktrees and local artifacts](../AGENTS.md#worktrees-and-local-artifacts).
The `*.local` ignore rule excludes the cache from Git. It contains no credentials
and may be deleted at any time; future materialization verifies or downloads the
required archives and regenerates extracted entries. Keep Profiles, logs,
source-derived builds, and release artifacts in their designated directories.

Start the desktop app from the task's worktree with an absolute home in the
primary checkout. For example, a `board-drag` task can use:

```bash
vp run dev --home "$HOME/repo/nodex/runs.local/board-drag" --seed board/dense
```

`vp run dev` is the single manual real-app launcher. It starts the HMR app by
default and accepts options directly, without an intermediate `--`. Other
option examples use an absolute task home:

```bash
task_home="$HOME/repo/nodex/runs.local/perf"
vp run dev --home "$task_home"
vp run dev --home "$task_home" --build
vp run dev --home "$HOME/repo/nodex/runs.local/perf-ephemeral" --delete
vp run dev --home "$task_home" --auth-json /path/to/auth.json
vp run dev --home "$task_home" --agent-config-toml /path/to/config.toml
vp run dev --home "$task_home" --claude-config-dir ~/.claude-nodex-dev
vp run dev --home "$task_home" --remote-debugging-port 9229
vp run dev --home "$task_home" --cdp 9229
vp run dev --home "$task_home" --enable runtime-metrics
vp run dev --home "$task_home" --enable database-page-reorder-menu
vp run dev --home "$task_home" --enable agentation
vp run dev --home "$task_home" --enable query-devtools
```

Unpackaged Desktop startup fails when `NODEX_HOME` is absent. Do not invoke the
underlying Electron or electron-vite entrypoints directly; the launcher owns
Profile isolation and supplies the required environment.

The launcher's no-argument default remains `<worktree>/runs.local/default`, and
relative `--home` paths resolve from the worktree root. Agent launches pass an
absolute `--home`, using the shared-directory convention for new environments
and the current path to reopen an existing one. Executables and source-derived
outputs still come from the task's worktree. Each environment has this layout:

```text
<home>/
├── dev-home.json
├── .nodex/                 # NODEX_HOME
│   └── agent/              # CODEX_HOME
├── workspace/              # NODEX_INITIAL_PROJECTS_DIR
└── artifacts/
```

The manifest records a canonical environment UUID and the creating worktree's
real path. The launcher rejects a directory without that ownership manifest,
another worktree's environment, a symlinked root, a concurrent launcher lease,
or a Core socket path that exceeds the macOS Unix-domain socket budget. Central
storage does not permit writable Profile reuse across worktrees. Use a short
slug and a distinct home suffix for an independent instance or Profile snapshot.

Main logs to `<home>/.nodex/logs/backend-*.log`, and warnings also print in the
`vp run dev` terminal. A failed Inbox suggestion logs `Inbox suggestion failed`
with its `requestId`, `elapsedMs`, and the runtime's own `reason` (for example a
timeout or an unreadable answer); the `Inbox suggestion requested` line with the
same `requestId` names the model and input size. Captured text never enters
these lines, including anything a failing CLI echoed of it.

Instance diagnostics and debug exports belong in that home's `artifacts/`.
Review recordings, screenshots, and verification reports use the primary
checkout's review-artifact directory defined in `AGENTS.md`. These local
directories remain uncommitted. Automatic scenario tests continue to create and
clean up their own fresh temporary Profiles through the test harness. Each also
gets an empty Claude config directory, so no test sees your Claude login,
sessions or settings.

`--auth-json` atomically installs only the named authentication file with mode
`0600`. `--agent-config-toml` passes the named file through the portable agent
config sanitizer and also installs it with mode `0600`. Omitted flags preserve
the environment's existing files.

Without further setup, the environment's default Claude Code instance uses your
existing Claude login and `~/.claude`, so its sessions, skills and settings are
shared with your own Claude Code. To keep them apart, sign in once to a dedicated
Claude config directory and pass it to each environment:

```bash
CLAUDE_CONFIG_DIR=~/.claude-nodex-dev claude auth login
vp run dev --home "$task_home" --claude-config-dir ~/.claude-nodex-dev
```

`--claude-config-dir` records only that directory as the default Claude
instance's config directory, enables the instance and keeps any other Claude
instances. Claude keeps the login itself (in the macOS keychain), so no
credential is copied; the app sets `CLAUDE_CONFIG_DIR` and never `HOME`, which
would hide that keychain login. The setting persists in the environment until
changed in Settings or by another `--claude-config-dir`.

`--enable` is repeatable and applies a Nodex feature only to the current
invocation. Unknown slugs fail and list the catalog. Agentation and TanStack
Query Devtools are hidden by default and loaded only when `--enable agentation`
or `--enable query-devtools` is passed, respectively. Enable both with
`vp run dev --home "$task_home" --enable agentation --enable query-devtools`. These overlays are
development-only and remain absent from built production renderers. Currently
`runtime-metrics` enables structured development runtime metrics, including numeric peer socket
frame, decode, pressure and pending-write snapshots for client and router connections.
Thread navigation timing is owned by the ordinary Codex Thread surface. It measures navigation
and render waits until ready content has painted, including an empty Thread or readable history
that appears before execution attachment finishes. Hidden windows resume paint measurement when
visible; Side Chat and provider override surfaces do not claim this measurement. It follows the
existing performance telemetry preference and omits Thread identifiers from analytics attributes.
`database-page-reorder-menu` shows the position-only `Reorder` submenu in a
Database Page context menu; it does not gate `Move to`, drag ordering, keyboard
ordering, or bulk ordering. These features default off. Agent/app-server
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

On macOS, every disposable Electron launch passes `-ApplePersistenceIgnoreState YES`:
both isolated development modes, the Electron E2E harness, and Electron integration
fixtures share one definition in `scripts/isolated-run/electron-arguments.ts`. This
process-only AppKit setting prevents an OS crash-restoration prompt, which follows any
killed instance of the same bundle, from blocking startup before Electron is ready. Nodex still restores its own
windows and sessions; installed application launches and global preferences are
unchanged. See Apple's [restorable-state debugging documentation](https://developer.apple.com/library/archive/releasenotes/AppKit/RN-AppKitOlderNotes/index.html).

Installation, development, builds, and Electron test preparation run the repository's
`electron:prepare` owner before a consumer can trigger Electron's lazy installer.
It verifies the exact package-pinned distribution and creates an independent local
`dist` from a shared extraction. Transient connection, DNS and transfer failures
receive up to three download attempts, with one- and two-second backoffs.
Checksum, TLS certificate, HTTP response and archive failures stop immediately; retries never
bypass verification or publish incomplete distributions.
For a standalone repair after `Error: Electron uninstall`,
run `vp run electron:prepare` from the worktree root. The upstream
`vp exec install-electron` remains an explicit bypass; normal preparation restores
the package-pinned host distribution. See
[Electron's binary download documentation](https://www.electronjs.org/docs/latest/tutorial/installation#binary-download-step).

Sandboxed preloads bundle their dependencies and use Web APIs for bytes, URLs,
and scheduling. Electron 45 provides only Electron modules through their
`require`; Node module shims, `Buffer`, and immediate-timer globals are unavailable.

The Clipboard, DeviceCheck, and notification bridges reuse verified worktree-local
outputs when their source, build scripts, dependency lock, Electron/Node versions,
architecture, selected compiler/SDK, and build environment match. Each reuse checks
the binary's file type, executable mode, SHA-256, and architecture. Missing or damaged
outputs rebuild in a temporary directory before publication; custom compiler, header,
or Gyp overrides bypass reuse. These source-derived outputs stay under `.generated`.

Ordinary macOS arm64 development also shares an immutable Core, CLI, and Browser
Profile Helper bundle when all source inputs and the supported toolchain/build
context match. The key includes embedded non-Rust assets. Each worktree receives
independent executables and adjacent standalone dSYM bundles under
`.generated/rust-dev-runtime`; the launcher uses those paths consistently for
the application and seed operations. Writable Cargo targets remain local.
Full-debug or customized compiler contexts use Cargo's own local outputs.
Native tests, release builds, and WASM retain their Cargo preparation paths.
Source and toolchain changes create distinct shared bundles; entries persist
until explicitly removed.

`vp run cache:report` reads metadata for the current worktree's build directories
and known shared caches. Add `--all-worktrees` to include every registered checkout,
or `--json` for structured output. It excludes Profile directories and symlink
targets, reports incomplete reads, and never deletes files. Allocated-byte totals
deduplicate hard links within each directory; filesystem clones can still share
blocks across entries, so the report is not a reclaimable-space estimate.

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
five workflow columns, ten Pages, and structured Block content:

```bash
vp run dev --home "$HOME/repo/nodex/runs.local/board-dense" --seed board/dense
```

The manifest records the seed id and revision. Reopening the same home with the
same seed is a no-op and prints its provenance. A different seed, or a seed for
a home already initialized without one, fails. Later manual edits belong to the
environment and are not reset or compared with the original recipe.

A home keeps the Store it was created with. A branch may still be changing its own
unreleased Store revision, so a home created by an earlier build of the branch can
hold a Store this build cannot open. Before launching, the launcher asks
`nodex profile check` and refuses such a home with Core's reason, typically a
`physical schema fingerprint` mismatch, instead of opening a window that cannot
finish opening. Reopening it with the same seed does not repair it. Start a new
home with the seed. `--delete` removes the old home at once without launching it;
for a compatible home, the launcher deletes it after you quit the app.

`landing/showcase` supplies three Tinyboard Pages with an unfinished brief.
`landing/shared-pages` supplies the complete brief, an empty Implementation notes
section, and one linked Chat without a Thread or fabricated transcript. Use a fresh
home for each take, and `--build` for optimized Core and renderer execution:

```bash
vp run dev --home "$HOME/repo/nodex/runs.local/shared-pages-take-01" --seed landing/shared-pages --build
```

Neither recipe implements a task-list repository or claims verification results.
Perform real implementation and verification before asking an Agent to document
them. Built renderers do not imply that every unfinished product control is hidden;
inspect the intended composition before recording.

The catalog is shared by Core integration and Electron E2E tests. Deterministic
UI behavior belongs in a dedicated Playwright spec such as
`tests/e2e/board-dense.spec.ts`; `vp run dev --seed ...` never starts
Playwright, focuses a Page, or performs assertions.

`scheduled/ask-in-inbox` creates five scheduled tasks, a Dependency policy runbook,
and Inbox messages for waiting, skipped, and failed runs. The dependency task has
fallen due three times while waiting; a projectless reading list waits in the
Library Inbox. A security task runs automatically and has no firing. Seeding
never starts an Agent:

```bash
vp run dev --home "$HOME/repo/nodex/runs.local/scheduled-ask-in-inbox" --seed scheduled/ask-in-inbox
```

`inbox/suggestion-spend` seeds the Library Inbox with a current New chat suggestion,
an outdated suggestion after a Page edit, a message with no advice requested, a
suggestion grouping two related messages, a suggestion that failed, and a message
that opens with a Library image before its text. It uses Core operations without starting
an Agent: `vp run dev --home "$HOME/repo/nodex/runs.local/inbox-suggestion-spend" --seed inbox/suggestion-spend`.

### Real Profile snapshots

Some defects and performance cliffs only appear with real document shapes,
long histories, managed assets, or a production-sized Store. For that evidence,
clone a published backup and local conversation history into a dedicated
environment in the primary checkout's shared run directory:

```bash
nodex backup create --label "before local validation"
vp run dev --home "$HOME/repo/nodex/runs.local/real-profile" --from-profile ~/.nodex
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
being silently repaired or replaced with synthetic files. A diagnostic clone also
preserves unattached Documents and their source bytes so ownership defects can be
reproduced locally. Cloning does not certify those Documents for restore or grant
them editing authority; restore and normal reads retain their strict validation.
Select a specific backup with `--backup <backup-id>` when reproducibility matters.
An exact supported predecessor retains its Store revision through provisioning
and upgrades on first open. Create a fresh backup when existing backups lack
recorded integrity evidence or Store identity.

The Profile materializer also captures the source's idle local Codex history:
active and archived rollouts, inherited fork history, selected history after
revert, native metadata, pagination indexes, goals, and managed Agent attachments.
Capture reads the source Profile's verified active Codex home, including a shared native home.
Earlier Profiles without an active-home receipt use their `${NODEX_HOME}/agent` directory.
The destination always uses its own disposable Agent directory and never shares writable native
history with the source.

Native SQLite uses online backup rather than raw database/WAL copying. Selected
rollout paths, current managed goal references, and managed attachment ownership
are relocated into the destination. Core Session/Thread IDs remain unchanged.
Execution queues, locks, credentials, and Agent configuration are excluded.
An open source Nodex coordinates capture automatically: new Agent requests wait,
existing requests and active conversations drain, and its owned local Agent closes
normally before copying. Stop controls remain available while waiting for active
work, including Agent background terminals. Source windows and Core remain open.
After copying and checking the source files, the Agent reconnects before the CLI
continues with validation of the detached copy. Cancellation or a disconnected
clone client releases the pause too. Busy work times out without being interrupted.

Both the clone command and the source Desktop must support this coordination.
An older source Desktop, an external daemon, or another process retaining native
writer locks still requires stopping that Agent before cloning; no live writer
check is bypassed. Once a development home is initialized, reopening it does not
pause or recapture the source.

Every local Codex Thread referenced by the selected Store must have recoverable
native history. Missing rollouts or inherited history reject the clone before
publication. For an intentional broken-data reproduction, add
`--allow-missing-conversations`; the receipt records exactly which Thread IDs are
missing and the launcher reports their count. Remote-host and other-backend
Threads retain their metadata and are counted separately; their histories are
not imported from this local Codex home.

The receipt dates the selected Store backup and current native capture separately.
`--backup` selects the Store version; it does not rewind conversations to that
backup's timestamp. Native transcript bytes and historical workspace/file paths
are preserved, so external repositories and files remain external dependencies.
This command is development provisioning, not a historical full-Profile restore.

The environment uses its own `${NODEX_HOME}/agent` directory. Add `--auth-json`,
`--agent-config-toml` or `--claude-config-dir` explicitly only when validation
requires Agent authentication or configuration.
Remote observability is disabled for a `--from-profile` launch so user content
remains local by default.

The snapshot is a detached local fork, not a branch that can be merged back.
Its Store epoch and historical coordinates intentionally match the imported
backup; new local history may diverge at the same coordinates and must never be
replayed, synchronized, or exported into the source Profile.

`dev-home.json` and `.nodex/profile-snapshot.json` record immutable backup and
Store provenance plus conversation coverage and capture evidence. Reopen the
environment with the same command or omit
`--from-profile`; later edits are preserved. Use another `--home`, or delete the
old environment after a clean stop, to test a newer backup. Older Store-only
snapshot environments must be recreated; launching them fails with a recovery
instruction rather than silently reusing incomplete conversation state.

The composed clone regression uses a fresh authoritative Core scenario:

```bash
vp run test:core-client src/main/core-client/profile-clone.node.test.ts
NODEX_TEST_PROFILE_CODEX_BINARY=/path/to/locked/codex vp run test:core-client src/main/core-client/profile-clone.node.test.ts
```

The second command also uses the locked Codex CLI binary to fork a synthetic
conversation, archive its ancestor, revert its last turn, clone the Profile, hide
the entire source, and verify read, paginated turns, and resume through the native
consumer. It
requires no credentials and starts no model turn.

Profile snapshots are local exploratory and production-shape evidence. They
must not run in CI, be committed, or produce uploaded screenshots, traces,
databases, assets, or logs containing user content. Convert any durable finding
into the smallest deterministic scenario or focused regression test that proves
the behavior without private data.

Build the app:

```bash
vp run build
```

Production JavaScript builds minify Electron Main, Preload, Renderer, Agent Runtime,
the remote worktree worker and the application MCP server while preserving function
and class names. They emit separate hidden source maps for offline diagnostics;
Electron maps retain the existing Sentry upload path when credentials are configured.
The distribution workflow retains remaining maps and their prepared-build manifest
in a separate CI artifact. Source maps are excluded from installers. Development HMR
output stays unminified; the launcher builds Agent Runtime with
`build:agent-runtime --development` for the same readable output. The standalone
`build:agent-runtime` command defaults to production.

Both modes reuse a verified local Agent Runtime bundle when authored sources,
bundled dependencies, resolver inputs, tools, mode, copied SDK resources, and
notices match. Output corruption triggers a rebuild. Compilation happens in a
temporary sibling tree and publishes only a complete bundle, preserving the
previous output if a rebuild fails.

The Claude Agent SDK dependency supplies its matching platform runtime. Update
the root and Agent Runtime manifests together; installation and bundling derive
the runtime version and build receipt from that SDK closure. Scripted ACP peers
use the SDK's `/unstable` v1 entrypoint to retain the negotiated lifecycle and
callback features covered by the Runtime's v1/v2 wire compatibility tests.

ACP terminal sign-in uses a separate `node-pty` build for the verified staged Node.
The macOS production build prepares that pinned runtime from the verified cache first.
`build:agent-runtime` materializes it under
`.generated/agent-runtime-native/<platform>-<arch>/` from a private source copy and
packages its JavaScript, native addon and helpers inside
`out/agent-runtime/node_modules/node-pty/`. Packaging copies this verified dependency
through `extraResources` into the unpacked Agent Runtime, preserving its package metadata
without Electron dependency rewriting. The after-pack inventory checks every file, byte
and executable bit before signing. Its receipt includes source, dependency,
Node ABI, toolchain and artifact identities. The root Electron dependency is never
rebuilt or shared with this execution process. macOS packaging verifies the copied
closure before signing and reseals its separate manifest afterward.

After staging the runtime and building the bundle, verify terminal sign-in through
its public management protocol with a disposable home:

```bash
vp exec tsx scripts/testing/probe-acp-runtime.ts --target-platform darwin --target-arch arm64 --home "$HOME/repo/nodex/runs.local/acp-terminal-probe" --report "$HOME/repo/nodex/notes.local/artifacts/acp-terminal-probe/report.json"
```

Use `--pty-only` to verify the native Adapter before management integration. Both
modes require a matching host and staged Node; missing binaries or failed checks
exit unsuccessfully. The full probe covers input, resize, EOF, credential recheck,
cancellation and descendant cleanup. A successful terminal exit alone does not
establish authentication. macOS arm64 is the verified release target; Linux and
Windows require the same probe on their actual hosts before support is claimed.

Package local macOS installers:

```bash
vp run package
```

macOS notification authorization uses an in-process native bridge, built by
`vp run notification-bridge:build` and included in development/build/package
preparation. It reads the running Electron bundle's permission, which may differ
from the installed Nodex app even when both use equivalent Profiles. The Electron
notification API requires a correctly signed app bundle for delivery; a development
permission or signing failure must not be diagnosed through browser permissions.

Native bridge preparation verifies the actual Mach-O architecture and deployment
target before publishing or reusing an output. See the
[macOS release contract](release-macos.md) for the build configuration and
packaged verification requirements.

## Validation

### UI development and verification

Start integrated UI work in a seeded development home owned by the current
worktree. Extend the nearest authoritative scenario when a new state depends on
Project, Page, Database, Document, or Window Session authority; the recipe
remains shared with Core and Electron consumers. The launcher provides the
persistent HMR environment, while a dedicated Electron E2E spec owns repeatable
navigation and assertions.

Choose evidence by the behavior under test:

| Behavior                                                                              | Verification boundary                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Real pages, composition, and cross-runtime workflows                                  | Seeded app review; corresponding Electron scenario/E2E for automated assertions          |
| Component interaction, transient state, input boundaries, and accessibility           | Focused renderer/jsdom tests using production components and injected runtime boundaries |
| Real layout, selection, pointer, observer, computed-style, or native browser behavior | Chromium browser tests                                                                   |
| Pure state transitions and domain rules                                               | Owning helper/domain tests                                                               |
| Large-data, scale, and convergence behavior                                           | Owning pressure fixtures and tests, paired with a smaller authoritative operation path   |

Reuse these mechanisms for UI verification. Keep fixture data with its test or
subsystem owner instead of introducing a separate component gallery or parallel
display state model. Fixture classes and runtime commands are detailed below.

### Choosing checks

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
and `lint` all execute `tsc-rs --build --noEmit && vp lint`. tsc-rs owns TypeScript
and Effect diagnostics; Oxlint owns type-aware lint. They share the same task-result cache. `check` composes
`vp fmt --check` with that same semantic command. CI uses the same entrypoint and
policy. To measure actual analysis, use `vp run --no-cache check:semantic`; the
run option must precede the task name.
`@effect/tsgo` supplies the editor runtime. Its version does not change the
Effect diagnostics embedded by tsc-rs; review both diagnostic generations when
upgrading either tool.
`effect-tsgo patch` prepares the TypeScript editor runtime; it does not add a
second compiler or an Effect pass to Oxlint. `tsconfig.effect.json` owns the
Effect rule severities, control-plane scope, and platform exceptions for both
the compiler and the editor.
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
uncached. The standard aggregate runs unit, effect-codex, Agent Runtime, core-client, Main,
renderer, and integration serially; Chromium remains an explicit browser gate.
Main and integration run Vitest under Electron so native addons use its ABI.
Workspace text-search process tests use the locked `@vscode/ripgrep` development
dependency for the test host. They require no staged desktop bundle or `rg` on
the user's PATH; keep platform optional dependencies enabled during installation.
Electron and packaged-runtime checks exercise the application's bundled search tool.
Renderer uses up to four workers in CI, and locally on machines with at least
8 available CPUs and 24 GiB total memory; smaller local machines use up to two.
The budget never exceeds available CPUs. Stress stays at one worker, file
isolation stays enabled, and suites do not compete through aggregate parallelism.

Before execution, the aggregate prepares its union of required Cargo targets
once. Standalone native suites prepare themselves. Cargo checks freshness and
returns the executable paths, including when `CARGO_TARGET_DIR` is customized.
Ordinary suites use development builds; stress suites use optimized release
builds so performance evidence measures the shipped native execution profile.
The real-history stress gate also stages the locked Agent runtime before tests
start. The complete stress tier runs on macOS, matching that runtime package;
Nightly and release certification use the same macOS runner and test launcher.
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
- `vp run test:agent-runtime` runs the execution package contracts in host Node,
  including persistence, native adapters, delegation, process recovery, and all
  deterministic vendor package tests. Vendor tests have the same inventory and
  collection requirements as other owned tests.
- `OPENCODE2_BIN=/absolute/path/to/opencode vp run test:live` runs the separately
  registered `.live.test.ts` contracts outside the deterministic and stress
  gates. The vendor OpenCode contracts require a real OpenCode 2 binary; the
  client also calls the remote `opencode/big-pickle` model and requires available
  provider quota. Vendor live selections fail explicitly without the binary.
  Orchestrator fixtures additionally use the opt-ins and authentication documented
  in their test files.
- `vp run test:main` runs Electron main-process adapter and host tests.
- `vp run test:renderer` runs ordinary `.test.tsx` React behavior and explicit
  `.jsdom.test.ts` DOM behavior in jsdom. A `.test.ts` file must not rely on
  browser globals implicitly.
- `vp run test:browser` runs browser-sensitive renderer contracts in Chromium.
  Each invocation rebuilds its optimized dependency graph before testing; a
  cache populated by a focused run must not trigger reloads during a later
  full run. Keep lazily loaded runtimes that cause late dependency discovery
  in `vitest.browser.config.ts`'s `optimizeDeps.include`. Enable browser failure
  traces with `NODEX_BROWSER_TRACE=1` locally or rerun a GitHub job with debug
  logging enabled. Traces are retained under `.vitest-attachments/browser-traces/`
  and uploaded by CI. Normal runs avoid trace overhead; CI always records
  Chromium process diagnostics.
  Assert immediate state transitions in renderer tests and native pointer,
  layout, and animation behavior in browser tests. Do not measure remote
  Playwright command latency as a UI response-time contract. After changing
  `scrollTop`, await the native scroll event before testing an idle interval;
  a synthetic scroll event does not consume the browser's queued event.
  Chromium's built-in `toHaveTextContent` checks the complete normalized text;
  use `toMatchTextContent` for a substring or regular expression.
- `vp run test:integration` runs integration tests in Electron's Node runtime.
- Rust development and test profiles retain file/line backtraces with
  `debug = "line-tables-only"`, incremental compilation, and separate debug
  artifacts (`split-debuginfo = "unpacked"`). For variable/type debugging, set
  `CARGO_PROFILE_DEV_DEBUG=full CARGO_PROFILE_TEST_DEBUG=full` on the command;
  Cargo rebuilds the affected profile and ordinary dev bypasses shared native
  reuse. Core hashes its executable during startup, so keep debug data outside
  that executable admission input.
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
- Core protocol generation runs `openapi-typescript` inside `packages/core-protocol-codegen`, where its officially supported TypeScript 5 compiler runtime is pinned. TypeScript 7 does not expose the JavaScript `factory` API that this generator uses. That package is a generator implementation detail; tsc-rs remains the repository source checker inside the shared semantic gate.
- `vp run tooling:verify` also proves that Vite+ can load the complete workspace metadata graph while keeping third-party packages outside root task execution. Keep dependencies imported by workspace-local Vite configs resolvable even when those packages are not selected by `vp run`.
- `vp run verify:effect-boundaries` keeps Effect inside the Main/script control plane, generated/shared/renderer contracts Effect-free, unstable APIs inside app-owned adapters, and runtime execution at approved composition/facade seams. Lifecycle tests use fake capabilities or `@effect/vitest` TestClock instead of real retry or escalation sleeps.
- `vp run test:e2e` rebuilds the native Core plus Electron application, then
  exercises the complete Electron/preload/IPC/Core chain. Do not invoke the
  Playwright config directly after changing Rust authority code; that can run
  against a stale `target/debug/nodex-core` binary.
  Electron E2E is retained for deliberate local/agent diagnostics and is not
  invoked by PR, Main, Nightly, Performance, or release-certification workflows.
  Its windows run in the background: transparent, click-through, never focused,
  and without a Dock icon, so a run does not interrupt other work. Playwright
  still paints, captures and drives every page. A spec that asserts real window
  focus or native window chrome passes `windows: "foreground"` to the harness;
  set `NODEX_E2E_WINDOWS=foreground` to watch a whole run.
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
record the checked-out source SHA, including an explicit source override. Every
test run rejects React `act` warnings even if its individual tests passed,
including local runs without timing collection. When enabled, the diagnostics
also retain those warnings. Fix missing awaited interaction/subscription
boundaries instead of accepting or silencing them. Compare trends only
within the same runner/toolchain/scope; ordinary CI does not run repeated full
benchmarks or enforce a noisy universal wall-time threshold.

### Collaborative editor dependency updates

Keep Tiptap versions aligned across the root, vendored BlockNote manifests, and
menu overrides. Keep the ProseMirror overrides aligned with direct declarations.
The Yjs patch extends surface-local UndoManager replay/discard and preserves GC
keeps across retained surface histories; an upstream version bump must port all
source, bundle, and declaration hunks unless behavioral evidence replaces them.
Run the editor history and retention tests plus
`vp run test:core-client src/shared/block-documents/yjs-yrs-conformance.test.ts`
after changing Yjs or its bindings. Persisted Yjs/Yrs document encoding must remain
compatible. The maintained BlockNote contracts and package test commands are in
[`third_party/blocknote/ORIGIN.md`](../third_party/blocknote/ORIGIN.md).

The ProseMirror view patch backports upstream's unreleased `dispatchKey` fix:
ProseMirror must not run synthetic Enter or Backspace key handlers during IME
composition, or more than once for one key press. Since 1.42.7, ProseMirror
reports a deletion inside marked text as Backspace, and any key handler that
dispatches then redraws the composing text and cuts off the input method. Drop
the patch only for a release that contains the fix, and only after
`vp test run --config vitest.browser.config.ts src/renderer/components/board/editor/nfm-ime-composition.browser.test.ts`
passes against that release.

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
large-data reliability, relation projection, or manual-order boundaries. The focused
`vp run core:test:manual-order-scale` gate exercises 4,096-Page Forward/Undo/Redo
at 10k and 100k Source sizes; run it without competing workloads. Ordinary tests
retain the 1- and 64-Page bounded-work matrix. Store preparation
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

This gate includes `test:acp-runtime-conformance` on macOS arm64. It builds the
standalone Agent Runtime and runs the real Node PTY and public ACP management
protocol through terminal input, resize, authentication, cancellation, descendant
cleanup, and shutdown. The probe verifies the staged Node manifest and bundled
native dependency closure; it does not certify an installed `.app` or signing.
Each execution creates a fresh owned home under the primary checkout's
`runs.local/acp-runtime-*` and writes a passed or failed report under
`notes.local/artifacts/acp-runtime-*/runtime.json`, including the exact Runtime
directory digest. Other platforms fail this release gate instead of skipping it.
For a probe against an already built Runtime without rebuilding, run
`vp exec tsx scripts/testing/probe-acp-runtime.ts --gate --target-platform darwin --target-arch arm64`.
Manual `--home` and `--report` paths must be absolute and unused; `--pty-only`
is a narrower dependency check and cannot satisfy the release gate.

`vp run test:all` remains a compatibility alias for `verify:source`; neither
command proves Apple signing or notarization. Use the
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
both runtimes. Keep the root addon on Electron-owned test and application
paths; the execution runtime builds its independent copy as described above. Rust Core tests and binaries are independent of this Node ABI boundary.

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
