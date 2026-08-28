# Settings Route Behavior

## Intent and ownership

Settings is a Workbench route, not a modal or overlay. It replaces the main
Workbench body while keeping window-level chrome and return context intact. The
rail owns navigation and search only; every section page owns its data,
loading/empty/error state, validation, and mutations.

The Settings surface reuses Workbench sidebar material and shared UI primitives
without importing Project-folder semantics, group actions, or resize behavior.
Each page renders one `main`/`h1` hierarchy with section-level `h2`/region
boundaries and a single content scroll area.

## Canonical routes

- Top-level sections use `/settings/:section`.
- Browser details use `/settings/browser/<detail>`.
- Browser overview subsections use hash anchors.
- Open-source notices use the focused `/settings/open-source-licenses` detail
  route owned by General.

Unknown paths present the default section without rewriting the URL or accepting
legacy aliases. Settings links use in-app navigation and remain distinct from
file references; file-opening behavior never intercepts a Settings route.

`Back to app` restores the owning Workbench return location. Settings itself is
outside app-window Back/Forward Scene checkpoints, so it does not create a
second Scene layout owner.

## Section catalog

One canonical catalog owns each top-level section's stable route id, page key,
group, label, search catalog, and app-owned icon. Page component registration is
keyed by page key rather than by route slug.

The desktop groups are:

- Personal: General, Import, Appearance, Agent, Keyboard shortcuts.
- Integrations: Browser, Computer use.
- Coding: Hooks, Git, Environments, Worktrees.
- Workspace: Pages.
- Data & recovery: Backups.

The Worktrees section follows
[Codex Managed Worktree Lifecycle Behavior](codex-managed-worktree-lifecycle-behavior.md)
for root preferences, automatic retention, grouped inventory, and safe removal.

Browser subsections and detail pages remain children of Browser and do not
become independent rail entries.

General owns Permissions, general behavior, Composer, Files & links, and
Notifications. Browser owns General, Autofill and passwords, Extensions,
Downloads, Permissions, Site permissions, Developer mode, and its focused
history/manager detail pages. Pages owns only the Block → Page task-shorthand
import preference defined by
[Task Shorthand Page Promotion Behavior](task-shorthand-page-promotion-behavior.md).

## Search

`Search settings…` is a renderer-local search over the canonical section
catalog. Its normalized index may include titles, subtitles, group headings,
row labels and descriptions, option labels, aliases, and hidden runtime terms
such as Project names. Hidden terms improve matching but do not appear in the
visible result label.

Browser child terms contribute to the single Browser result; Browser remains
the navigation owner. `Cmd/Ctrl+F` focuses and selects the search field, Escape
clears it, Arrow Up/Down wraps the highlighted result, and Enter navigates only
when a result is highlighted. Navigation preserves the active query and targets
the owning section or anchor.

Settings search uses its dedicated ranking/list-navigation helpers rather than
the command-palette index.

## Page and control composition

Section pages use the shared Settings primitives. A row presents a primary
label, compact explanatory copy, and an end-aligned control; adjacent rows use
the shared inset divider. Descriptions wrap instead of truncating explanatory
content.

Single-choice controls use the shared dropdown facade and boolean preferences
use the shared switch. Settings-specific artwork comes from the app-owned icon
set. Exact spacing, icon geometry, motion, and surface tokens remain executable
in those shared primitives and focused Storybook stories.

The Settings rail preserves the same renderer-transparent native vibrancy as
the normal sidebar. Section pages render only the main content surface and do
not add another sidebar-like card or nested full-page scroll container.

Sans font size defaults to 15px and scales the renderer's shared sans typography
tokens. Code font size defaults to 14px and scales the shared code/editor token.
Both are Profile preferences, not Window Session layout.

Appearance also owns the renderer-local `Reduced motion` preference. `System`
tracks the operating-system media query, `On` reduces hook-driven interface
motion, and `Off` allows it. The resolved preference governs shared activity
spinners, Browser tab loading chrome, and Motion-based interface transitions;
CSS shimmer and loading-placeholder media rules continue to honor the operating
system directly. The preference is app-scoped presentation, persists in renderer
storage, and is neither Window Session layout nor main-process state.

General also owns application update preferences. Automatic checks remain a
boolean preference. The channel is `stable` or `nightly`; Stable is the
recommended default for stable builds, while Nightly builds default to Nightly
until the user makes an explicit persisted choice. Main-owned updater status is
the authority for the selected channel and whether it may change. Changes are
allowed only while idle, up to date, or in a recoverable error state. A
successful change clears stale update metadata and does not start a check.
Switching from Nightly to Stable never offers an older Stable build.

The selector uses the shared Settings dropdown and is disabled during checks,
downloads, ready-to-install state, and installation. Main switches the packaged
updater before persisting the choice, rolls it back if persistence fails, and
serializes mutations across windows.

## Deep links and feature-owned state

Feature entry points may open a Settings section with explicit context. Card
Stage environment selectors stay compact choosers and route `Environment
settings` into Environments with the selected Project/config identity. The
Environments page owns workspace selection, summary, editing, parse errors,
creation, and environment-variable presentation.

An environment summary uses the environment name as its page heading and keeps
Setup, Cleanup, and Actions in one flat detail flow. Setup and Cleanup expose
platform selection only when a script exists. Selecting a platform without an
explicit override previews the default script and identifies that fallback.
Actions disclose multiline commands without turning the entire row into an
interactive control.

The editor always exposes Default, macOS, Linux, and Windows slots for Setup and
Cleanup. An Action with both name and command blank is a valid draft and is
omitted when saved; an Action with only one of those fields blocks saving and
identifies the missing counterpart. Saves include the revision that was read
from disk. If that revision is stale, the editor keeps the draft and requires an
explicit Discard edits action to refetch the canonical file; it never silently
overwrites an external change. Leaving the editor discards its local draft.

Computer use consumes one typed Main snapshot and owns its verification,
availability, and action state. Browser detail pages own Browser-specific
subroutes and anchors. Dynamic section state does not expand the top-level rail
catalog or become duplicated shell state.

Storybook renders the production environment components with preloaded query
caches or explicit editor callbacks. Stories cover summary, platform fallback,
expanded Actions, validation, conflict, overlays, and narrow layouts without a
second feature-specific service implementation or live desktop IPC.
