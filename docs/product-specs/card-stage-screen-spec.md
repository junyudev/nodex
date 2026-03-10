# Card Stage Screen Specification

Slide-out panel for viewing and editing card details.

## Layout

```
┌──────────────────────────────────────────────────┐
│ Board (dimmed)                                   │
│                     ┌───────────────────────────┐│
│                     │ Card Stage Panel           ││
│                     │                           ││
│                     │ [Title input]             ││
│                     │                           ││
│                     │ Properties                ││
│                     │ ┌───────────────────────┐ ││
│                     │ │ Priority: [P2]        │ ││
│                     │ │ Estimate: [M]         │ ││
│                     │ │ Tags: [tag1] [tag2]   │ ││
│                     │ │ Due: [2025-02-15]     │ ││
│                     │ │ Schedule: [Start-End] │ ││
│                     │ │ Assignee: [@claude]   │ ││
│                     │ └───────────────────────┘ ││
│                     │                           ││
│                     │ Agent Status              ││
│                     │ ┌───────────────────────┐ ││
│                     │ │ Status: Working on... │ ││
│                     │ │ [x] Blocked           │ ││
│                     │ └───────────────────────┘ ││
│                     │                           ││
│                     │ Description               ││
│                     │ ┌───────────────────────┐ ││
│                     │ │                       │ ││
│                     │ │  Markdown content...  │ ││
│                     │ │                       │ ││
│                     │ └───────────────────────┘ ││
│                     │                           ││
│                     │ ─────────────────────────││
│                     │ [Delete card]             ││
│                     └───────────────────────────┘│
└──────────────────────────────────────────────────┘
```

## Dimensions

| Element | Value | Notes |
|---------|-------|-------|
| Panel width | 480px | Desktop default |
| Panel max-width | 640px | On very wide screens |
| Panel min-width | 360px | Responsive floor |
| Header height | 48px | Title row |
| Section padding | 16px | Horizontal |
| Section gap | 24px | Between sections |
| Input height | 32px | Standard inputs |
| Textarea min-height | 120px | Description field |

## Animation

### Open
- Duration: 200ms
- Easing: `cubic-bezier(0.32, 0.72, 0, 1)`
- Transform: `translateX(100%)` → `translateX(0)`
- Backdrop: `opacity: 0` → `opacity: 0.3`

### Close
- Duration: 150ms
- Easing: `ease-out`
- Transform: `translateX(0)` → `translateX(100%)`
- Backdrop: `opacity: 0.3` → `opacity: 0`

## Sections

### Title
- Font: 18px, weight 600
- Full-width input, no visible border until focus
- Placeholder: "Untitled"

### Properties
- Two-column grid layout
- Label: 12px, muted color, uppercase
- Value: 14px, primary color
- Editable inline (click to open dropdown/input)
- Schedule uses paired datetime controls (`Start`, `End`) with quick actions (`Now + 1h`, `Clear`) and auto-adjusts invalid ranges to keep end after start

### Agent Status
- Monospace font for status text
- Blue accent color for status
- Checkbox for "Blocked" state
- Red ring indicator when blocked

### Description
- Auto-growing textarea
- Markdown preview toggle
- Support for:
  - Headers (h1-h6)
  - Bold, italic, code
  - Links
  - Lists (ordered, unordered)
  - Code blocks

### Danger Zone
- Separated by border
- Delete button: Destructive style
- Confirmation required before delete

## Behaviors

### Content Width
- The header toolbar stays full width
- The scrollable card body is constrained to `--pane-content-max-width` (48rem) by default
- Users can toggle that width limit on or off from the header toolbar

### Auto-save
- Changes saved on blur
- Debounced save (500ms) during typing
- Visual feedback: Brief checkmark or "Saved" text

### Backdrop Click
- Closes panel
- Triggers save for any pending changes

### Escape Key
- Closes panel
- Triggers save for any pending changes

### Delete Confirmation
- Modal dialog: "Delete this card?"
- Actions: "Cancel" | "Delete"
- Cannot be undone

## States

### Loading
- Skeleton placeholders for all fields
- Shimmer animation

### Error
- Inline error messages below affected fields
- Toast for save failures
- Retry option

### Unsaved Changes
- No explicit indicator (auto-save handles this)
- Warn on close only if save fails

## Accessibility

- Focus trap within panel when open
- `aria-modal="true"` on panel
- `aria-labelledby` pointing to title
- Escape key closes panel
- Return focus to triggering element on close
