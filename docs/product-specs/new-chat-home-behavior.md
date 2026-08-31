# New Chat Home Behavior

The New Chat home is one focused composition: a decorative Nodex mark, a Project-aware heading, and the ordinary Composer. It does not add starter suggestion cards or a second prompt-entry path.

## Hero mark

- The mark is a 56px decorative hit target above the heading. Its idle rendering is a low-contrast SVG mask with no white app-icon border.
- Fine-pointer hover may start one non-looping glyph performance. The performance continues after the pointer leaves and does not restart when the user clicks.
- A primary click rotates the mark toward the click direction. Nearby repeated clicks add full turns to the active rotor; differently directed clicks compose independent rotors. Every rotor closes at the pose that existed before the click sequence.
- During rotation the fitted brand projection becomes a rounded cube. Top, front, and right faces may contain centered white insets; the left face remains dark. Glyphs belong to the front face and follow its projection, occlusion, and antialiasing.
- Reduced-motion users always receive the static mark. The mark is decorative and does not enter keyboard navigation or the accessibility tree.

## Runtime ownership

- Idle rendering creates no canvas, WebGL context, timer, or animation frame. The renderer, mesh, and glyph scenes load only after a fine-pointer hover or click.
- A click uses one direct WebGL2 canvas and one shell draw call. Backing-store resolution follows the device pixel ratio and charged scale; analytic signed-distance antialiasing keeps panel and glyph edges stable.
- SVG and WebGL are mutually exclusive presentation layers. Canvas ownership removes the complete SVG from display rather than using inherited visibility, because individual glyph paths manage their own visibility. The first canvas frame must exist before hiding SVG. On settle, the renderer presents one exact rest frame and verifies that pose and glyph scene are unchanged before handing ownership back to SVG.
- Unmount, reduced-motion changes, context loss, or initialization failure stop pending work and release GPU resources. Failure leaves the static SVG visible.

## Heading and Project selector

The heading uses normal tracking and asks what to build in the selected Project. The entire trailing `Project?` text is the selector trigger with a dotted underline. Its searchable picker reuses the shared semantic dropdown surface, selected-row check, Project creation action, and conditional projectless action.

## First-send transition

- Enter and the Send button share one submission lifecycle. After a successful start, both clear the current Composer draft and show the same first user message; a failed start preserves the draft.
- A durable Session-to-Thread binding may arrive before the initiating renderer has committed the first optimistic turn. During that interval, the New Chat composition remains visible. It is replaced only when the first user turn can be shown, so the surface never passes through an empty attached-Thread frame.
- Backend discovery and binding must preserve the active Codex Composer subtree while a New Chat Session becomes a Codex Thread. Draft cleanup follows the latest Composer identity after that binding, including the Project Agent Dock surface.

Visual motion, edge quality, and repeated-click feel are accepted through manual review in the real New Chat surface. Storybook and browser automation are not release gates for this feature.
