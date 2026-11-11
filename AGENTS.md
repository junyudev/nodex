# AGENTS.md

## **IMPORTANT Global Instructions for Agents:**

- Always commit changes after all edits are done. Do not leave uncommitted changes at the end of a task.
- Rules in this file state their reasons. Apply them with judgment: when a reason clearly does not apply to your task, adapt and say so in the handoff. The hard limits are the data, privacy, and desktop-inspection rules.
- This app has no real users or real data yet. Prefer long-term architectural correctness over short-term compatibility. Breaking changes, schema migrations, and large refactors are acceptable when they make the product model simpler and more coherent.
- For frontend design, prioritize an elegant, information-dense layout with minimal logical/visual redundancy and shallow nesting.
- Keep implementation notes, docs, changelog entries, commit messages, and handoff summaries product-native: describe what Nodex does and why, without surfacing private provenance, comparative targets, or reconstruction details unless the user explicitly asks for research notes.
- Do not read repository contents via web crawling from `raw.githubusercontent.com` because it is not stable for agent workflows. For remote repository inspection, clone the repository into a temporary local directory and read files from the local clone instead.
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
- Native application distribution gate: GitHub `Distribution Rehearsal`

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
- Keep the repository root lean. Tool configuration lives in `config/` and is passed to its tool explicitly; add a root file only when a tool cannot be pointed elsewhere.

## Architectural Preference

- Default to the long-term, architecturally clean solution over the smallest incremental patch, even when that requires broad refactors, internal API changes, schema migrations, or breaking changes inside this repository.
- This project has no real users or real data yet. Do not preserve legacy behavior, compatibility layers, duplicate paths, or awkward abstractions merely to reduce diff size.
- When choosing between a quick local fix and a deeper model-level fix, prefer the model-level fix if it simplifies ownership, removes special cases, or makes future features easier to build.
- Large refactors are acceptable, but they must still be coherent: preserve project scoping, update the source-of-truth docs, migrate affected call sites, remove obsolete code paths, and run the relevant checks.
- Do not overbuild speculative abstractions. A long-term solution should reduce conceptual complexity, not add indirection for its own sake.
- If a long-term fix is too large for one safe change, implement a clean vertical slice and document the remaining migration path instead of landing a temporary workaround.
- When designing tools or behavior for Agents, prefer soft limits over hard limits: an Agent acting for a person may do what that person may do, and how it should behave belongs in its instructions and tool descriptions. Enforce in code only other people's authority, the person's own explicit settings and data integrity. See [Agents act for people](docs/PRODUCT_SENSE.md#agents-act-for-people).

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
- Application releases, signing, feeds, promotion, Rehearsal and Recovery: `docs/release.md`
- Windows packaging and verification layers (CI, interactive VM checklist, hardware acceptance): `docs/release-windows.md`, `docs/windows-verification.md`
- Profile and Desktop configuration: `docs/CONFIGURATION.md`
- External/reference specs (Nodex Markdown and clipboard behavior): `docs/references/`

## Documentation Update Rules

Keep the docs true: when behavior, contracts, or workflows change, update the narrowest source of truth in the same change.
When you fix a defect or the user corrects your work, consider whether a fresh agent without this conversation could make the same mistake. If it could, leave the lesson at the narrowest effective seam: preferably executable (a type, validation, architecture, or a meaningful regression test), otherwise the owning document under the routing below. Skip prose for a one-off issue a test already guards.
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

## Verification

You decide what to verify. Aim for confidence that matches the change's risk: read the diff and the commits it lands on, skip checks the change cannot affect, and go deeper where it is risky, cross-cutting, or unfamiliar. One strong real-world check can replace a stack of broader suites.

In the handoff, say what you ran and how it went, and what you skipped and why. Never present unverified work as verified.

### Runners

Each runtime has its own runner; the wrong one fails, or passes, for the wrong reasons.

- Node and shared tests outside native Core/bridge contracts: `vp test run --config config/vitest.node.config.ts <path>`
- Main `.node.test.ts` files and shared Yjs/Yrs bridge tests: `vp run test:core-client <path>`
- Renderer/jsdom: `vp test run --config config/vitest.renderer.config.ts <path>`; Chromium (`*.browser.test.tsx`): `vp test run --config config/vitest.browser.config.ts <path>`
- Main/store: `vp run test:main <path>`; Electron integration: `vp run test:integration <path>`. Their native addons are built for Electron's ABI, so never run `config/vitest.main.config.ts` or `config/vitest.integration.config.ts` directly with host Node.
- Electron E2E: `vp run test:e2e tests/e2e/<spec>.spec.ts`. A standalone `--` before the file makes Playwright collect the whole suite; a focused run's banner reads `Running 1 test`.
- Semantic gate: `vp run typecheck`, the same task as `lint` and `check:semantic` with a shared cache, covers types and lint; `vp run --no-cache check:semantic` forces real analysis.
- Broader: `vp run build` for build configuration, entrypoints, packaging, or startup failures; `vp run test` when targeted suites cannot bound a change's impact; `vp run test:all` for a release gate.
- Test suites, E2E runs, and Rust tests from all worktrees queue for one computer-wide CPU budget. A `[machine-budget] ... is waiting` line is the queue working: let the command wait, in the background if needed, rather than cancelling or retrying it. See [Sharing the computer between checkouts](docs/development.md#sharing-the-computer-between-checkouts).

### Blind spots

- Only the curated Nightly set runs Electron E2E automatically, so other specs drift silently. When you rename, move, or remove a UI surface, accessible name, or `data-*` hook, `git grep` `tests/e2e/` and update the specs that use it; run them when the change could plausibly break them.
- Pushing to `main` without a pull request skips Main CI's static repository contracts (version surface, workflows, ownership, dependency audits); `vp run verify:static` covers them.
- CI fails on lint warnings above the per-file baseline and on new React Compiler bailouts. After removing some, `vp run lint:baseline` or `vp run react-compiler:baseline` records the lower counts. Never raise a baseline to admit new ones; mark a deliberate lint exception with `oxlint-disable-next-line <rule> -- <reason>`.

### Writing tests

- Test behavior and domain contracts, not implementation. Avoid source-string checks, long `className` matching, and broad `textContent.includes(...)` unless the string is a real user-visible or accessibility contract.
- Renderer tests are act-clean: an `act(...)` warning is a failing test. Prefer awaited Testing Library patterns. Wrap low-level events, timers, and gestures in `await act(async () => { ...; await Promise.resolve(); })`, then await the observable outcome, and release gestures in `try/finally`.
- Let positive waits inherit the deliberately generous defaults in [test-timeouts.ts](config/test-timeouts.ts). Use an explicit short timeout only when the wait is expected to time out.
- Renderer seams and conventions live in `docs/FRONTEND.md`; scenario consumers, fixture classes, and evidence boundaries live in `docs/development.md`.

### Real data

- Never point development Core at the live Profile, copy `nodex.db`/WAL files by hand, or symlink Profile data. Snapshot it with `vp run dev --home <absolute-snapshot-home> --from-profile <profile-home>` under the primary checkout's `runs.local/`.
- Snapshots are local evidence: keep them out of CI and commits, do not upload their databases, assets, or logs, and do not attach screenshots or traces with user content. Import Agent authentication only through the launcher's private-file flags, and only when the test needs Agent execution.
- A snapshot pass helps when behavior plausibly depends on real data shape, history, or scale. It supplements a distilled regression test and never replaces one.

For UI iteration and visual review, `vp run dev --home <absolute-task-home> --seed <scenario-id>` gives a seeded, persistent environment with HMR.

### Electron HTML5 DnD E2E

- The internal Block → Board native smoke must use the shared realistic `page.mouse` helper in `tests/e2e/electron-smoke.spec.ts` and a real `button[draggable="true"]` handle.
- Do not replace it with `locator.drop`, synthetic `dragstart`, direct `blocks:transfer`, or CDP `Input.dispatchDragEvent`; those exercise different boundaries.
- Do not use one-jump `dragTo` or invent another mouse path. Reuse the helper, which waits for the hover-only handle, crosses the activation threshold, moves in steps, and moves again inside the target to produce `dragover`.
- If `dragstart` is missing, inspect the Playwright trace for handle remount, hit target, draggable state, activation distance, and overlays before changing frameworks or adding `Input.setInterceptDrags`.
- Keep high-pressure and performance coverage on the direct typed transfer boundary; those are convergence tests, not native DnD gesture tests.

## Commit and PR Expectations

- Keep changes scoped and atomic.
- Before merging a branch into `main`, including a requested rebase-and-merge, rewrite its unpublished history into atomic Conventional Commits. Fold `wip`, review-fix, style, and formatting commits into the commits they complete, and never merge a fix for a defect the same branch introduced as its own commit. The merged result must typecheck; intermediate commits need not be verified one by one.
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
