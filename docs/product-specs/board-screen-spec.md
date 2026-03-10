# Board Screen Specification

The main kanban board view displaying all columns and cards.

## Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [Full viewport width, horizontal scroll for columns]                    │
│                                                                         │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│ │ Ideas   │ │Analyzing│ │ Backlog │ │Planning │ │  Ready  │ ...        │
│ │  (3)    │ │   (1)   │ │   (5)   │ │   (2)   │ │   (4)   │            │
│ ├─────────┤ ├─────────┤ ├─────────┤ ├─────────┤ ├─────────┤            │
│ │ ┌─────┐ │ │ ┌─────┐ │ │ ┌─────┐ │ │ ┌─────┐ │ │ ┌─────┐ │            │
│ │ │Card │ │ │ │Card │ │ │ │Card │ │ │ │Card │ │ │ │Card │ │            │
│ │ └─────┘ │ │ └─────┘ │ │ └─────┘ │ │ └─────┘ │ │ └─────┘ │            │
│ │ ┌─────┐ │ │         │ │ ┌─────┐ │ │ ┌─────┐ │ │ ┌─────┐ │            │
│ │ │Card │ │ │+ New    │ │ │Card │ │ │         │ │ │Card │ │            │
│ │ └─────┘ │ │         │ │ └─────┘ │ │+ New    │ │ └─────┘ │            │
│ │         │ │         │ │         │ │         │ │         │            │
│ │+ New    │ │         │ │+ New    │ │         │ │+ New    │            │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Dimensions

| Element | Value | Notes |
|---------|-------|-------|
| Board padding | 16px | All sides |
| Column width | 272px | Fixed |
| Column gap | 8px | Between columns |
| Column min-height | 400px | Ensures droppable area |
| Column header height | 36px | Includes padding |

## Behaviors

### Horizontal Scroll
- Columns overflow horizontally when exceeding viewport
- Smooth scroll on trackpad/mouse wheel
- No visible scrollbar (hidden but functional)

### Drag & Drop
- Cards can be dragged within column (reorder)
- Cards can be dragged between columns (move)
- During drag:
  - Source card: `opacity: 0.5`, `rotate: 2deg`, `shadow-lg`
  - Drop zone: Highlighted with column's background color

### Real-time Updates
- SSE connection for live updates
- Cards animate in/out on add/remove
- Position changes animate smoothly

## States

### Empty Board
- All columns visible with empty state
- "New task" button prominently shown in each column

### Loading
- Skeleton cards in each visible column
- Column headers remain visible

### Error
- Toast notification for failed operations
- Retry button for recoverable errors

## Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| < 768px | Not optimized (desktop-first) |
| >= 768px | 2-3 columns visible |
| >= 1024px | 4-5 columns visible |
| >= 1280px | 6+ columns visible |
| >= 1536px | All 8 columns easily visible |

## Interaction Patterns

### Keyboard Navigation
- `Tab`: Move between interactive elements
- `Enter`/`Space`: Activate focused element
- `Escape`: Cancel current operation

### Card Click
- Opens card-stage panel
- Does not interfere with drag initiation (150ms delay)
- Clicking a card's visible `Priority` or `Estimate` chip opens an inline dropdown to edit that property without opening card-stage

### Add Card
- Click "+" icon in column header: Opens inline creator at top
- Click "New task" button: Opens inline creator at current position
