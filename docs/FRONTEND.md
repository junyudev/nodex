# Frontend

## Stack
- React 19 + TypeScript (`strict`)
- Tailwind CSS + local UI primitives in `src/renderer/components/ui/`
- BlockNote editor for rich card descriptions
- Atlassian Pragmatic Drag and Drop for board drag-and-drop

## Structure
- App shell: `src/renderer/app.tsx`
- Domain components: `src/renderer/components/kanban/`
- Editor subsystem: `src/renderer/components/kanban/editor/`
- Shared hooks/helpers: `src/renderer/lib/`
- NFM conversion/parsing: `src/renderer/lib/nfm/`
- Storybook workspace: `packages/storybook/` with colocated `*.stories.tsx` under `src/renderer/`

## State and Data Access
- API boundary: always go through `src/renderer/lib/api.ts`.
- Board state: `useKanban` uses a shared `kanban-store` optimistic journal (`baseBoard + pending/local overlays`) with LWW conflict superseding, rollback-on-failure, and store-derived cross-view sync.
- Card updates use typed mutation control flow: `updated | conflict | not_found | error` instead of treating stale-write conflicts as generic exceptions.
- On `conflict`, keep optimistic journal semantics: supersede conflicting overlays, refresh base board, and let surface-specific UX decide recovery (`Card Stage` inline banner with `Reload Latest` / `Overwrite Mine`).
- History/undo: `use-history.ts`.
- Project lifecycle: `use-projects.ts`.
- SSE/IPC updates are centralized in API subscription helpers.
- Live workbench navigation/session state is window-local (`sessionStorage`), while shared preferences remain in `localStorage`.
- Restart resume is a separate Electron-only path: the main process stores one durable last-window snapshot under profile-scoped `userData`, and renderer bootstrap consumes it only when a window is created from zero open windows.
- Terminal: `use-terminal.ts` manages ghostty-web lifecycle, fit/resize behavior, and PTY IPC.
- Use `@tanstack/react-form` for submitted renderer forms instead of ad hoc `useState` form state; keep per-form submit/reset logic local and use `src/renderer/lib/forms.ts` for shared event/error helpers.

## Editor Patterns
- Keep custom editor behaviors in dedicated modules under `editor/`.
- Keep schema and extension composition centralized (`nfm-schema`, `toggle-list-schema`, extension helpers).
- Add behavior regression tests next to editor helpers (`*.test.ts`).
- Preserve NFM round-trip compatibility when changing parser/serializer/adapters.

## Styling Conventions
- Global styles in `src/renderer/globals.css`.
- Reuse semantic chip/badge patterns for priority/estimate/status.
- Avoid duplicating visual rules across board and toggle-list surfaces.
- Keep selector dropdown content on the shared tokenized menu chrome in `src/renderer/components/ui/selector-menu-chrome.ts`; let trigger styling stay local to each surface.
- Theme `@pierre/diffs` instances through host `style` plus `options.unsafeCSS`; use the shared renderer helper in `src/renderer/lib/diff-presentation.ts` instead of per-surface shadow-DOM CSS or broad global selectors.

## Frontend Testing
- Run targeted tests while iterating: `bun test src/renderer/...`
- Run isolated UI harness: `bun run dev:storybook`
- Build the isolated UI harness before handoff when story code changes: `bun run build:storybook`
- Keep Storybook scenes canvas-first: use story variants, `args`, and `argTypes` for presets and controls instead of rendering custom preset/control sidebars inside story pages.
- Default renderer component tests to DOM-based coverage with Bun + `happy-dom` + `@testing-library/react`.
- Assert user-visible structure, labels, and behavior through rendered DOM queries; keep `data-testid` and raw class checks as fallback tools, not the default.
- Reserve HTML-string or server-render assertions for cases where serialized markup is the actual contract.
- Do not add source-string tests that only verify implementation text inside a file.
- Prioritize parser/editor and hook tests for regression safety.
