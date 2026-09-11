---
name: general-design-guidelines
description: General design guidelines for building premium, Linear/Arc-inspired UI. Use when creating or modifying frontend components, pages, dropdowns, settings panels, sidebars, poppers, command palettes, or any user-facing interface. Enforces a luxury, ultra-refined aesthetic with intentional spacing, semantic surface treatments, and crisp micro-animations.
---

# General Design Guidelines

Premium, Linear/Arc-inspired design system. Every pixel intentional. Ultra-refined, precise, with crisp animations.

## Core Philosophy

The aesthetic is **luxury tool-grade software** — closer to Linear, Arc, Notion, and Raycast than to generic SaaS. The UI should feel like a finely machined instrument: subdued, information-dense, and quietly confident.

**Key tenets:**

- Every element earns its space — no decorative filler
- Use the least assertive treatment that still communicates identity, boundary, and affordance
- Separate object boundaries from hierarchy: hairline outlines identify neutral objects; shading communicates state, category, selection, or emphasis
- Flat, single-surface layouts — no gradient heroes, no nested bordered cards
- Tight, intentional spacing — never loose or "airy" by default
- Quiet until interacted with — reveal visual depth on pointer hover, active, or open states; do not make hidden chrome keyboard-focusable unless the surface contract explicitly requires it

## Visual Hierarchy

### Match treatment to meaning

Boundary and hierarchy are different visual jobs. A boundary tells the user that
content is one discrete object or control. Hierarchy tells the user what is
active, selected, categorized, or important. Choose the quietest treatment that
performs the required job, and escalate only when semantics require it:

| Treatment | Default role                                                           | Typical examples                                                           |
| --------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Plain     | Content needs no independent boundary                                  | Metadata, static values, low-emphasis labels                               |
| Outline   | Neutral content is a discrete interactive object or reference          | Files, attachments, Page relations, linked chats, compact neutral controls |
| Tinted    | Color or shading carries category, state, selection, or hover feedback | Status, priority, tags, selected segments, hover states                    |
| Solid     | The action or state must dominate the local composition                | Primary actions, strong selection, critical emphasis                       |

Neutral reference chips default to a transparent background with a semantic
`0.5px` hairline outline. Use an inset ring when preserving chip geometry
matters. A resting neutral chip does not earn a filled background merely by
being clickable. On hover or selection, it may gain a subtle foreground-derived
tint.

Categorical chips may use semantic tints because their color carries meaning.
Plain content should remain plain when neither boundary nor state needs to be
communicated. Do not outline every value, or replace shading clutter with border
clutter.

```css
/* Neutral reference object */
background: transparent;
box-shadow: inset 0 0 0 0.5px var(--border);

/* Semantic category or interaction state */
background: color-mix(in srgb, var(--foreground) 5%, transparent);
color: color-mix(in srgb, var(--foreground) 50%, transparent);

/* Hard-coded gray is never a semantic treatment */
background: #f5f5f5;
border: 1px solid #e0e0e0;
color: #999;
```

**Practical token pattern** (Tailwind-style):

- `ring-[0.5px] ring-inset ring-token-border` — neutral object boundary
- `bg-transparent` — resting neutral reference or control
- `bg-token-foreground/5` — semantic tint or subtle hover state
- `bg-token-foreground/10` — active or selected state
- `text-token-text-secondary` — de-emphasized text (implemented via opacity)
- `text-token-description-foreground` — tertiary/metadata text
- `opacity-75` resting → `opacity-100` on hover/active — for sidebar nav items

For shared agent-task, conversation-activity, and progress surfaces, prefer the
semantic task family instead of mixing legacy aliases:

- `text-info` — running or successfully completed step
- `text-danger` — failed step or actionable error
- `text-tertiary` — pending step and low-emphasis metadata
- `semantic-text-secondary` — completed summary or secondary measurement
- `border-default` — shared activity/output hairline
- `bg-text/10` and `bg-text-info` — progress track and value

Apply one role to the label and its icon; SVGs use `currentColor`. Do not read
host/editor variables directly from component code. Product-native Database,
Board, Canvas, and editor roles may continue using their established token
families when task semantics do not fit.

When a shared activity primitive accepts lifecycle state, make that state
explicit at every call site; do not default an unknown activity to completed.
For generated or bridged theme values, a custom property is usable only when
its complete `var(...)` chain resolves in the consumer's window and color
scheme. Keep geometry foundations (including radius scale) product-owned and
cover them with computed-style browser tests.

### Text hierarchy

Use **three levels maximum** in any single view:

| Level     | Token / treatment                        | Usage                        |
| --------- | ---------------------------------------- | ---------------------------- |
| Primary   | `text-token-text-primary` / full opacity | Titles, labels, active items |
| Secondary | `text-token-text-secondary`              | Descriptions, body text      |
| Tertiary  | `text-token-description-foreground`      | Hints, metadata, shortcuts   |

## Surfaces & Containers

### Flat sections with subtle dividers — not nested bordered boxes

Settings panels, grouped form rows, and option lists use a **single flat card** with internal dividers:

```css
/* ✅ Good — flat card, hairline internal dividers */
.settings-card {
  background: var(--bg-fog); /* very subtle tint, e.g. token-bg-fog */
  border: 0.5px solid var(--border); /* hairline outer ring */
  border-radius: var(--radius-lg); /* 8-10px */
}
.settings-card > * + * {
  border-top: 0.5px solid var(--border); /* internal dividers */
}

/* ❌ Bad — nested bordered boxes */
.settings-group {
  border: 1px solid #ddd;
  border-radius: 12px;
  padding: 16px;
}
.settings-group .item {
  border: 1px solid #eee;
  border-radius: 8px;
}
```

### Single flat surface — no gradient heroes

Main content areas use a **solid background**, never a gradient or patterned hero. The focus is the content, not the container.

### Surface patterns from exemplars

| Component         | Background                        | Border                               | Radius              |
| ----------------- | --------------------------------- | ------------------------------------ | ------------------- |
| Settings card     | `bg-token-bg-fog`                 | `border-[0.5px] border-token-border` | `rounded-lg` (8px)  |
| Dropdown / popper | `bg-token-dropdown-background/90` | `ring-[0.5px] ring-token-border`     | `rounded-xl` (12px) |
| Sidebar           | `bg-token-surface-secondary`      | none                                 | —                   |
| Main surface      | `main-surface` (solid)            | none                                 | —                   |
| Switch (on)       | `bg-token-charts-blue`            | none                                 | `rounded-full`      |
| Switch (off)      | `bg-token-foreground/10`          | none                                 | `rounded-full`      |

## Spacing

### Tight spacing, intentional whitespace

Default spacing is **tighter than most frameworks**. Whitespace is earned, not default:

- **Row items:** `p-3` (12px) for settings rows, `px-row-x py-row-y` for menu items
- **Section gaps:** `gap-[var(--padding-panel)]` between card sections
- **Internal gap:** `gap-1` to `gap-1.5` (4–6px) between label and description
- **Icon-to-text:** `gap-1.5` to `gap-2` (6–8px)
- **Menu items:** `min-height: 28px`, `font-size: 14px`, `padding-inline: 8px`

### Spacing DO NOTs

- Never use `p-6` or larger as default card padding
- Never use `gap-4` or larger between list items
- Never add padding "just to look spacious" — density is a feature

## Interactive States

### Do not add container focus rings by default

Do not add `focus-within` rings to a wrapper merely because a nested input or
control can receive keyboard focus. Match the established surface and the
explicit product/reference behavior first. If a focus affordance is genuinely
required, keep it local to the focusable control and prefer `focus-visible` so
pointer interaction does not introduce extra chrome. Use a wrapper-level
`focus-within` treatment only when the surface contract explicitly calls for
the entire compound control to appear focused.

### Strong active state indicators

Active/selected items must be **unmistakable** without being garish:

```css
/* Sidebar nav */
.nav-item {
  opacity: 0.75;
}
.nav-item:hover {
  opacity: 1;
  background: var(--list-hover-bg);
}
.nav-item[active] {
  opacity: 1;
  background: var(--list-active-bg);
  font-weight: normal;
}

/* Segmented control (e.g. Light/Dark/System) */
.segment {
  color: var(--description-fg);
}
.segment[pressed] {
  color: var(--foreground);
  background: var(--foreground-5);
}

/* Dropdown item */
.menu-item:hover {
  background: var(--list-hover-bg);
}
.menu-item[checked] {
  /* show checkmark icon, no background change */
}
```

### Button styles

| Variant         | Background               | Border               | Shape          |
| --------------- | ------------------------ | -------------------- | -------------- |
| Ghost (toolbar) | transparent              | `border-transparent` | `rounded-full` |
| Ghost hover     | `bg-token-foreground/5`  | —                    | —              |
| Outlined        | transparent              | semantic `0.5px`     | context-owned  |
| Tinted          | `bg-token-foreground/5`  | `border-transparent` | `rounded-lg`   |
| Tinted active   | `bg-token-foreground/10` | —                    | —              |
| Primary (send)  | `bg-token-foreground`    | —                    | `rounded-full` |
| Disabled        | same + `opacity-40`      | —                    | —              |

### Chips and compact tokens

- Use outline for neutral references and resources whose object boundary helps
  recognition or interaction: File, Attachment, Relation, linked Page, and
  linked chat.
- Use tint for categorical values whose color is meaningful: Status, Priority,
  Tag, and comparable option-backed values.
- Use plain text for values that do not need a discrete hit target or object
  identity.
- Keep dedicated add and remove actions visually separate from value chips;
  they normally remain ghost controls. A compact `+N` summary may inherit the
  value-chip treatment when it represents hidden values, even if it also opens
  the complete collection.
- When one trigger wraps several chips, hover each chip or the intended target,
  not a large shared rectangle behind the whole value lane.
- Preserve one semantic treatment across equivalent appearances. A Page
  reference should not become filled solely because it appears in another
  Property row.

## Dropdowns & Poppers

Dropdowns are **frosted glass** with a subtle shadow — they float above content, not beside it:

```css
.dropdown {
  background: color-mix(in srgb, var(--dropdown-bg) 90%, transparent);
  backdrop-filter: blur(12px); /* frosted glass */
  border-radius: 12px; /* rounded-xl */
  box-shadow: var(--shadow-lg);
  outline: 0.5px solid var(--border); /* ring-[0.5px] */
  padding: 4px; /* px-1 py-1 */
}
.dropdown-item {
  border-radius: 8px; /* rounded-lg */
  padding: var(--row-x) var(--row-y);
  font-size: 14px; /* text-sm */
}
.dropdown-item:hover {
  background: var(--list-hover-bg);
}
```

Use one shared dropdown chrome system across selector-style surfaces. App-owned Select, Dropdown, and selector Popover adapters should share the same surface, row, divider, and motion treatment by default. Triggers can stay context-specific: toolbar pills, dialog fields, and inline chip controls do not need identical trigger chrome as long as their poppers resolve to the same floating menu language.

Single-value selectors use the shared `NodexOptionPicker` seam rather than mapping menu items at feature call sites. Closed, bounded enums such as direction or access level use `search="none"`; data-driven or growing catalogs such as models, Properties, options, Databases, projects, and timezones use `search="filter"`. A filtered selector uses combobox/listbox semantics rather than placing an ad hoc input inside an action menu. Database Property editors that require domain behavior such as multi-selection, option creation, registry loading, or pagination keep those capabilities in `PropertyOptionPicker`.

Database Page Property entry points must resolve their leading icons through `dataSourcePropertyIcon`, matching Page Stage. Option-backed entry points must use the actual `PropertyOptionPicker` content in an app-owned context submenu's lazy `renderContent` boundary; they must not reproduce Property option rows, search, selected-state logic, pagination, or semantic Status/Priority/Estimate/Tags presentation. Host adapters preserve the picker's complete capability contract, including option creation and error propagation, instead of silently making one host read/select-only. A context-specific scalar draft/commit editor is appropriate for text and number Properties because Page Stage's inline input is not a complete menu interaction. A Property submenu is already the editor-opening action: compound editors such as Date and Relation must embed their shared actionable content directly, never another `Empty` or current-value trigger that requires a second activation. ContextMenu `Content` or `SubContent` is the sole visual surface owner; never put another fixed-width dropdown Surface inside it, because duplicated margins and overflow clip shadows and create horizontal scrollbars.

All action context menus use the deep app-owned module in `@/components/ui/context-menu`; feature code never imports a third-party ContextMenu or composes raw engine parts. Submenu rows stay lightweight and pass expensive editors, filtering, registry reads, or candidate construction through `renderContent`, which is not evaluated until open. Repeated Card/List/Tree surfaces mount one context-menu host and resolve the event target, rather than mounting one complete menu tree per item. Pointer movement activates an enabled submenu immediately, same-level switching remains local to those two submenu instances, and the root action surface has no entry animation. Preserve WAI-ARIA keyboard semantics, collision flipping, and pointer-safe passage into an open submenu.

- Default action menus are content-sized within a compact 172–240px range. Use a wider semantic size only when the content demands it; never use a fixed width that leaves obvious empty space.
- Shared menu-item primitives own leading-icon hierarchy: 16px, `shrink-0`, secondary color at rest, and primary color on hover/focus. Feature menus only provide the semantic icon or an intentional accent.
- Use `…` only when completing the command requires missing information or an additional choice. Immediate and confirmation-only commands use plain labels, for example `Archive` rather than `Archive…`.

## Dialogs

All modal dialogs use the shared Nodex dialog surface by default. `NodexDialogContent` owns the overlay, centered placement, frosted background, hairline ring, shadow, radius, overflow, and close control. Do not introduce provenance- or feature-named chrome variants.

Compose ordinary dialogs from the shared anatomy:

- `NodexDialogFrame` or `NodexDialogForm` owns the outer padding and typography context.
- `NodexDialogHeader`, `NodexDialogBody`, and `NodexDialogFooter` establish the vertical rhythm.
- `NodexDialogAction` provides the ghost, primary, and danger footer actions.
- Choose a semantic `size` on `NodexDialogContent`; avoid recreating widths with one-off surface classes.

Complex dialogs may keep a purpose-built internal layout while inheriting the default surface. Use `unstyledContent` only when the dialog content is itself a complete surface, such as a full-screen media viewer or a position-sensitive command palette. Keep this exception explicit at the call site.

### Modal ownership follows the React tree

A DOM portal changes placement, not React ownership. Events from portaled
content still bubble through the component that rendered the portal. Therefore,
rendering a `NodexDialog` inside a draggable/clickable row, menu trigger, route,
or other interactive subtree can activate that ancestor even though the dialog
appears under `document.body`.

Use this ownership decision before implementing any modal:

| Surface                                                                                   | Required owner                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form, chooser, manager, or multi-step dialog whose lifetime is independent of its trigger | Open through `src/renderer/lib/modal-registry.tsx`; render only from the renderer-window `NodexModalHost`                                                         |
| Dialog opened from a dropdown command                                                     | Record the pending command in `onSelect`, then call `openModal(...)` from `onCloseAutoFocus` after the dropdown closes                                            |
| Short confirmation that intentionally belongs to one mounted action boundary              | May stay local only when that boundary contains the trigger and its portaled descendants and stops pointer/click activation from reaching an interactive ancestor |

Hard rules:

- Do not render an application modal as JSX beneath the row/menu/route that
  triggers it. A local `stopPropagation()` patch is not a substitute for correct
  ownership and still couples the modal lifetime to the trigger subtree.
- Define registered modal components at module scope. The registry deduplicates
  by component identity and preserves the mounted entry key when props change.
  If one component can be retargeted to another resource, key its stateful inner
  content by that semantic resource identity so draft/confirmation state cannot
  leak across targets.
- For a permitted local confirmation, add a containment guard around the whole
  action boundary—not just the trigger button. Stop `pointerdown`, `mousedown`,
  and `click`; stop keyboard activation when the ancestor row also handles it.
- Keep Process Manager, Command Palette, and other independently owned root
  controllers outside the modal registry; do not use the registry merely
  because a surface floats.

Required regression coverage for a modal triggered inside an interactive row:

1. Mount the trigger beneath a parent `pointerdown`/activation spy and mount
   `NodexModalHost` outside that parent.
2. Open the modal through the real menu workflow and fire `pointerdown` on its
   title/body; the parent spy must remain untouched.
3. For a registry-owned modal, unmount the trigger row and prove the modal
   remains mounted. For a local confirmation, prove its action-boundary guard
   prevents the same ancestor activation.

### Menu dividers

Use a **1px line** inside padded wrapper — not a full-width `<hr>`:

```html
<div class="w-full px-row-x py-1">
  <div class="bg-token-menu-border h-[1px] w-full"></div>
</div>
```

### Shortcuts in menus

Right-align keyboard shortcuts in **tertiary color, smaller size**:

```html
<span class="text-token-description-foreground ml-2 shrink-0 text-xs">⌘K</span>
```

## Keyboard Shortcuts (KBD)

```css
kbd {
  background: color-mix(in srgb, var(--foreground) 5%, transparent);
  color: var(--description-foreground);
  border-radius: 3px; /* rounded-sm */
  padding: 2px 6px; /* px-1.5 py-0.5 */
  font-size: 11px;
  font-family: var(--sans); /* not monospace */
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.025em;
}
```

## Animations & Transitions

### Instant common feedback, intentional motion elsewhere

Hover highlights, background changes, color changes, opacity changes, and expand/collapse should be **instant** — no transition duration. This makes the UI feel snappy and responsive like Linear or Arc:

- **Hover backgrounds:** no transition — instant
- **Hover text/color changes:** no transition — instant
- **Expand/collapse (collapsibles):** no animation — instant show/hide
- **Show-on-hover elements (close buttons, actions):** no transition — instant reveal

Reserve transitions only for **meaningful, intentional motion**:

- **Icon transforms** (chevron rotation): `transition-transform duration-150`
- **Toggles/switches:** `transition-duration: 200ms; transition-timing-function: ease-out`
- **Dropdown/popover entry:** scale + translate with `will-change: opacity, transform`
- **Filter/brightness effects:** `transition-filter` for button brightness on hover

### Animation DO NOTs

- Never use `transition-colors`, `transition-opacity`, or `transition-background` on hover states
- Never animate expand/collapse (use instant show/hide)
- Never use `ease-in-out` for simple hover — use `ease-in` or `ease-out`
- Never add spring/bounce physics unless the element is draggable
- Never animate `box-shadow` on hover — toggle it, don't tween it

## Borders & Dividers

### Hairline boundaries only

When a container, outlined control, or neutral chip needs a visible boundary,
use a semantic `0.5px` hairline. Prefer an inset ring for fixed-height compact
controls so the boundary does not change their geometry:

```css
border: 0.5px solid var(--border-token); /* outer ring */
/* or with Tailwind: */
/* border-[0.5px] border-token-border */
/* ring-[0.5px] ring-token-border */
```

Internal dividers within a card use:

```css
/* Tailwind: divide-y-[0.5px] divide-token-border */
border-top: 0.5px solid var(--border-token);
```

## Icons

- Size classes: `icon-xxs` (12px), `icon-2xs` (14px), `icon-xs` (16px), `icon-sm` (18px), `icon-base` (20px)
- Treat `icon-*` as one mutually exclusive two-axis size family. A reusable SVG with a default `icon-*` token also needs matching intrinsic `width` and `height` attributes as a CSS-independent fallback.
- A button, menu, or editor boundary may auto-size only SVGs without explicit geometry. Treat both Tailwind `size-*` and Nodex `icon-*` as explicit sizes; never overwrite either through a broad descendant selector.
- Use `shrink-0` on all icons to prevent flex compression
- Use `currentColor` for fill/stroke — inherit color from parent
- Use semantic app-owned icons from `@/components/shared/icons` for app-shell chrome, compact menus, sidebars, activities, file types, and resource identity. Component names describe meaning, never provenance.
- Use the shared app-owned `FileIcon` / `PageIcon` geometry for generic resource identity in attachments, menus, breadcrumbs, and Page rows. Preserve extension/MIME-specific artwork in format-sensitive file trees and file tabs; keep folders and file-related actions distinct.
- Search the semantic app-owned icon modules first. `generic-icons` and Lucide fallbacks are last resorts; if needed, import them only through `@/components/shared/icons/generic-icons`.
- Keep reusable custom SVGs in `src/renderer/components/shared/icons/`. Feature-local SVGs are limited to diagrams, data marks, and composite artwork covered by the icon-boundary audit.
- Standard compact shell/resource-action menu icon: `icon-xs` (16px). Reserve `icon-2xs` (14px) for denser secondary controls and indicators.
- Standard sidebar/toolbar icon: `icon-sm` (18px). Use `icon-base` only where the 20px visual weight is intentional.

## Typography

- Use the system sans stack — no custom display fonts by default
- `text-sm` (14px) for body, menu items, settings labels
- `text-base` (15–16px) for sidebar nav, headings in lists
- `text-xs` (12px) for shortcuts, metadata, badge labels
- `tabular-nums` for model names or version numbers
- `truncate` (ellipsis) on all text that could overflow — never wrap in menus

## Dark Mode

Use the resolved palette from
[`codex-theme-variant.ts`](../../../src/renderer/lib/codex-theme-variant.ts)
through semantic tokens. Main content, code editors, menus, controls, and the
underlying window surface have distinct roles. Palette fallback values and
syntax-theme colors alone do not establish those rendered roles.

Keep neighboring surfaces close in value and validate both appearances with
the runtime theme applied. Primary text, secondary opacity, borders, and
conversation accents must resolve together.

## Checklist

Before shipping any UI, verify:

- [ ] No element uses a hardcoded gray — all colors derived from foreground/background tokens
- [ ] Every resting fill communicates category, state, selection, or emphasis; neutral reference chips default to a transparent hairline outline
- [ ] Every outline communicates a useful object or interaction boundary; plain content remains plain
- [ ] No border thicker than `0.5px` on containers (inputs may use `1px`)
- [ ] No padding larger than `p-3` on list/menu items
- [ ] No transition on hover states (background, color, opacity) — must be instant
- [ ] Dropdowns use `backdrop-blur` + `bg/90` transparency
- [ ] Active states are visually distinct (opacity, background, or checkmark)
- [ ] All text that can overflow uses `truncate`
- [ ] Icons use `shrink-0` and `currentColor`
- [ ] No nested bordered containers — flat cards with internal dividers only
- [ ] Information density is high — no excessive whitespace
- [ ] Application modals escape row/menu/route trigger subtrees through the renderer-window modal registry
- [ ] Dropdown-triggered dialogs open from `onCloseAutoFocus`, after the menu closes
- [ ] Local confirmations have an action-boundary propagation test; registry modals survive trigger unmount in a regression test
