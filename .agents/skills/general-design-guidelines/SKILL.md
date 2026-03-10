---
name: general-design-guidelines
description: General design guidelines for building premium, Linear/Arc-inspired UI. Use when creating or modifying frontend components, pages, dropdowns, settings panels, sidebars, poppers, command palettes, or any user-facing interface. Enforces a luxury, ultra-refined aesthetic with intentional spacing, opacity-based hierarchy, and crisp micro-animations.
---

# General Design Guidelines

Premium, Linear/Arc-inspired design system. Every pixel intentional. Ultra-refined, precise, with crisp animations.

## Core Philosophy

The aesthetic is **luxury tool-grade software** — closer to Linear, Arc, Notion, and Raycast than to generic SaaS. The UI should feel like a finely machined instrument: subdued, information-dense, and quietly confident.

**Key tenets:**
- Every element earns its space — no decorative filler
- Hierarchy through **opacity and color**, not through borders and boxes
- Flat, single-surface layouts — no gradient heroes, no nested bordered cards
- Tight, intentional spacing — never loose or "airy" by default
- Quiet until interacted with — elements reveal depth on hover/focus

## Visual Hierarchy

### Use opacity and `color-mix()` — not borders — for hierarchy

Establish foreground/background relationships using **alpha transparency on the foreground color**, not by defining separate border/divider colors.

```css
/* ✅ Good — opacity-based hierarchy */
background: color-mix(in srgb, var(--foreground) 5%, transparent);   /* subtle tint */
background: color-mix(in srgb, var(--foreground) 10%, transparent);  /* hover state */
color: color-mix(in srgb, var(--foreground) 50%, transparent);       /* secondary text */

/* ❌ Bad — hard-coded grays or separate border colors */
background: #f5f5f5;
border: 1px solid #e0e0e0;
color: #999;
```

**Practical token pattern** (Tailwind-style):
- `bg-token-foreground/5` — subtle surface tint
- `bg-token-foreground/10` — hover/active surface
- `text-token-text-secondary` — de-emphasized text (implemented via opacity)
- `text-token-description-foreground` — tertiary/metadata text
- `opacity-75` resting → `opacity-100` on hover/active — for sidebar nav items

### Text hierarchy

Use **three levels maximum** in any single view:

| Level | Token / treatment | Usage |
|-------|------------------|-------|
| Primary | `text-token-text-primary` / full opacity | Titles, labels, active items |
| Secondary | `text-token-text-secondary` | Descriptions, body text |
| Tertiary | `text-token-description-foreground` | Hints, metadata, shortcuts |

## Surfaces & Containers

### Flat sections with subtle dividers — not nested bordered boxes

Settings panels, grouped form rows, and option lists use a **single flat card** with internal dividers:

```css
/* ✅ Good — flat card, hairline internal dividers */
.settings-card {
  background: var(--bg-fog);           /* very subtle tint, e.g. token-bg-fog */
  border: 0.5px solid var(--border);   /* hairline outer ring */
  border-radius: var(--radius-lg);     /* 8-10px */
}
.settings-card > * + * {
  border-top: 0.5px solid var(--border); /* internal dividers */
}

/* ❌ Bad — nested bordered boxes */
.settings-group { border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
.settings-group .item { border: 1px solid #eee; border-radius: 8px; }
```

### Single flat surface — no gradient heroes

Main content areas use a **solid background**, never a gradient or patterned hero. The focus is the content, not the container.

### Surface patterns from exemplars

| Component | Background | Border | Radius |
|-----------|-----------|--------|--------|
| Settings card | `bg-token-bg-fog` | `border-[0.5px] border-token-border` | `rounded-lg` (8px) |
| Dropdown / popper | `bg-token-dropdown-background/90` | `ring-[0.5px] ring-token-border` | `rounded-xl` (12px) |
| Sidebar | `bg-token-surface-secondary` | none | — |
| Main surface | `main-surface` (solid) | none | — |
| Switch (on) | `bg-token-charts-blue` | none | `rounded-full` |
| Switch (off) | `bg-token-foreground/10` | none | `rounded-full` |

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

### Strong active state indicators

Active/selected items must be **unmistakable** without being garish:

```css
/* Sidebar nav */
.nav-item          { opacity: 0.75; }
.nav-item:hover    { opacity: 1; background: var(--list-hover-bg); }
.nav-item[active]  { opacity: 1; background: var(--list-active-bg); font-weight: normal; }

/* Segmented control (e.g. Light/Dark/System) */
.segment           { color: var(--description-fg); }
.segment[pressed]  { color: var(--foreground); background: var(--foreground-5); }

/* Dropdown item */
.menu-item:hover   { background: var(--list-hover-bg); }
.menu-item[checked] { /* show checkmark icon, no background change */ }
```

### Button styles

| Variant | Background | Border | Shape |
|---------|-----------|--------|-------|
| Ghost (toolbar) | transparent | `border-transparent` | `rounded-full` |
| Ghost hover | `bg-token-foreground/5` | — | — |
| Tinted | `bg-token-foreground/5` | `border-transparent` | `rounded-lg` |
| Tinted active | `bg-token-foreground/10` | — | — |
| Primary (send) | `bg-token-foreground` | — | `rounded-full` |
| Disabled | same + `opacity-40` | — | — |

## Dropdowns & Poppers

Dropdowns are **frosted glass** with a subtle shadow — they float above content, not beside it:

```css
.dropdown {
  background: color-mix(in srgb, var(--dropdown-bg) 90%, transparent);
  backdrop-filter: blur(12px);          /* frosted glass */
  border-radius: 12px;                  /* rounded-xl */
  box-shadow: var(--shadow-lg);
  outline: 0.5px solid var(--border);   /* ring-[0.5px] */
  padding: 4px;                         /* px-1 py-1 */
}
.dropdown-item {
  border-radius: 8px;                   /* rounded-lg */
  padding: var(--row-x) var(--row-y);
  font-size: 14px;                      /* text-sm */
}
.dropdown-item:hover {
  background: var(--list-hover-bg);
}
```

Use one shared dropdown chrome system across selector-style surfaces. Radix `Select`, `DropdownMenu`, and selector `Popover` content should share the same surface, row, divider, and motion treatment by default. Triggers can stay context-specific: toolbar pills, dialog fields, and inline chip controls do not need identical trigger chrome as long as their poppers resolve to the same floating menu language.

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
  border-radius: 3px;         /* rounded-sm */
  padding: 2px 6px;           /* px-1.5 py-0.5 */
  font-size: 11px;
  font-family: var(--sans);   /* not monospace */
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

### Hairline borders only

Outer container borders are always `0.5px` — never `1px` or thicker:

```css
border: 0.5px solid var(--border-token);   /* outer ring */
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

- Size classes: `icon-xxs`, `icon-2xs`, `icon-xs`, `icon-sm`
- Use `shrink-0` on all icons to prevent flex compression
- Use `currentColor` for fill/stroke — inherit color from parent
- Standard menu/dropdown icon: `icon-2xs` (≈14px)
- Standard sidebar/toolbar icon: `icon-sm` (≈20px)

## Typography

- Use the system sans stack — no custom display fonts by default
- `text-sm` (14px) for body, menu items, settings labels
- `text-base` (15–16px) for sidebar nav, headings in lists
- `text-xs` (12px) for shortcuts, metadata, badge labels
- `tabular-nums` for model names or version numbers
- `truncate` (ellipsis) on all text that could overflow — never wrap in menus

## Dark Mode

Design dark-first. The exemplar palette is:

| Role | Value |
|------|-------|
| Editor bg | `#0d0d0d` |
| Surface secondary | `#131313` |
| Input bg | `#161616` |
| Muted text | `#414141` |
| Secondary text | `#8f8f8f` |
| Foreground | `#fcfcfc` |
| Accent (blue) | `#0169cc` |

All surfaces are **very close in value** — hierarchy comes from subtle shifts, not dramatic contrast between panels.

## Checklist

Before shipping any UI, verify:

- [ ] No element uses a hardcoded gray — all colors derived from foreground/background tokens
- [ ] No border thicker than `0.5px` on containers (inputs may use `1px`)
- [ ] No padding larger than `p-3` on list/menu items
- [ ] No transition on hover states (background, color, opacity) — must be instant
- [ ] Dropdowns use `backdrop-blur` + `bg/90` transparency
- [ ] Active states are visually distinct (opacity, background, or checkmark)
- [ ] All text that can overflow uses `truncate`
- [ ] Icons use `shrink-0` and `currentColor`
- [ ] No nested bordered containers — flat cards with internal dividers only
- [ ] Information density is high — no excessive whitespace
