# Keyboard Shortcuts

All keyboard shortcuts in Nodex. Platform modifier: **⌘ (Cmd)** on Mac, **Ctrl** on Windows/Linux.

## App-Wide

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Ctrl+Tab` | Next stage | Cycles `DB -> Cards -> Threads -> Diff`, including while focus is inside the NFM editor |
| `Ctrl+Shift+Tab` | Previous stage | Reverse cycle, including while focus is inside the NFM editor |
| `⌘/Ctrl+L` | Next stage | Alias for next-stage navigation; same editable-target behavior as stage cycling shortcuts |
| `⌘/Ctrl+H` | Previous stage | Alias for previous-stage navigation; same editable-target behavior as stage cycling shortcuts |
| `Shift+Wheel` | Scroll stage rail panels | Uses native horizontal wheel scrolling in the stage rail; does not change stage focus (Calendar view claims this gesture for day navigation and blocks stage-rail scrolling) |
| `⌘/Ctrl+1`–`4` | Jump to stage by index | Stage index order in sidebar; works while focus is in the NFM editor |
| `⌘/Ctrl+Alt+1`–`9` | Jump to space by index | First 9 spaces in sidebar order (disabled while focus is in NFM editor because `⌘/Ctrl+Alt+1`–`4` are editor heading shortcuts) |
| `⌘/Ctrl+Shift+P` | Open project/space picker | Opens space manager popover, including while focus is inside the NFM editor |
| `⌘/Ctrl+K` | Open command palette | Global launcher for cards; type `>` to switch into command search; works from editable surfaces too |
| `⌘/Ctrl+P` | Open command palette | Alias for the same global launcher |
| `⌘/Ctrl+[` | Go back | Restores the previous durable workbench context; works from editable surfaces too |
| `⌘/Ctrl+]` | Go forward | Restores the next durable workbench context; works from editable surfaces too |
| `⌘/Ctrl+,` | Toggle settings overlay | Opens/closes the full-page settings overlay |
| `⌘/Ctrl+J` | Toggle bottom terminal panel | Global toggle, including when focus is in editor inputs |
| `⌘/Ctrl+N` | Open new app window | Electron desktop only (`window:new` IPC); ignored in browser runtime |
| `⌘/Ctrl+F` | Open floating task search | Focuses the Views-stage task search surface outside editable editors/inputs |

### Workbench Panel Borders

| Shortcut | Action | Scope |
|----------|--------|-------|
| `←` / `→` | Resize focused panel separator | Full-rail stage border handles, and sliding-window separators |
| `⌘/Ctrl+Z` | Undo | Board-level undo (card ops) outside editor surfaces; inside BlockNote editor this stays editor-local undo |
| `⌘/Ctrl+Shift+Z` | Redo | Board-level redo outside editor surfaces |
| `⌘/Ctrl+Y` | Redo | Windows convention |

## Threads Composer

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Enter` | Send prompt | Default behavior in thread panel composer |
| `Shift+Enter` | Insert newline | Thread panel composer |
| `⌘/Ctrl+Enter` | Send prompt | Available when `Settings -> Editor -> Thread send shortcut` is set to `Cmd/Ctrl+Enter` |

## Editor (NFM / BlockNote)

### Find & Replace

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl+F` | Open find panel (in-editor); seeds query from selected editor text when selection is non-empty |
| `⌘/Ctrl+G` | Next match |
| `⌘/Ctrl+Shift+G` | Previous match |
| `Enter` | Next match (in find input) |
| `Shift+Enter` | Previous match (in find input) |
| `Enter` | Replace current (in replace input) |
| `Escape` | Close find panel |

### Block Formatting

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl+Alt+1`–`4` | Heading level 1–4 |
| `⌘/Ctrl+Enter` | Send current thread section | Opens a confirmation preview by default; can auto-create a section at the current block when none exists |
| `⌘+Enter` | Toggle expand/collapse (Mac, only when the cursor is on a toggle header) |
| `⌘/Ctrl+A` | Select current block content |

### Input Rules (text triggers)

| Typed at line start | Result |
|---------------------|--------|
| `> ` | Toggle list item |
| `\| ` | Quote block |
| `# `–`#### ` | Heading level 1–4 |

### Navigation

| Shortcut | Action | Scope |
|----------|--------|-------|
| `↑` / `↓` | Navigate between inline views | When on inline block selection |
| `↑` / `↓` | Navigate between cards at boundary | Toggle list card editor |
| `Space` | Toggle large image preview | When an image block is focused (open), or while preview modal is open (close) |

## Forms & Dialogs

| Shortcut | Action | Scope |
|----------|--------|-------|
| `Enter` | Submit / confirm | Inline card creator, project create/rename, tag input |
| `Escape` | Cancel / close | Inline card creator, project forms, card-stage tag dropdown |
| `↑` / `↓` | Navigate suggestions | Card stage tag input |
| `Tab` | Select highlighted tag | Card stage tag input |
| `↑` / `↓` | Navigate entries | History panel |

## Implementation

Workbench navigation shortcuts are in `src/renderer/lib/use-workbench-shortcuts.ts`.
Undo/redo shortcuts are in `src/renderer/lib/use-keyboard-shortcuts.ts`.
Editor shortcuts are in `src/renderer/components/kanban/editor/nfm-editor-extensions.ts` and `nfm-editor.tsx`.
Terminal panel shortcut routing is in `src/renderer/lib/use-workbench-shortcuts.ts`.
