# AGENTS.md

> **IMPORTANT for agents:** Always commit after all edits are done (with prefix like feat/fix/doc/refactor/chore). Do not leave uncommitted changes at the end of a task.

## Global Instructions
- This app has no real users or real data yet. Feel free to make whatever huge changes/refactors you want and do not worry about it.
- For frontend design, prioritize an elegant, information-dense layout with minimal logical/visual redundancy and shallow nesting.
- Do not read repository contents via web crawling from `raw.githubusercontent.com` because it is not stable for agent workflows. For remote repository inspection, clone the repository into a temporary local directory and read files from the local clone instead.
- When writing bun unit tests, be aware that `expect` is of type `expect(value: unknown): { toBe: (expected: unknown) => void; toBeTrue: () => void; toBeFalse: () => void; not: { toBeNull: () => void; }; }` 
  - there is ONLY `toBe`, `toBeTrue`, `toBeFalse`, `not.toBeNull`.
  - there is NO `toBeUndefined`, `toEqual`, `toBeNull` or `toContain`.
- DO NOT write tests that only assert a source file contains a string (source-string tests); that is redundant with the implementation and does not validate behavior. Prefer checking generated CSS/build output or a real rendered/runtime outcome.


## Project Overview
Nodex is a local-first, block-based agent orchestrator.
It ships as an Electron desktop app plus a CLI/HTTP API backed by SQLite.

## Setup Commands
- Install deps: `bun install`
- Dev app: `bun run dev`
- Build: `bun run build`
- Package installers: `bun run package`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`
- Unit tests: `bun test`

## Runtime and Tooling
- Package manager: Bun
- Language: TypeScript (`strict` mode)
- Desktop shell: Electron + electron-vite
- Frontend: React 19 + Tailwind + Radix + BlockNote/Prosemirror
- Backend in main process: Hono + better-sqlite3

## Code Style
- **DRY**: Always keep code DRY. Extract shared hooks, helpers, and patterns instead of duplicating.
- **Tailwind over custom CSS**: Use Tailwind utility classes. Avoid inflating `globals.css` with new custom class rules.
- Keep data validation at boundaries (`src/main/http-server.ts`, `src/main/kanban/card-input-validation.ts`).
- Prefer pure helpers in `src/renderer/lib/` for reusable behavior.
- Keep renderer transport-agnostic by going through `src/renderer/lib/api.ts`.
- Preserve project scoping for stateful UI and server operations.

## Architecture
Read `ARCHITECTURE.md` first for system boundaries and dependency flow.

## Documentation Map
Use these docs as the source of truth:
- System codemap and invariants: `ARCHITECTURE.md`
- Execution-plan format and requirements: `docs/PLANS.md`
- Frontend conventions and editor patterns: `docs/FRONTEND.md`
- UI design guidance for agent-built surfaces: `.agents/skills/general-design-guidelines/SKILL.md`
- Product principles and tradeoffs: `docs/PRODUCT_SENSE.md`
- Reliability model (backups, SSE/IPC sync, ops): `docs/RELIABILITY.md`
- Security model and hardening checklist: `docs/SECURITY.md`
- Keyboard shortcuts reference: `docs/KEYBOARD_SHORTCUTS.md`
- Current quality grading and gaps: `docs/QUALITY_SCORE.md`
- Implementation learnings and regression caveats: `docs/ENGINEERING_LEARNINGS.md`
- Product behavior specifications: `docs/product-specs/`
- External/reference specs (NFM format, examples): `docs/references/`

## Documentation Update Rules
Documentation maintenance is an active, required responsibility for every agent task.

When behavior changes, update the narrowest source-of-truth doc:
- User-visible behavior/API contract changes: `docs/product-specs/nodex-product-spec.md`
- Architecture boundary changes: `ARCHITECTURE.md`
- New reusable UI design guidance for agents: `.agents/skills/general-design-guidelines/SKILL.md`
- New implementation caveat/regression learning: `docs/ENGINEERING_LEARNINGS.md`
- New reliability/security expectation: `docs/RELIABILITY.md` or `docs/SECURITY.md`

Treat `CHANGELOG.md` as a required deliverable for any user-visible change:
- Keep an `Unreleased` section at the top.
- Write for humans, not commit-log style.
- Only include externally relevant changes:
  - Added
  - Changed
  - Deprecated
  - Removed
  - Fixed
  - Security
- Do not add entries for pure refactors, formatting, comments, test-only changes, or internal tooling changes unless they affect users.
- Use one bullet per user-visible change.
- Prefer impact-oriented wording, not implementation wording.

## Testing Expectations
- Prefer targeted tests while iterating: `bun test <path-to-test>`
- Run full checks before handoff:
  - `bun run typecheck`
  - `bun run lint`
  - `bun test`

## Commit and PR Expectations
- Keep changes scoped and atomic.
- Update related docs in the same change when contracts or workflows change.
- Include commands run and validation outcomes in your PR notes.
