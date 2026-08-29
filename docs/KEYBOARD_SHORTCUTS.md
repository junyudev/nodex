# Keyboard Shortcuts

All keyboard shortcuts in Nodex. Platform modifier: **⌘ (Cmd)** on Mac, **Ctrl** on Windows/Linux.

## Editable Command Shortcuts

Settings -> Keyboard shortcuts edits the command-keymap registry used by the workbench shortcut hook, command-palette labels, shell panel actions, and desktop application-menu accelerators. User overrides persist in `~/.nodex/config.toml` under `[server.command_keybindings]`: a missing command id uses defaults, an empty array means explicitly unassigned, and an array of strings is the custom accelerator list.

The editable settings tab covers Nodex-supported command ids only. Editor-native shortcuts, text input behavior, and BlockNote/NFM editing shortcuts remain owned by the editor surface and are documented separately below.

## App-Wide

| Shortcut               | Action                     | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+Alt+1`–`9`     | Jump to project by index   | First 9 projects in shell/sidebar order (disabled while focus is in NFM editor because `⌘/Ctrl+Alt+1`–`4` are editor heading shortcuts)                                                                                                                                                                                                                               |
| `⌘/Ctrl+Shift+P`       | Search commands            | Opens the global command palette in root command mode; works from editable surfaces too                                                                                                                                                                                                                                                                               |
| `⌘/Ctrl+K`             | Search commands and chats  | Opens the global command palette in root mode; chat metadata joins at two query characters and chat history at three; works from editable surfaces too                                                                                                                                                                                                                |
| `⌘/Ctrl+G`             | Search chats               | Opens the global palette in chat-search mode                                                                                                                                                                                                                                                                                                                          |
| `⌘/Ctrl+P`             | Search Pages               | Opens the global palette in Page-search mode, including Page filter controls                                                                                                                                                                                                                                                                                          |
| `C` / `⌘/Ctrl+Shift+C` | Create Page                | Opens the app-owned composer for the active Project. An explicitly active writable Board supplies its View and column; otherwise Nodex uses the active Project's durable default Database View. The command is ignored in editable fields, editors, local floating surfaces, dialogs, and Terminals. An expanded non-editor text selection becomes the initial title. |
| `V`                    | Create Page expanded       | Opens the same app-owned composer directly in full-window mode                                                                                                                                                                                                                                                                                                        |
| `/`                    | Search                     | Opens the command palette from a non-editable app surface                                                                                                                                                                                                                                                                                                             |
| `?` / `⌘/Ctrl+Shift+/` | Keyboard shortcuts         | Opens the searchable contextual shortcut reference; its Customize action opens Settings                                                                                                                                                                                                                                                                               |
| `G` then `P`           | Go to Pages                | Opens the Pages workspace                                                                                                                                                                                                                                                                                                                                             |
| `G` then `S`           | Go to Settings             | Opens Settings                                                                                                                                                                                                                                                                                                                                                        |
| `O` then `P`           | Open Page                  | Opens Page search in the command palette                                                                                                                                                                                                                                                                                                                              |
| `O` then `T`           | Open chat                  | Opens chat search in the command palette                                                                                                                                                                                                                                                                                                                              |
| `⌘/Ctrl+Alt+O`         | Latest notification action | Runs the newest still-visible plain toast action and dismisses it when the action succeeds                                                                                                                                                                                                                                                                            |
| `⌘/Ctrl+[`             | Back                       | Restores the previous shell-owned Project/Session/Library target and its route-local presentation; works from editable surfaces too                                                                                                                                                                                                                                   |
| `⌘/Ctrl+]`             | Forward                    | Restores the next shell-owned Project/Session/Library target and its route-local presentation; works from editable surfaces too                                                                                                                                                                                                                                       |
| `⌘/Ctrl+Shift+A`       | Archive chat               | Archives the active project or projectless session                                                                                                                                                                                                                                                                                                                    |
| `⌘/Ctrl+N`             | New chat                   | Starts a new chat in the active project                                                                                                                                                                                                                                                                                                                               |
| `⌘/Ctrl+Alt+S`         | Open side chat             | Opens a side chat for the active attached thread                                                                                                                                                                                                                                                                                                                      |
| Unassigned             | Open in new window         | Editable command; opens the active session in a new window once assigned                                                                                                                                                                                                                                                                                              |
| `⌘/Ctrl+Alt+N`         | New quick chat             | Starts a new chat in the active project                                                                                                                                                                                                                                                                                                                               |
| `⌘/Ctrl+Alt+P`         | Toggle pin                 | Pins or unpins the active session                                                                                                                                                                                                                                                                                                                                     |
| `⌘/Ctrl+Alt+R`         | Rename chat                | Opens `Rename chat` for the active session                                                                                                                                                                                                                                                                                                                            |
| `MouseBack`            | Back                       | Desktop mouse back button; routes to the same app-window workbench history command                                                                                                                                                                                                                                                                                    |
| `MouseForward`         | Forward                    | Desktop mouse forward button; routes to the same app-window workbench history command                                                                                                                                                                                                                                                                                 |
| `⌘/Ctrl+,`             | Toggle settings route      | Opens/closes the full-window settings route shell                                                                                                                                                                                                                                                                                                                     |
| `⌘/Ctrl+Shift+N`       | Open new app window        | Electron desktop only; restores the most recently closed Window Session, otherwise clones the active window                                                                                                                                                                                                                                                           |
| `⌘/Ctrl+Shift+W`       | Close app window           | Electron desktop only; kept distinct from `⌘/Ctrl+W` close-panel-tab                                                                                                                                                                                                                                                                                                  |
| `⌘/Ctrl+F`             | Content search             | Opens the floating Workbench search for the mounted chat, review diff, or Browser page source. When the floating input is focused, repeating the shortcut cycles chat -> diff -> browser when available. Database task search remains a Database-view-local action                                                                                                    |
| `⌘/Ctrl+L`             | Focus browser address bar  | Focuses and selects the active Browser tab address field when one is mounted                                                                                                                                                                                                                                                                                          |

## Sidebar Sections

| Shortcut                           | Action                      | Notes                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Alt+↑` / `Alt+↓`                  | Move focused custom Section | Works from the Section heading and persists the complete custom Section order.                                                                                                                           |
| `Space` / `Enter`, then arrow keys | Reorder a custom Section    | Starts keyboard drag from the focused Section heading; `Escape` cancels and `Space` / `Enter` drops.                                                                                                     |
| `Space` / `Enter`, then arrow keys | Move a Project or chat      | Uses the same sidebar drag model as pointer input. Project ownership is unchanged when moving into a custom Section; moving a chat to a Project keeps the existing ownership-move confirmation boundary. |

## Panel Shortcuts

| Shortcut         | Action              | Notes                                                                                                                                          |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+J`       | Toggle bottom panel | Shows or hides the active Scene's bottom panel; works from editable surfaces and desktop Browser tabs through the application-menu accelerator |
| `⌘/Ctrl+Shift+E` | Files               | Opens a Files preview in the side panel; interacting with it pins a durable Files tab                                                          |
| `Alt+⌘/Ctrl+S`   | Side chat           | Starts a side chat in the active panel target                                                                                                  |
| `⌘/Ctrl+T`       | Browser             | Opens a Browser preview in the side panel; interacting with it pins a durable Browser tab                                                      |
| `Ctrl+Shift+G`   | Review              | Opens or focuses the singleton Review tab                                                                                                      |
| `Ctrl+\``        | Terminal            | Focuses an existing session terminal tab, or creates one in the bottom panel                                                                   |
| `⌘/Ctrl+Shift+[` | Previous panel tab  | Uses the focused right or bottom panel tab group in the active Session, Project, or Pages Scene; wraps within the same split group             |
| `⌘/Ctrl+Shift+]` | Next panel tab      | Uses the focused right or bottom panel tab group in the active Session, Project, or Pages Scene; wraps within the same split group             |
| `⌘/Ctrl+W`       | Close panel tab     | Closes the active closable tab in the focused right or bottom panel tab group, then reveals that leaf's most recently active remaining tab     |

Bottom-panel toggle is a shell-global command and remains available from editable targets. Other panel action shortcuts are ignored from editable targets and dialog surfaces. Side chat, Browser, Terminal, Files, and Review resolve availability through the same capability model as panel menus and the command palette. An unavailable action returns before suppressing the browser/editor key; in particular a blank projectless Session handles Browser only, and an attached projectless Session handles Side chat plus Terminal only when their thread/cwd requirements are satisfied. Focused panel tab cycling and close-tab shortcuts also work from NFM editor content inside a panel tab group, consume the shortcut as a no-op when the focused group has no matching action, still ignore input fields, dialogs, and Terminal surfaces, and leave plain `⌘/Ctrl+[` / `⌘/Ctrl+]` as app-window Back/Forward. The previous/next panel-tab bindings and `closeTab` use the shared command-keymap registry across renderer and native-menu ingress; explicit unassignment is respected. Close-panel-tab routing is leaf-scoped for keyboard, menu, close-button, and middle-click single-tab closes: Nodex reveals the most recently active remaining tab, falling back to the right neighbor and then the left neighbor only when MRU cannot answer. Durable Card Stage tabs keep their description editor mounted across focused panel-tab cycling while the tab remains open, so returning to the tab restores the previous editor cursor. On macOS, `⌘⇧W` closes the app window.

App-owned shortcuts run from the active renderer window after local surfaces have had the opportunity to handle the event. They ignore consumed events, IME composition, key-repeat unless explicitly supported, and declared local or Terminal keyboard scopes. A bare binding such as `C` consumes the key only after its capability is ready and the command accepts the request; unavailable bare commands fail open without a toast. User overrides replace the ordered defaults, while Reset restores both Create Page bindings.

Two-chord sequences use a 900 ms continuation window. The first chord is consumed only when at least one currently available command owns that prefix. A mismatch is re-evaluated as a fresh shortcut, and input/editor/local surfaces never arm a sequence.

## Database View and Page Actions

These actions require the current Workbench tab to present a Database View. Board and List share one active Page and selection, so switching layout does not discard either state. Pointer activation or keyboard navigation establishes the active Page; hover remains transient visual feedback and never changes selection. List rows additionally use `ArrowUp`/`ArrowDown`, `Home`/`End`, `Space`, and `Enter` directly on the roving row focus target. When the active Page belongs to a multi-selection, move actions apply to that selection in visible order. Manual placement commands are accepted only when the effective View can compile the requested move atomically; sorted or read-only arrangements leave the key available to the local surface.

| Shortcut                      | Action                          | Notes                                                                                                 |
| ----------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `J` / `K` or `↓` / `↑`        | Highlight next / previous Page  | Uses visible column-major order and updates an open Peek                                              |
| `←` / `→`                     | Highlight adjacent Board column | Preserves the nearest visible row and skips empty columns                                             |
| Tap `Space`                   | Toggle Peek                     | Opens or closes the highlighted Page preview                                                          |
| Hold `Space`                  | Momentary Peek                  | Opens while held and closes on release; the threshold is 220 ms                                       |
| `Enter`                       | Open Page                       | Opens a durable Page Stage                                                                            |
| `X`                           | Toggle selection                | Adds or removes the highlighted Page from the selection                                               |
| `Space` in List               | Toggle selection                | Toggles the Page at the List roving focus target                                                      |
| `Shift+↑` / `Shift+↓` in List | Extend selection                | Extends the contiguous occurrence range from the selection anchor                                     |
| `⌘/Ctrl+A` in List            | Select all matching Pages       | Keeps a sparse all-matching selection and loads remaining Core windows before enabling bulk drag/move |
| `Escape`                      | Clear selection / close Peek    | Clears selection first, then closes the Page preview                                                  |
| `T` in List                   | Collapse or expand              | Toggles the active Page's containing group                                                            |
| `Alt+T` in List               | Collapse or expand all          | Toggles all currently available group boundaries                                                      |
| `S`                           | Set status                      | Opens the canonical status menu; moving multiple selected Pages is atomic                             |
| `P`                           | Set priority                    | Opens the canonical priority menu                                                                     |
| `Shift+E`                     | Set estimate                    | Opens the canonical estimate menu                                                                     |
| `L`                           | Set tags                        | Opens the canonical multi-select tag menu                                                             |
| `Alt+↑` / `Alt+↓`             | Move Page(s)                    | Moves by one visible position when the View permits manual placement                                  |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Move to top / bottom            | Uses the same optimistic receipt-backed mutation path as drag-and-drop                                |
| `Alt+←` / `Alt+→`             | Move across columns             | Preserves the nearest visible row in the destination column                                           |
| `W` then `O`                  | Work on Page                    | Starts a new chat with the highlighted Page as context                                                |

### Browser

| Shortcut                     | Action                      | Notes                                                                                                                                           |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+L`                   | Focus address               | Selects the complete address of the active Browser tab                                                                                          |
| `⌘/Ctrl+F`                   | Open Browser find           | Opens Workbench content search in the Browser domain when Browser is the mounted target                                                         |
| `Enter` / `Shift+Enter`      | Next / previous match       | While the Browser find input is focused                                                                                                         |
| `Escape`                     | Close or revert             | Closes Browser find, exits annotation mode, or reverts an uncommitted address edit according to the focused Browser control                     |
| `MouseBack` / `MouseForward` | Browser page back / forward | Mouse buttons pressed inside the remote page navigate that Browser tab; these are distinct from app-window mouse Back/Forward outside the guest |

Browser zoom uses the complete options-menu ladder from 25% through 500% and
Reset zoom. Reload, hard reload, print, screenshot, device emulation, Profile
data clearing, downloads, and annotation actions use the Browser toolbar/menu
unless a separately listed app command owns an accelerator.

### Workbench Panel Borders

| Shortcut         | Action                         | Scope                                                                                                           |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `←` / `→`        | Resize focused panel separator | Legacy stage border handlers; project-session outer panes and split-group sashes are pointer-driven             |
| `⌘/Ctrl+Z`       | Undo local edit                | The focused surface's chronological local text and structural edits; remote and other-window edits are excluded |
| `⌘/Ctrl+Shift+Z` | Redo local edit                | The focused surface's chronological local text and structural edits                                             |
| `Ctrl+Y`         | Redo local edit                | Windows convention inside a focused collaborative editor                                                        |

## Threads Composer

| Shortcut             | Action                                      | Notes                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`              | Primary submit                              | Default thread composer submit; in `Cmd/Ctrl+Enter to send long prompts` mode, multiline drafts use `Enter` for newline instead                                                                                                    |
| `Shift+Enter`        | Insert newline                              | Thread panel composer                                                                                                                                                                                                              |
| `⌘/Ctrl+Enter`       | Submit or alternate submit                  | In default `Enter` mode this submits idle prompts and is the running-thread alternate queue/steer shortcut; in `Cmd/Ctrl+Enter to send long prompts` mode it is primary submit only for multiline drafts                           |
| `⌘/Ctrl+Shift+Enter` | Alternate queue/steer submit                | Running-thread composer only, when `Cmd/Ctrl+Enter to send long prompts` is enabled                                                                                                                                                |
| `Shift+Tab`          | Toggle Plan mode                            | Thread composer only when the prompt editor is focused, Plan mode is available, and slash/mention menus are not handling the key                                                                                                   |
| `Ctrl+Shift+M`       | Select model                                | Opens the model, effort, and speed picker for the active normal composer or `Implement this plan?` request; uses literal Control on macOS                                                                                          |
| `↑`                  | Recall queued follow-up or prompt history   | Thread composer only when the cursor is at the end and no modifier is pressed. Empty drafts first edit the latest visible queued follow-up; otherwise the empty composer recalls the newest persisted prompt history entry.        |
| `↓`                  | Walk prompt history forward or clear recall | Thread composer only when traversing recalled history. It walks toward newer entries; pressing from the newest recalled entry clears the composer and exits traversal.                                                             |
| `Ctrl+M`             | Hold to dictate                             | Electron-only thread composer dictation. Keydown starts recording; keyup stops and inserts the transcript. Button click also starts dictation, and the active dictation footer exposes `Stop dictation` and `Transcribe and send`. |

### macOS Global Dictation

| Shortcut                   | Action                      | Notes                                                                                                                                                                                                                  |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configurable global hold   | Hold to dictate in any app  | macOS only. Press begins and release stops. Supported bare modifiers, including Fn, work after Input Monitoring access. A focused Nodex Composer accepts the session in-app; otherwise the compact global bar appears. |
| Configurable global toggle | Toggle dictation in any app | macOS only. First press begins and the next press stops; key auto-repeat never starts another session. Accessibility is required only to paste outside Nodex.                                                          |

Configure global hold and global toggle directly in Settings → Voice; the full Settings → Keyboard shortcuts page edits the same bindings and also owns the Composer hold shortcut. Both surfaces use one chord recorder: modifier keydown remains pending for combinations such as `Ctrl+Y`, while supported modifier-only global bindings commit on matching keyup. Ordinary global chords must include Cmd/Ctrl or Alt plus exactly one supported non-modifier key; Shift alone does not satisfy that requirement. Capture uses the current keyboard layout and physical `KeyboardEvent.code`, so Option-produced characters such as `¥` are stored and displayed as their logical shortcut key and compile to the matching macOS key code. Fn is observed through a dedicated Fn-only native capture path and cannot cause Control or another modifier to commit early. Voice also owns microphone, Input Monitoring, and Accessibility controls.

### Request Input Cards

| Shortcut          | Action                             | Notes                                                                                                              |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `1`–`9`           | Activate numbered choice           | Advances to the next question or submits the final question; the free-form row follows the numbered preset options |
| `Enter` / `Space` | Activate selected choice           | The initially selected choice is not submitted until one of these deliberate activations                           |
| `←` / `→`         | Previous / next question           | Multi-question request-input cards only; preserves the equivalent answer-control focus                             |
| `↑` / `↓`         | Previous / next answer             | Moves through preset choices; the lower boundary can enter the free-form answer                                    |
| `Enter`           | Advance or submit free-form answer | Ignored while an IME composition is active                                                                         |
| `Shift+Enter`     | Insert newline                     | Free-form textarea only                                                                                            |
| `Escape`          | Dismiss request                    | Uses the request family’s dismiss semantics                                                                        |

## Editor (NFM / BlockNote)

### Find & Replace

| Shortcut         | Action                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+F`       | Open find panel (in-editor); seeds query from selected editor text when selection is non-empty |
| `⌘/Ctrl+G`       | Next match                                                                                     |
| `⌘/Ctrl+Shift+G` | Previous match                                                                                 |
| `Enter`          | Next match (in find input)                                                                     |
| `Shift+Enter`    | Previous match (in find input)                                                                 |
| `Enter`          | Replace current (in replace input)                                                             |
| `Escape`         | Close find panel                                                                               |

### Block Formatting

| Shortcut           | Action                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+Alt+1`–`4` | Heading level 1–4                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                |
| `⌘/Ctrl+Enter`     | Modify current block; otherwise send current thread section in Page Stage | Modifies actionable blocks first: checkbox toggle, native toggle expand/collapse, image preview, Page-reference disclosure, or bound thread-section open. A Page reference toggles in place even while its live title is focused; its independently owned body keeps the shortcut for its own editor. In Page Stage, unhandled blocks keep the existing thread-section send fallback and confirmation preview. |
| `⌘/Ctrl+A`         | Progressively select the current block, then the editor                   | The first press selects the active rich-text or plain-source Block content—including Code Block source—or an embedded Page title. Pressing it again while that leaf remains fully selected expands the selection to the whole editor.                                                                                                                                                                          |

### Input Rules (text triggers)

| Typed at line start       | Result                                        |
| ------------------------- | --------------------------------------------- |
| `> `                      | Toggle list item                              |
| `\| `                     | Quote block                                   |
| `# `–`#### `              | Heading level 1–4                             |
| `/table`                  | Insert a 2x3 simple table from the slash menu |
| `$$ ` / `\[ `             | Create a Block Equation                       |
| `$source$` / `\(source\)` | Create an Inline Equation                     |

### Tables

| Shortcut    | Action                                                 |
| ----------- | ------------------------------------------------------ |
| `Tab`       | Move to the next table cell                            |
| `Shift+Tab` | Move to the previous table cell                        |
| `Enter`     | Move to the cell below when editing table cell content |

### Code Blocks

| Shortcut                                      | Action                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Backspace` at Code Block start               | No-op; preserves the Code Block type and position                                                       |
| `Backspace` at the following text Block start | Merge that Block's plain text into the Code Block, promote its children, and keep the caret at the join |
| `Delete` at the end of a non-empty Code Block | Merge the immediately following editable text Block into the Code Block                                 |
| `Tab`                                         | Insert one literal tab at the start of every selected line                                              |
| `Shift+Tab`                                   | Remove one leading tab, two spaces, or one space from every selected line when present                  |

Mermaid Code previews additionally use Enter or Space on a focused diagram to open fullscreen, and Escape to close fullscreen and restore focus. Preview format changes are local UI state and do not enter editor Undo.

### Equations

| Shortcut         | Action                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `⌘/Ctrl+Shift+E` | Insert an Inline Equation at a text caret or convert selected text, then select its TeX source |
| `Enter`          | Submit valid TeX and close the Equation source popup                                           |
| `Shift+Enter`    | Insert a line break in Block Equation source                                                   |
| `Escape`         | Close the source popup and return focus to the Equation                                        |
| `⌘/Ctrl+A`       | Select only the active Equation source before any editor-wide selection                        |

### Navigation

| Shortcut  | Action                                              | Scope                                                                                                                                                                                                                         |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` / `↓` | Traverse Page outliner surfaces                     | At a visual boundary, moves through the visible host Block order, an authoritative child `page` / `pageRef` title, and its disclosed body Blocks without changing disclosure; hidden collapsed-toggle descendants are skipped |
| `↑` / `↓` | Navigate between cards at boundary                  | Top-level Toggle List Card editor                                                                                                                                                                                             |
| `Escape`  | Return from an engaged Card title to its host shell | Keeps Card disclosure unchanged                                                                                                                                                                                               |
| `Space`   | Toggle large image preview                          | When an image block is focused (open), or while preview modal is open (close)                                                                                                                                                 |

## Forms & Dialogs

| Shortcut             | Action                         | Scope                                                                                                                                                                                |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Enter`              | Move from title to description | Project Board Page creation dialog title                                                                                                                                             |
| `⌘/Ctrl+Enter`       | Create Page                    | Project Board Page creation dialog; when `Create more` is enabled, creates and resets title/body for the next Page                                                                   |
| `⌘/Ctrl+Shift+Enter` | Create Page and continue       | Project Board Page creation dialog; retains Status, Priority, Estimate, and Tags                                                                                                     |
| `Escape`             | Close the topmost surface      | Project Board Page composer and its property menus; an open property menu closes first, a dirty composer offers a 10-second Restore action, and pending creation cannot be dismissed |
| `Enter`              | Submit / confirm               | Project create/rename and tag input                                                                                                                                                  |
| `Escape`             | Cancel / close                 | Project forms and card-stage tag dropdown                                                                                                                                            |
| `↑` / `↓`            | Navigate suggestions           | Card stage tag input                                                                                                                                                                 |
| `Tab`                | Select highlighted tag         | Card stage tag input                                                                                                                                                                 |
| `↑` / `↓`            | Navigate entries               | History panel                                                                                                                                                                        |

## Implementation

The editable command registry and accelerator helpers live in `src/shared/command-keybindings.ts`. Renderer query/mutation state uses `codex-command-keymap-state`, `set-codex-command-keybinding`, and `reset-codex-command-keybindings`; main-process persistence writes user overrides to `~/.nodex/config.toml`.

Workbench navigation keyboard and mouse shortcuts are classified by `src/renderer/lib/keyboard-action-runtime.ts` and `src/renderer/lib/use-workbench-shortcuts.ts`, then routed into the shell's shared panel-action dispatcher in `src/renderer/components/workbench/workbench-shell.tsx`. Contextual surfaces register capabilities through `src/renderer/lib/contextual-keyboard-actions.ts`; the Workbench owns gesture arbitration and sequence state while the active Board owns Page state and execution. That dispatcher consumes `workbench-panel-capabilities.ts`, as do the bottom-panel toolbar, command palette, browser-runtime keyboard fallback, and typed desktop application-menu request. Electron owns its application-menu accelerator while the browser runtime owns the renderer key listener, preventing one keypress from toggling twice. Owner-scoped panel tab cycling and close-tab remain owned by `WorkbenchShell` because they depend on the active Project, Session, or Pages Scene, focused panel leaf, and the owning Session projection or durable Scene surface registry. Retired stage/sliding-window shortcuts are deliberately left unhandled so the mounted editor or application surface can claim them.
Collaborative title/body undo is owned by the mounted Block Document surface. Its chronological lane combines local Yjs StackItems with opaque Core structural inverse tokens; remote changes never create local entries, and there is no Workbench- or Project-wide undo shortcut owner.
Terminal panel shortcut routing is in `src/renderer/lib/use-workbench-shortcuts.ts`.
