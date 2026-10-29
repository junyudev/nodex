# AGENTS.md

## **IMPORTANT Global Instructions for Agents:**

- Always commit changes after all edits are done. Do not leave uncommitted changes at the end of a task.
- This app has no real users or real data yet. Prefer long-term architectural correctness over short-term compatibility. Breaking changes, schema migrations, and large refactors are acceptable when they make the product model simpler and more coherent.
- For frontend design, prioritize an elegant, information-dense layout with minimal logical/visual redundancy and shallow nesting.
- Keep implementation notes, docs, changelog entries, commit messages, and handoff summaries product-native: describe what Nodex does and why, without surfacing private provenance, comparative targets, or reconstruction details unless the user explicitly asks for research notes.
- Do not read repository contents via web crawling from `raw.githubusercontent.com` because it is not stable for agent workflows. For remote repository inspection, clone the repository into a temporary local directory and read files from the local clone instead.
- DO NOT write tests that only assert a source file contains a string (source-string tests); that is redundant with the implementation and does not validate behavior.
- Read [official doc of codex-app-server](https://developers.openai.com/codex/app-server.md) when dealing with codex-app-server.

### Desktop UI inspection boundary

- Inspect Nodex through a seeded development instance, Playwright, or an explicitly identified development CDP target.
- Treat every already-running Nodex window as the user's production app unless its current-worktree, disposable development Profile is proven; its title, bundle identifier, or running state is not proof.
- `computer-use` is opt-in: use it only when the user explicitly requests it for the current task, or approves a proposal that names the target instance and purpose. Inspection, testing, and screenshot requests are not implicit permission, and approval does not carry between tasks.

### Worktrees and local artifacts

- Create new worktrees, including subagent worktrees, under `~/repo/nodex/.agents/worktrees/<slug>/` in the primary checkout, even when working inside another worktree. Use a short, task-descriptive lowercase hyphenated slug and default to branch `codex/<slug>`. Use a creation command that accepts the target directory, such as `git worktree add`. This convention does not require a new worktree for every task.
- Reuse the new worktree's slug for its local artifacts. When working in an existing checkout, choose a task-specific slug. Add a short suffix when a new worktree or independent instance would collide with an existing path.
- Run commands and edit source in the task's current worktree. Writing the task's local artifacts to the primary checkout's directories below is allowed from any worktree; it does not authorize source edits in another checkout.
- Use these primary-checkout paths even when working in a linked worktree:

  | Artifact                                                                 | Default location                                  |
  | ------------------------------------------------------------------------ | ------------------------------------------------- |
  | Manual development environment, seeded Profile, or real-Profile snapshot | `~/repo/nodex/runs.local/<slug>/`                 |
  | Instance diagnostics and debug exports                                   | The environment's `artifacts/` directory          |
  | Review recordings, screenshots, and verification reports                 | `~/repo/nodex/notes.local/artifacts/<slug>/`      |
  | Living plan / ExecPlan                                                   | `~/repo/nodex/notes.local/living-plans/<slug>.md` |
  | Brief plan                                                               | `~/repo/nodex/notes.local/brief-plans/<slug>.md`  |
  | Shared verified runtime and development build cache                      | `~/repo/nodex/cache.local/`                       |

- Agent launches must pass an absolute `--home`: use the shared `runs.local` directory for new environments and the current path when reopening an existing one. The launcher's no-argument default remains worktree-local. Each writable development home belongs to one worktree; use a separate home for an independent instance or snapshot. See `docs/development.md` for launch commands and Profile ownership.
- Keep writable `node_modules`, `.generated`, Rust `target`, build outputs, and Profiles isolated per worktree. Preparation owners may reuse verified, immutable third-party runtimes and supported development build bundles through the primary checkout's `cache.local`, then clone independent local outputs. Source build reuse must cover its complete inputs and toolchain, preserve standalone debugging, and bypass unsupported build contexts; see `docs/development.md`. Automatic scenario tests retain their harness-managed temporary Profiles.
- Keep `runs.local`, `notes.local`, and `cache.local` out of commits. Apply this layout to new worktrees and artifacts; leave existing worktrees and historical artifacts in place unless migration is explicitly requested.

## Agent skills

### Domain docs

Nodex uses a single-context layout with one root `CONTEXT.md` and system-wide ADRs under `docs/adr/`.
See `docs/agents/domain.md`.

## Project Overview

Nodex is a local-first, block-based agent orchestrator.
It ships as an Electron desktop app plus a CLI/HTTP API backed by SQLite.

## Setup Commands

- Install deps: `vp install`
- Dev app: `vp run dev --home <absolute-task-home>`
- Build: `vp run build`
- Package installers: `vp run package`
- Unified check: `vp run check`
- Semantic check without formatting: `vp run typecheck`
- Full semantic aliases: `vp run check:semantic`, `vp run typecheck`, `vp run lint` (shared cache)
- Format check: `vp run fmt:check`
- Standard tests: `vp run test`
- Source gate: `vp run verify:source` (`vp run test:all` is an alias)
- macOS runtime gate: `vp run verify:runtime:mac`
- Signed macOS arm64 gate: GitHub `Distribution Rehearsal`

## Runtime and Tooling

- Package manager: pnpm
- Development runtime: Node 24.22.1
- Native addon: `node-pty` is rebuilt for Electron by `postinstall`; host Node and Electron have different ABIs even when they report the same Node version.
- Engineering control plane: Vite+ with TypeScript 7, Oxlint, Oxfmt, and Vitest; Playwright for Chromium and Electron E2E
- Language: TypeScript (`strict` mode)
- Desktop shell: Electron + electron-vite
- Frontend: React 19 + Tailwind + Radix + BlockNote/Prosemirror
- Backend: detached Rust Core (`rusqlite` + Yrs) with a Hono desktop adapter

### Effect 4 retrieval

Before editing Effect code, read `docs/adr/0047-effect-control-plane-and-runtime-boundaries.md`
and the nearest Nodex implementation, then read the installed version's
`node_modules/effect/AGENTS.md`. Search `node_modules/effect/ai-docs/src` for usage guidance
and the relevant package's `src` directory for API or implementation details. Nodex's
architecture boundaries override upstream examples. Treat Context7, web documentation, and
Effect `main` as secondary sources that must be verified against the installed version; clone
that version's exact upstream tag only when its tests are needed to resolve deeper semantics.

## Code Style

- **DRY**: Always keep code DRY. Extract shared hooks, helpers, and patterns instead of duplicating.
- **Tailwind over custom CSS**: Use Tailwind utility classes. Avoid inflating `globals.css` with new custom class rules.
- Before defining any new protocol-facing type, first check `packages/codex-app-server-protocol/src/v2`.
- Treat `packages/codex-app-server-protocol/src/v2` as the source of truth for Codex app server request/response/notification/thread shapes.
- Prefer importing protocol types directly, or re-exporting them as aliases when a local name is needed.
- Do not hand-write parallel protocol field definitions in `src/shared/types.ts` unless the local type is intentionally a derived or view-model shape.
- Keep data validation at boundaries (`src/main/http-server.ts`, generated Core contracts, and shared transport-neutral validators such as `src/shared/page-input-validation.ts`).
- Prefer pure helpers in `src/renderer/lib/` for reusable behavior.
- Keep renderer presentation transport-agnostic: call semantic owner Interfaces, whose Modules
  cross named typed query, control, or command Adapters. Use `src/renderer/lib/api.ts` only as a
  narrow shared facade, never as a general invocation route.
- Preserve project scoping for stateful UI and server operations.

## Architectural Preference

- Default to the long-term, architecturally clean solution over the smallest incremental patch, even when that requires broad refactors, internal API changes, schema migrations, or breaking changes inside this repository.
- This project has no real users or real data yet. Do not preserve legacy behavior, compatibility layers, duplicate paths, or awkward abstractions merely to reduce diff size.
- When choosing between a quick local fix and a deeper model-level fix, prefer the model-level fix if it simplifies ownership, removes special cases, or makes future features easier to build.
- Large refactors are acceptable, but they must still be coherent: preserve project scoping, update the source-of-truth docs, migrate affected call sites, remove obsolete code paths, and run the relevant checks.
- Do not overbuild speculative abstractions. A long-term solution should reduce conceptual complexity, not add indirection for its own sake.
- If a long-term fix is too large for one safe change, implement a clean vertical slice and document the remaining migration path instead of landing a temporary workaround.

## Architecture

Read `docs/ARCHITECTURE.md` first for system boundaries and dependency flow, then follow its links to the narrow source of truth for the subsystem being changed.

## Documentation Map

Use these docs as the source of truth:

- System ownership, dependency directions, critical cross-runtime flows, and system-wide invariants: `docs/ARCHITECTURE.md`
- Plans: use the primary-checkout paths in [Worktrees and local artifacts](#worktrees-and-local-artifacts). Read `docs/PLANS.md` for execution-plan format and requirements; keep `docs/plans/` absent.
- Cross-feature renderer construction, state-owner selection, shared UI/editor primitives, and UI verification conventions: `docs/FRONTEND.md`
- UI design guidance for agent-built surfaces: `.agents/skills/general-design-guidelines/SKILL.md`
- Product principles and tradeoffs: `docs/PRODUCT_SENSE.md`
- Reliability model (backups, SSE/IPC sync, ops): `docs/RELIABILITY.md`
- Security model and hardening checklist: `docs/SECURITY.md`
- Keyboard shortcuts reference: `docs/KEYBOARD_SHORTCUTS.md`
- Current quality grading and gaps: `docs/QUALITY_SCORE.md`
- Cross-cutting engineering principles and knowledge routing: `docs/ENGINEERING_LEARNINGS.md`
- User-visible feature behavior and public contracts: `docs/product-specs/`
- Native CLI overview: `docs/CLI.md`
- Profile and Desktop configuration: `docs/CONFIGURATION.md`
- External/reference specs (Nodex Markdown and clipboard behavior): `docs/references/`

## Documentation Update Rules

Documentation maintenance is an active, required responsibility for every agent task.
Whenever a user asks you to fix a defect or corrects your previous work, repair the immediate issue and complete a recurrence-prevention review before handoff: determine whether a fresh coding agent without the current conversation could make the same mistake, then encode any enduring constraint at the narrowest effective seam.
Prefer executable enforcement such as types, validation, architecture, or a meaningful regression test; update the owning documentation or agent instructions under the routing rules below when executable enforcement does not make the lesson sufficiently obvious or complete, and do not add redundant prose for a one-off issue already fully protected by an executable regression boundary.
Write current specifications and release notes entirely in canonical product language. Keep compatibility decoder and migration details in code and fixtures.
When behavior changes, update the narrowest source-of-truth doc:

- User-visible behavior/API contract changes: the narrow owning document under `docs/product-specs/`
- State-ownership, dependency-direction, system-boundary/deep-Module, system-wide-invariant, or critical cross-runtime-flow changes: `docs/ARCHITECTURE.md`
- New cross-feature renderer construction convention that applies across independent features and cannot be made obvious at a narrower executable seam: `docs/FRONTEND.md`
- New reusable UI design guidance for agents: `.agents/skills/general-design-guidelines/SKILL.md`
- New cross-cutting, non-obvious, high-cost learning that cannot be enforced at a narrower seam: `docs/ENGINEERING_LEARNINGS.md`
- New subsystem caveat or regression: update the owning product spec/runbook, behavioral test, Adapter comment, or other narrow source of truth instead of appending an incident entry to `docs/ENGINEERING_LEARNINGS.md`
- New reliability/security expectation: `docs/RELIABILITY.md` or `docs/SECURITY.md`

Do not add implementation chronology, schema/version inventories, individual file behavior, UI interaction detail, failure runbooks, or feature acceptance rules to `docs/ARCHITECTURE.md`.
Replace stale architectural statements and link to the narrow owner instead of appending another description of the same contract.

Treat `CHANGELOG.md` as a required deliverable only for **release-note-worthy** user-visible changes:

- Keep an `Unreleased` section at the top.
- Write for humans, not commit-log style.
- Only include externally relevant changes:
  - Added
  - Changed
  - Deprecated
  - Removed
  - Fixed
  - Security
- Do NOT add changelog entries for tiny UI fixups, visual tweaks, styling/token/color adjustments, copy nits, or small interaction polish, even when user-visible.
- Do NOT add entries for pure refactors, formatting, comments, test-only changes, or internal tooling changes unless they affect users.
- Do NOT add entries to Changed/Fixed if you are changing/fixing a feature that is Unreleased.
- If unsure whether a change belongs in release notes, default to leaving `CHANGELOG.md` unchanged and mention that choice in the final response.
- Use one bullet per user-visible change.
- Open each bullet with a sentence that stands on its own; the public changelog shows it as the entry's lead and the rest as detail.
- Prefer impact-oriented wording, not implementation wording.

## Testing Expectations

- Use a two-tier validation strategy: run targeted checks while iterating, then run risk-appropriate handoff checks once after the final edit set is stable.
- Match targeted test commands to their runtime:
  - Node/shared tests outside native Core/bridge contracts: `vp test run --config vitest.node.config.ts <path-to-test>`
  - All Main `.node.test.ts` files and shared Yjs/Yrs bridge tests: `vp run test:core-client <path-to-test>`
  - Renderer/jsdom tests: `vp test run --config vitest.renderer.config.ts <path-to-test>`
  - Main/store tests: `vp run test:main <path-to-test>`
  - Electron integration tests: `vp run test:integration <path-to-test>`
  - Playwright Electron E2E: `vp run test:e2e tests/e2e/<spec>.spec.ts`
- Pass a focused Playwright E2E file directly as a Vite+ `ADDITIONAL_ARGS` value. Do not insert a standalone `--` before the file: `vp run test:e2e -- tests/e2e/<spec>.spec.ts` expands to `playwright test ... -- tests/e2e/<spec>.spec.ts`, and Playwright collects the full suite instead of the requested file.
- For a focused E2E run, verify Playwright's collection banner matches the intended test count (normally `Running 1 test`). If it starts collecting the full suite, interrupt it immediately and correct the invocation instead of waiting for unrelated E2Es.
- Never invoke `vitest.main.config.ts` or `vitest.integration.config.ts` directly with host Node. Those suites must use the repository scripts so Electron-built native addons load under Electron's ABI.
- Match checks to the changed surface while iterating:
  - Pure helpers/domain logic: run the related unit test file.
  - Renderer workflow changes: run the related renderer test(s) plus `vp run typecheck` when types or props changed.
  - Main process/store/protocol/migration changes: run the nearest relevant unit or integration test before any broader handoff checks.
  - Styling or copy-only UI changes: run one complete semantic alias (`vp run typecheck` or `vp run lint`) when TypeScript/TSX files changed; review visual parity at the UI evidence boundary below.
- For docs-only changes, skip code checks unless the docs change generated artifacts or executable examples. Validate the markdown diff directly and state that no code checks were needed.
- Prefer tests that prove behavior or domain contracts over tests that mirror implementation details. Avoid trivial UI assertions such as long `className`/Tailwind string matching, broad `textContent.includes(...)`, or "X contains Y string" checks unless the string is a real user-visible or accessibility contract.
- For UI parity work, put numeric/state rules in pure helpers with boundary tests, keep renderer integration tests to a small number of critical user workflows, and review visual details at the UI evidence boundary below.
- Renderer React tests must be act-clean. Treat any `act(...)` warning as a failing test: fix the test before handoff instead of ignoring console output.
- For renderer interactions that can schedule React updates, prefer Testing Library async patterns (`findBy*`, `waitFor`, awaited helpers) and make assertions only after the UI has settled.
- When a renderer test uses low-level `fireEvent`, window/document events, timers, resize/drag gestures, or imperative callbacks instead of a higher-level awaited helper, wrap the interaction in `await act(async () => { ...; await Promise.resolve(); })`, then wait for the observable DOM/API outcome. Use `try/finally` to release drag/resize gestures so failed assertions do not leak body styles or global listeners into later tests.
- Default to `vp run dev --home <absolute-task-home> --seed <scenario-id>` for product UI iteration and manual visual review. Use or extend the nearest authoritative scenario for integrated product states.
- Put component interactions, transient states, input boundaries, and accessibility contracts in focused renderer tests; use Chromium when the contract depends on real layout, selection, pointer events, observers, or computed styles. Keep pressure fixtures in their owning tests with a smaller authoritative behavior path. Reuse these boundaries rather than creating a component gallery or a parallel display state model.
- Choose the isolated-scenario consumer by the boundary under test:
  - Use `withCoreScenario` for current-schema Project/Page/Database correctness that does not need Electron.
  - Use `withElectronScenario` or `ElectronScenarioHarness` for production Electron/preload/Main/Core workflows, window lifecycle, restart, and native gestures.
  - Reopen a seeded home with `vp run dev --home <dir>` for a persistent integrated UI environment with HMR; run the scenario's dedicated Electron E2E spec for deterministic UI verification.
  - Keep historical/corrupt storage and pressure fixtures visibly separate from authoritative public-operation scenarios. Direct SQL is allowed only when storage shape or scale is the explicit subject, and pressure evidence must retain a smaller authoritative path test.
- When behavior plausibly depends on a user's real data shape, history length, asset closure, migration history, or production scale, prefer an additional local pass against a disposable Profile snapshot in the primary checkout's `runs.local/`. Create it with `vp run dev --home <absolute-snapshot-home> --from-profile <profile-home>` using the path convention above; never point development Core at the live Profile, copy `nodex.db`/WAL files by hand, or symlink Profile data. Real-Profile passes supplement focused deterministic coverage and never replace a regression test that can be distilled into an authoritative scenario.
- Treat Profile snapshots as local evidence: do not use them in CI, commit them, upload their databases/assets/logs, or attach screenshots/traces containing user content. The snapshot excludes Agent credentials; import authentication only through the launcher's explicit private-file flags when the test actually needs Agent execution.
- Every scenario-backed correctness test gets a fresh writable Profile. A generated current-schema snapshot may be copied as an immutable source only after measured seed cost justifies it; never share a live writable Store across tests.
- Choose final checks from the actual risk and changed runtime rather than from a fixed command list:
  - Run the relevant targeted tests for every behavior change.
  - For TypeScript source or contract changes, normally run `vp run typecheck` once the edit set is stable.
  - `typecheck`, `lint`, and `check:semantic` are the same full semantic gate and share cache results; one successful alias covers types and lint. For a targeted lint investigation, use `vp lint <paths>`. Use `vp run --no-cache check:semantic` to force real analysis, with run options before the task name.
  - Run `vp run build` when build configuration, application entrypoints, packaging, bundling, or a reported build/startup failure is involved.
  - Run `vp run test` for broad cross-cutting refactors, release validation, or changes whose impact cannot be bounded by targeted suites. It is not required for every isolated code change.
  - Run `vp run test:all` only for an explicit full release gate or when the changed release tooling itself requires it.
- Treat a stronger real-world check as evidence, not as an automatic reason to stack every broader check on top of it. For example, a migration fix may be best covered by focused migration tests plus a disposable copy of a representative database.
- Parallelize checks only when they are independent and resource contention is unlikely. Do not prefer parallel execution when it could make Electron or renderer suites flaky.
- In the handoff, summarize the checks run and their outcomes, including any unresolved failures. Briefly explain intentionally skipped broader checks when their omission might otherwise be surprising.

### Electron HTML5 DnD E2E

- The internal Block → Board native smoke must use the shared realistic `page.mouse` helper in `tests/e2e/electron-smoke.spec.ts` and a real `button[draggable="true"]` handle.
- Do not replace it with `locator.drop`, synthetic `dragstart`, direct `blocks:transfer`, or CDP `Input.dispatchDragEvent`; those exercise different boundaries.
- Do not use one-jump `dragTo` or invent another mouse path. Reuse the helper, which waits for the hover-only handle, crosses the activation threshold, moves in steps, and moves again inside the target to produce `dragover`.
- If `dragstart` is missing, inspect the Playwright trace for handle remount, hit target, draggable state, activation distance, and overlays before changing frameworks or adding `Input.setInterceptDrags`.
- Keep high-pressure and performance coverage on the direct typed transfer boundary; those are convergence tests, not native DnD gesture tests.

## Commit and PR Expectations

- Keep changes scoped and atomic.
- Before merging a branch into `main`, including a requested rebase-and-merge, rewrite its unpublished history into atomic Conventional Commits. Fold `wip`, review-fix, style, and formatting commits into the commits they complete, never merge a fix for a defect the same branch introduced as its own commit, and confirm that each resulting commit typechecks.
- Use Conventional Commits: `<type>(<scope>): <description>`, omitting the scope when it adds no value. Common types include `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, `ci`, and `perf`.
- Write a concise, imperative, human-readable subject that explains why the change matters. Prefer the user, product, reliability, or performance outcome over the implementation mechanism.
  - Bad: `perf(server): negotiate permessage-deflate on the websocket`
  - Good: `perf(server): cut websocket frame size by 70%+ with gzipping`
- Add a commit body only when it provides useful motivation, constraints, impact, or trade-offs. Open commit bodies and PR descriptions with a simple explanation of the problem based on the user's original request, then briefly explain the solution. Lead with user impact; include implementation details afterward only when they clarify important constraints or trade-offs.
- For multi-paragraph commit bodies, pass each paragraph as a separate `-m` argument (or use `git commit -F`); shell-quoted `\n` is literal.
- Bad: `Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.`
- Good: `My "new thread" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.`
- Update related docs in the same change when contracts or workflows change.
- Include commands run and validation outcomes in your PR notes.

## Frontend tasks

Read `docs/FRONTEND.md` for renderer construction, React Compiler, UI verification, and async test interactions. Follow `.agents/skills/general-design-guidelines/SKILL.md` for UI design.
