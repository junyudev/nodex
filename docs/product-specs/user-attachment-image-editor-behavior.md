# User Attachment Image Editor Behavior

## Scope

Nodex gives uploaded and generated images one shared preview and editing system. It owns the full-screen preview dialog, right-panel image tabs, focused zoom and pan, positional comments, remove masks, aspect-ratio edits, and the generated-image Canvas. Composer ingress, thumbnail-shell, submission, and replay behavior are owned by [Composer Image Attachments Behavior](./composer-image-attachments-behavior.md).

## Opening images

- Clicking a Composer thumbnail opens the right-panel editor directly. Clicking an image in the transcript opens the preview dialog; its explicit `Edit image` action then opens the editor. Generated galleries keep separate open, Edit, and Canvas actions.
- The preview dialog supports download, adjacent-image keyboard navigation, zoom, pan, Escape dismissal, and focus restoration.
- An explicit edit opens a right-panel preview tab. Opening another image in the same panel leaf replaces only the prior unpinned image preview.
- Double-clicking the tab label or interacting with its non-exempt body pins it as a durable `image_editor` Scene surface. Pinned image tabs can be reordered, moved, split, closed, cloned into a new window, and restored with the Window Session. Close, local Open, and download controls are pin-exempt.
- A durable tab persists only bounded image metadata, stable managed/local/pointer/remote locators, its active image, view, and tool. It never persists bitmap masks, comments in progress, object/data URLs, callbacks, DOM geometry, or undo history. A locator that cannot be made durable leaves the preview open and reports a recoverable failure.
- The right panel expands on the first image edit only. The Profile-local key is `image-side-panel-auto-expanded-v1`.
- Uploaded images use `User attachment`. Generated images use `{conversation title} - Generated image N` when a conversation title exists, otherwise `Generated image N`; the tab title follows the active image.
- Generated gallery images expose `Edit`; multi-image galleries expose `Canvas`. A single generated image still exposes Focused/Canvas switching once opened in the editor; the multi-image threshold controls the gallery shortcut and Focused rail, not Canvas capability.

## Focused image tools

The focused view has Comment, Remove BG, Erase, and Resize. At container widths up to 630px labels become visually hidden, and at 450px or below the edit pill is hidden. Images fit without enlarging past natural size. Manual zoom offers 25%, 50%, 100%, 150%, and 200% plus continuous 10–400% Ctrl-wheel or pinch zoom with a stable anchor. Overflowed images pan with a captured non-touch pointer. Zoom-anchor correction and pointer pan are normalized by the current application-window zoom. In a full-width generated view, the image center accounts for half of the 72px rail reserve and mirrors that inline offset in RTL.

Comment mode normalizes marker coordinates. New comments save with Enter; existing comments save with Cmd/Ctrl+Enter and support Delete, Cancel, and Escape. Composer-owned comments serialize immediately before submission as ordered `Image N` instructions with locale-formatted percentage coordinates. General text is appended as `Additional instructions`.

Remove BG is an immediate original-only image edit. It submits `Remove the background from this image. Keep all foreground subjects unchanged and fully intact, with clean, smooth edges. Make the background transparent.` through the normal image-edit lane, without a local segmentation step, confirmation surface, or mask attachment. Its pending indicator belongs only to that action while the other focused tools remain locked.

Erase mode draws a natural-image-size canvas with a 5–130 brush slider, default 70, pointer capture, undo, redo, and cancel. Send constructs a black PNG with white strokes and submits original plus mask with `Remove the area marked in the second image from the first image`.

Resize offers Square 1:1, Portrait 3:4, Story 9:16, Landscape 4:3, and Widescreen 16:9. Selection submits the original with `Make the aspect ratio {ratio}`.

## Submission ownership

The mounted root or side Composer is the single writable owner for image-edit selection, positional comments, prompt text, attachment materialization, and submission. The editor emits a typed intent and never guesses transport from a nullable Thread id. A stable Session Composer channel survives focus changes and the first Thread attachment while keeping root and side Composers isolated. Resolving an image for display must not erase or reinterpret its attachment id, host id, managed source, or trusted local path.

New Chat, projectless tasks, Project tasks, and idle existing tasks use the normal Composer send boundary. The first edit from New Chat creates the task with the current run context; an edit sent during an active turn enters the ordinary queued-follow-up lane and is never steered. When no matching Composer is mounted, only an existing task may use the bounded direct-thread fallback. Failure preserves the editor and Composer drafts.

Erase submits the original followed by a newly generated `image-mask.png`; Remove BG and Resize submit the original only; comments submit their referenced images in display order; Multi-select submits the selected generated images. The Composer reuses an existing original attachment by id instead of rebuilding it from an editor display URL. Every path compiles to standard image or local-image prompt inputs. Image-input capability and asset-read failures are reported before transport rather than creating an empty or punctuation-only attachment.

## Generated-image Canvas

The Canvas reconciles all loaded historical turn groups, the mounted live tail, pending placeholders, and optimistic edit placeholders for the active task. Canonical group order remains authoritative. An optimistic placeholder can be claimed only by the matching live-tail position; mounting an unrelated historical image cannot steal it. A successful generated-image edit transfers focus to that replacement, otherwise to the current live-tail end, the prior active image, or the final available image in that order.

The surface provides a Focused/Canvas toggle and one-time anchored coachmark; a reduced-motion-aware 450ms `cubic-bezier(0.22, 1, 0.36, 1)` geometry morph; anchored zoom; Navigate, Comment, and Multi-select; selected-image Composer attachments; batch positional comments; loading/error retry; selection rings; and turn timestamps. The transition measures the active visual before and after a synchronous view switch, scrolls the Canvas target into view, divides translation by both application-window zoom and Canvas zoom, and keeps rect-derived scale independent of zoom.

Opening directly into Canvas and switching from Focused into Canvas request a full-width right panel. Switching back to Focused intentionally leaves the panel width unchanged; the user may restore regular width independently while Canvas remains selected. The Focused rail appears only when the right panel is full-width and the generated collection contains more than one image. It uses 46px thumbnails, a 54px stride, 6px vertical padding, a 72px reserve, keyboard/wheel navigation, and one-time optimistic-tail auto-scroll.

Canvas loading placeholders share one device-pixel-aware dot-field clock. Single/default spacing is `12 / devicePixelRatio`; Canvas and thumbnail spacing are 14px and 6px. Hidden, offscreen, or reduced-motion presentations do not run a continuous paint loop.

The Canvas and the full-width right-panel Composer share the stable Composer-channel draft. Closing the panel preserves that draft; removing a Composer chip deselects that image. Explicit Cancel discards the current comment draft, while a submission failure preserves comments and selection. Successful submission clears the draft.

## Asset, failure, and accessibility contract

One resolver handles data URLs, managed assets, Agent image pointers, remote/direct URLs, and trusted local paths. Managed sources and durable managed locators must pass the canonical asset parser; a scheme-shaped but malformed URI is never treated as an asset. A valid managed locator is resolved through the trusted preload bridge and compiled to the same app-local display URL as an absolute local image. Only successful resolutions are cached for the current renderer window, so an asset that appears later can recover without a restart. Durable state never stores display-only `app:` or development `/@fs` URLs. Local reads are opt-in and local-host-only. Object URLs are revoked. Preview and download sources stay separate.

Packaged and development conversation images use the app-local media transport instead of `file:`. The production renderer policy admits that transport for images and media while continuing to reject direct filesystem URLs. A failed managed-path resolution renders a recoverable unavailable state rather than emitting an invalid image request.

Trusted local images replace the standalone download icon with an `Open` split control. Its primary action opens the image in the operating system's default app; the menu offers `Open in folder` and `Save as…`.

Loading, failed, retrying, downloading, pinning, and submitting states belong to the nearest surface. Failed resolution offers Retry where reversible. Submission errors preserve comments, mask history, and selection. Capability rejection leaves tools inactive and reports the failure without creating partial draft state. Editor Send actions use the dedicated blue accent-action treatment with a light foreground in both themes and stable disabled/loading geometry.

Interactive images, toolbars, view toggles, markers, menus, downloads, and retry controls have accessible names. `aria-pressed` communicates selection. Arrow keys navigate lightboxes and the rail. Escape first cancels the innermost comment editor, then exits the active Comment/Erase/Multi-select tool, and finally closes dialogs at the outer layer. Reduced-motion users receive immediate view switching and static loading affordances.
