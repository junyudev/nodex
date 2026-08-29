# NFM Editor Move-To Popover Behavior

Status: Active  
Last Updated: 2026-08-29

## Contract

The NFM side-menu `Move to` action opens a destination popover instead of a two-row submenu. The popover searches DB destinations and Page destinations inside the source Project's write authority while preserving move semantics for the selected NFM blocks.

The expanded text-selection menu uses the same `Move to` destination popover in its Actions area. It replaces the older separate `Move to card` and `Turn into cards` text-selection actions with one destination picker.

The `Page in` row inside the side-menu `Turn into` submenu uses the same popover interaction model, but it is scoped to DB destinations only. Its row label and page-in icon stay unchanged.

## UI

- The popover is anchored to the `Move to` side-menu row and opens to the right.
- In the text-selection menu, the popover is anchored to the `Move to` action row and opens to the right of the floating text action menu.
- The search input is labeled `Move blocks to` and uses placeholder `Move blocks to…`.
- Results render in this fixed order:
  - `DB`
  - `Page`
- `DB` rows represent projects and are disclosure rows only. Clicking a DB row expands or collapses its column/status children.
- DB rows use the sidebar project folder icon when a project has no custom emoji icon.
- DB column/status child rows are the selectable DB destinations.
- DB column/status rows use the same status icons as board columns.
- DB column/status rows do not repeat their parent Project name. Their status icons align with the parent Project label to express one shallow tree level.
- Expanding or collapsing a DB Project changes only that Project's status children; it never changes the `Page` section.
- `Page` rows are selectable Page destinations.
- The source Page is excluded from Page results.
- Loading shows only after a short delay. Empty results show `No results`. Load and submit failures retain their specific message in an inline alert; an unknown thrown value falls back to `Couldn’t move these blocks.`.
- `Page in` opens a nested DB-only picker from the `Turn into` submenu. It shows the `DB` section, expands DB rows to column/status destinations, and does not render the `Page` section or Page-title results.

## Behavior

- Opening the popover resets its query and expands the current source DB when available.
- With an empty query, the `Page` section shows the bounded first window from the current source Project. Without a source Project, no destination is executable.
- Typing filters DB and status destinations locally while Page rows come from the prewarmed, Core-authorized metadata projection in the same input event. Search visibility is not treated as write authority for another Project.
- Page metadata uses the shared Rust search kernel for normalization, all-term matching, prefixes, fuzzy thresholds, ranking, and highlights. Debounced complete Core search may add body-only Page matches; pending enrichment is a stable trailing status row and never clears synchronous rows.
- The renderer does not inspect loaded Board cards or implement a second Page-title/Page-key matcher. The Core move command remains the final destination authority.
- A non-empty query resets keyboard focus to the first visible row and auto-expands matching DB rows.
- Arrow Up and Arrow Down move through visible rows.
- Enter toggles a DB row or accepts a DB status/Page row.
- Escape closes the move-to popover before closing the parent side menu.

## Move Semantics

- Selecting a DB status moves the selected NFM Block subtrees into the current Project's primary Data Source. Core promotes eligible ordinary Blocks to Pages, preserves subtree content, and assigns the selected Status through an active Status-grouped View.
- Selecting a Page moves the selected NFM Block subtrees into that Page body.
- Selecting a DB status from `Page in` uses the same DB-status move semantics as selecting a DB status from `Move to`.
- Page and DB destinations share one renderer move runtime. The editor first releases focus and flushes its source mutation barrier; the runtime then validates the source fence, resolves the destination authority, and commits one idempotent `BlockTransfer` intent.
- Page destinations prepare the target Document and include exact source and target heads. DB destinations resolve the canonical Project-default Database descriptor and choose a real active View grouped by the built-in `status` Property rather than deriving Data Source identity from UI state.
- Source and target epoch mismatches fail closed. Core commits source detachment, target attachment or Page promotion, typed membership values, Document updates, projections, receipt, and local delivery atomically.
- When Move detaches every root Block, Core creates one stable-ID empty paragraph in the source Document within that same commit. The source Page remains blank and editable, while Undo removes the placeholder and restores the exact original roots.
- The picker exposes only the source Project. Cross-Project movement requires a future Core command that authorizes both source and target contexts in the same transaction; the renderer must not emulate it with two mutations or advertise an unexecutable destination.
- Structured Database, Document, and BlockTransfer failures preserve their code, retryability, reload requirement, and operation ID for diagnostics. The picker shows the safe command message and keeps the failed destination available for retry.
