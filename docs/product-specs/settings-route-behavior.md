# Settings Route Behavior

## Intent and ownership

Settings is a Workbench route, not a modal or overlay. It replaces the main
Workbench body while keeping window-level chrome, the Home/Space navigation
rail, and return context intact. The Settings section rail owns section
navigation and search only; every section page owns its data,
loading/empty/error state, validation, and mutations.

Settings navigation, search, and Back to app are available immediately on first
entry. Only the selected section loads its page code. While that code loads,
the content surface shows the section heading and a loading status; navigation
stays interactive. Switching sections immediately selects the new destination,
and completion of a previous page load never restores the old page. Page-load
failures stay within the content surface so users can leave or choose another
section.

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

`Back to app` restores the actual Workbench return route, including Inbox,
Scheduled, and Space's tabs and selection. Changing Settings sections and
reopening the window retain that same origin. The Home/Space rail keeps that return destination selected;
its buttons leave Settings through normal Workbench navigation. Settings itself is
outside app-window Back/Forward Scene checkpoints, so it does not create a
second Scene layout owner.
Resizing Settings preserves the hidden Workbench panel layout. Workbench
responsive adjustments resume when returning to that surface.

## Section catalog

One canonical catalog owns each top-level section's stable route id, page key,
group, label, search catalog, and app-owned icon. Page component registration is
keyed by page key rather than by route slug.

The desktop groups are:

- Personal: Account, General, Appearance, Voice, Keyboard shortcuts.
- AI: Agents, Conversations, Hooks.
- Integrations: Browser, Computer use.
- Coding: Git, Environments, Worktrees.
- Workspace: Pages, Inbox.
- Data & recovery: Data controls, Backups.

Account owns the optional Nodex identity and its connection controls, following
[Nodex Account Login](nodex-account-login-behavior.md). The rail avatar menu
and the Account page observe the same Profile account state. Native Agent
authentication remains separate.

The Worktrees section follows
[Codex Managed Worktree Lifecycle Behavior](codex-managed-worktree-lifecycle-behavior.md)
for root preferences, automatic retention, grouped inventory, and safe removal.

Browser subsections and detail pages remain children of Browser and do not
become independent rail entries.

Conversations owns source discovery, destination selection and independent conversation imports
for Codex and Claude, as described in
[Native Conversation Import Behavior](native-conversation-connection-behavior.md), and imports of
conversations saved by ACP Agents, as described in [ACP Agent behavior](acp-agent-behavior.md).
Agents shows one collapsible card per Agent kind, in the order Codex, Claude Code, OpenCode and
Other agents. Every card starts closed with a short status summary, so the page reads as a list of
Agents; opening one reveals its setup, and cards stay open while Settings remains on Agents. A search
result, Manage link or deep link that names an Agent, profile or ACP instance opens its card on
arrival; one that names only the page opens it with every card closed. Claude Code and OpenCode list
one row per profile, and Other agents one row per ACP instance, each expanding in place.
Other agents owns ACP instance setup, sign-in and model services, as described in
[ACP Agent behavior](acp-agent-behavior.md).
Agents > Codex owns the speed new Codex chats start with, and Copy setup. Setup migration is separate from conversation import and targets
shared Codex configuration.

General is grouped by what a setting affects, in this order: App (window restore, the running
version with its update actions and preferences, open source licenses), Chats, Writing, Files &
links, Notifications, Privacy (crash reports, session replays, product telemetry and web analytics)
and Troubleshooting (app-server request diagnostics). Each preference is its own row; a row's
description adds its current state only when that differs from what the switch shows, such as an
environment override, a prerequisite or a change that applies after restart. A search result for a
General setting lands on its group. Request diagnostics are captured only while the General page is
open and show bounded recent request timing, scheduling, transport, and failure data for local
troubleshooting.
Browser owns General, Autofill and passwords, Extensions,
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
the owning section or anchor; a result inside a collapsed group, such as an Agent
card or Appearance's Advanced group, opens that group on arrival. A Command K
Settings command lands the same way for the query that found it.

Results whose section name matches come first, then sections where one setting
holds the whole query, then sections that only mention each word; ties keep rail
order. A sign-in search therefore leads with Account and still offers the Agent
sign-in under Other agents.

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
in those shared primitives and reviewed in the seeded Settings surface.

The Settings section rail uses the normal sidebar's shared material and palette.
Section pages render only the main content surface and do
not add another sidebar-like card or nested full-page scroll container.

General's Troubleshooting group holds an App server requests disclosure within one shared Settings
surface. Expanding it starts request capture while General is active; collapsing
it or leaving Settings stops capture. The expanded view shows recorded requests
by host, with request details, payload copying, failure filtering and host-local
clearing. Dividers separate these groups without additional framed cards.

The default appearance uses a `#111111` main surface with `#fcfcfc` primary
text in dark mode, and `#ffffff` with `#0d0d0d` text in light mode. Controls,
menus, borders, and secondary text derive from the same resolved palette.
Conversation bubbles and the primary send action have dedicated color roles.
Switching appearance updates these roles together, including content that uses
the shared legacy background and foreground aliases. Native sidebar material
and typography preferences remain independent of the palette.

Appearance groups Mode and Theme in Visual style. Theme groups `Accent color`
with the UI `Font`. Advanced starts collapsed and owns UI, Content and Code font sizes,
Reduce motion, Content and Code font families, and `Separate light/dark modes`.
The latter reveals both appearance editors without switching Mode, copying
preferences, or changing saved values. When disabled, the editor presents the
currently resolved appearance. Changing an inactive appearance preserves the
active palette and font choices.
Settings searches targeting an Advanced control expand that group on arrival.
Its Reset action restores the three sizes, Content and Code families for both
appearances, and Reduce motion, then returns to a single appearance editor.
Mode, UI font families and accents keep their saved values.

Appearance includes an `Accent color` picker with Default, Blue, Green, Yellow,
Pink, Orange, Purple, and Black presets; Black is labeled White in dark mode.
Named presets apply one coordinated palette to conversation send/stop actions,
user message bubbles, links, focus rings, text selection, switches, and charts.
Lifecycle, destructive, and categorical colors retain their own semantic roles.
Default resolves to the Blue palette while retaining its Default label and
saved preference. The picker trigger reflects that effective palette. Black
provides neutral conversation actions, with a solid dark bubble in light mode
and a neutral bubble in dark mode.

`Custom` uses a six-digit Hex field and continuous color picker. It starts from
the active accent color, commits complete colors immediately, and discards an
incomplete draft on blur or appearance change. Accent colors are independent for
light and dark appearances. Selecting a named preset replaces only the edited
appearance's accent. Custom colors drive
the accent-derived palette while conversation send/stop actions and bubbles
use their neutral semantic surfaces. Foreground contrast is resolved with the
same palette, including saturated blue colors.

Appearance and accent preferences persist in the renderer's browser storage
and synchronize between windows sharing that storage. Renderer initialization
applies the saved accent before application content mounts; switching appearance
or accent updates all coordinated roles before the next paint.

Typography settings independently control UI size (14px, 11–16px), code size
(12px, 8–24px), and Page content size (14px, 12–24px). UI, content, and code font
families are selected separately for light and dark appearances. Content follows
the UI font by default. These Profile presentation preferences persist and
synchronize between windows sharing browser storage; startup restores them
before application content paints. See [Typography behavior](typography-behavior.md)
for role ownership and size/line-height rules.

Advanced presents the independent Page body size as `Content font size`, marked
`Pages`. Page title size continues to follow the UI heading scale.

Appearance also owns the renderer-local `Reduce motion` preference. `System`
tracks the operating-system media query, `On` reduces hook-driven interface
motion, and `Off` allows it. The resolved preference governs shared activity
spinners, Browser tab loading chrome, and Motion-based interface transitions;
CSS shimmer and loading-placeholder media rules continue to honor the operating
system directly. The preference is app-scoped presentation, persists in renderer
storage, and is neither Window Session layout nor main-process state.

General > Composer includes `Show predictions`, enabled by default. It controls
next-message predictions across the current Profile and synchronizes immediately
between windows. Turning it off cancels pending predictions and clears their
cached previews; text already accepted into a draft stays editable. The preference
persists in Profile settings and applies without restarting the app.

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

Focused renderer tests exercise the production environment components through
injected query and editor boundaries. Review visual composition and narrow
layouts in the seeded Settings surface; native persistence and authority use
the Settings Electron scenarios.
