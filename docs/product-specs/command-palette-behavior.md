# Command Palette Behavior

## Intent
The command palette is the global launcher for fast workbench navigation.
It is optimized for card retrieval first and command execution second:

- default mode searches cards across all projects
- command mode is explicit and entered with a leading `>`
- result ranking favors fast recall over exhaustive inspection
- matching context is visible directly in the result row through inline highlights and short previews

The palette is a transient overlay and does not become part of durable navigation history.

## Launch and Scope
- `Cmd/Ctrl+K` opens the command palette from anywhere in the app, including editable surfaces.
- `Cmd/Ctrl+P` is an alias for the same palette.
- The palette reads cards from every loaded project store, not just the active project.
- The palette closes after executing a result.
- Closing the palette clears the query and resets the selection index.

## Modes

### Card Mode
Card mode is the default.

- Any query that does not start with `>` searches cards only.
- Commands are hidden entirely in card mode.
- Empty query shows default card suggestions rather than commands.

### Command Mode
Command mode is entered with a leading `>`.

- The `>` prefix is stripped before matching.
- Only commands are shown in this mode.
- Cards are hidden entirely in command mode.
- Disabled commands remain visible so the user can understand the available affordance, but they cannot be executed.

## Card Search Model

### Indexed fields
Card search indexes the following normalized fields:

- title
- plain-text description
- tags
- assignee
- agent status
- column name
- project name
- card id

Normalization is lowercasing plus whitespace compaction.

### Ranking
Card search uses a MiniSearch index with a persisted cache plus a runtime reuse layer.
Field boosts are:

- title: `8`
- tags: `5`
- assignee: `4`
- agent status: `3`
- column name: `2`
- project name: `2`
- description: `1`
- card id: `1`

Query semantics:

- multiple terms combine with `AND`
- prefix matching is enabled for terms with length `>= 2`
- fuzzy matching uses term-length-sensitive thresholds
  - length `<= 3`: `0`
  - length `4-5`: `0.1`
  - length `> 5`: `0.2`

### Ordering
For non-empty queries, card results sort by:

1. MiniSearch relevance score
2. active-project preference
3. recency preference (`recentIndex`)
4. board order (`boardIndex`)
5. title

For empty queries, card results skip MiniSearch and sort by:

1. active-project preference
2. recency preference
3. board order
4. title

### Index lifecycle
- The renderer keeps one serialized card-search index in IndexedDB for the palette.
- The app also keeps an in-memory copy of the most recent palette index so reopening the palette in the same session does not rebuild it.
- When the current card set changes, the palette hydrates the cached MiniSearch index and diffs cards by per-card search signature instead of rebuilding everything from scratch.
- Signature changes include all indexed text, so card edits plus project-name or column-name changes invalidate the affected cached entries.

## Card Result Presentation

### Primary line
Each card result renders:

- project icon chip
- card title
- project and column subtitle

If the query matched the title, project name, or column name, those matched spans are highlighted inline inside the rendered text rather than rendered as a separate badge.

### Secondary match indicators
If the query matched other indexed fields, the result may render compact indicator chips for:

- `tag`
- `assignee`
- `status`
- `id`

These chips render only for fields that actually matched.
They are intentionally compact and subdued so they explain why a result appeared without overpowering the title.

### Description preview
If the query matched description text, the result renders a contextual preview below the subtitle:

- preview is extracted from the plain-text description
- excerpt centers around the first matched description term
- excerpt is trimmed with leading/trailing ellipses when taken from the middle of the description
- preview is clamped to `3` lines
- matched spans are highlighted inline

If a result matched only non-description fields, no description preview is shown.

## Command Search Model
- Commands are matched only in command mode.
- Command ranking remains lightweight and heuristic rather than MiniSearch-based.
- Ranking considers title, subtitle, keyword text, explicit command priority, and active-state bonus.
- Result limits remain separate from card limits.

## Keyboard Behavior
- `ArrowDown` / `ArrowUp` moves selection and skips disabled commands.
- `Home` / `End` jumps to the first or last visible result.
- `Enter` executes the selected result.
- `Escape` clears the query when the query is non-empty.
- When the query is empty, standard dialog close behavior applies.

## Result Limits
- command mode shows up to `8` commands
- card mode shows up to `12` cards

## Execution Semantics

### Card results
Executing a card result:

- closes the palette
- opens that card in the Card stage
- preserves the current DB-project selection if the card belongs to another project

### Command results
Executing a command result:

- closes the palette
- runs the associated shell/workbench action

Supported actions currently include:

- go back / go forward
- open project picker
- open task search
- toggle terminal
- open settings
- open new window
- switch DB view
- focus a stage

## Non-Goals
- full query DSL in card mode
- quoted phrase operators
- explicit include/exclude filters
- persistent search history
- multi-snippet previews per card
- syntax-colored rich-text previews

The palette is intentionally biased toward immediate navigation rather than becoming a full search product.
