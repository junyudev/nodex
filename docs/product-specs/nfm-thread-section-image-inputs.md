# NFM Page Prompt Image Inputs

Status: Active
Last Updated: 2026-09-11

This document owns send-time image input behavior for Page text selections, the Block side menu, whole-Page sends, and runnable `threadSection` prompts.

This is intentionally focused on send-time prompt construction. It does not redefine NFM image editing, image upload, clipboard image copy, or general attachment behavior.

## Overview

When a user sends a runnable thread section from the NFM editor, image blocks in that section must reach Codex as actual image inputs, not only as markdown-like text.

At the same time, the model-visible prompt text must include a stable local reference at the original image block position so the user can write prompts such as:

```text
Compare this chart with the notes below.
<image source="nodex://files/chart-file-id">Q1 revenue chart</image>
Explain the outliers.
```

The prompt text sent to Codex becomes:

```text
Compare this chart with the notes below.
[Image #1] (caption: Q1 revenue chart)
Explain the outliers.
```

The same send also includes an app-server image input item for the image pixels.

## Prompt Text Placeholders

Each valid NFM image block in a sent thread-section prompt is replaced in the cleaned prompt text with a numbered placeholder.

Placeholder formats:

- captionless image: `[Image #N]`
- captioned image: `[Image #N] (caption: <plain caption text>)`

Rules:

- numbering starts at `1` for each send
- numbering follows document order after the section body is resolved
- placeholders are inserted at the original image block position
- raw image sources are intentionally omitted from model-visible prompt text
- captions are converted to plain text before being inserted into the placeholder

Example:

```text
<thread-section label="Analyze UI" />
Before
<image source="/tmp/sidebar.png">Sidebar screenshot</image>
Between
<image source="/tmp/dialog.png"></image>
After
```

Cleaned prompt text:

```text
Before
[Image #1] (caption: Sidebar screenshot)
Between
[Image #2]
After
```

Image inputs:

- image 1 source: `/tmp/sidebar.png`, caption: `Sidebar screenshot`
- image 2 source: `/tmp/dialog.png`

## Image Input Mapping

The renderer compiles text and ordered image occurrences as `promptInput.images[]`.
Before creating a Chat or submitting to an existing Chat, the shared Page prompt
boundary reads each Library image through its source Page and content access
context. Current Page edits are flushed before a selected-Block send so newly
inserted File occurrences are authorized by the committed Document.

Each distinct File is read once per submission and encoded with its authoritative
image MIME type. Repeated occurrences keep their individual position and caption.
The capture belongs to that submission: a later File update or removal cannot
change bytes already submitted or queued. A later send reauthorizes and reads
again. Cached display URLs never substitute for this read, and a denied, missing,
or non-image File fails the complete send before a new Chat is created.

Main resolves the resulting portable image inputs into official Codex app-server
`turn/start` items. Its existing input-retention and queue boundaries preserve the
captured bytes across execution and restart.

Supported source mapping:

- `nodex://files/<id>` -> authorized source-Page bytes captured as `data:image/...` before Chat submission
- `http://...` and `https://...` -> `{ type: "image", url }`
- `data:image/...` -> `{ type: "image", url }`
- absolute local file paths -> `{ type: "localImage", path }`
- `nodex://assets/...` -> resolved local asset path, then `{ type: "localImage", path }`

Unsupported sources fail during main-process prompt preparation. They must not silently degrade into text-only placeholders, because that would make the prompt claim an image exists without sending pixels.

## Thread Section Behavior

Thread Sections use the same Page image capture boundary as selected Blocks and whole-Page sends. Their image occurrences come from the resolved section prompt body.

The prompt body can include:

- following sibling blocks until the next sibling `threadSection`
- nested image blocks inside those included body blocks

Image-only sections are valid sends. A section containing only one image block sends:

```text
[Image #1]
```

plus the corresponding image input.

If a thread-section send targets an existing idle thread, the prompt uses `turn/start` and image inputs are allowed.

If a thread-section send targets a running turn, the prompt uses the same normalized `UserInput[]` preparation path as normal active-turn steering. Image inputs are not rejected in the renderer; the runtime resolves supported sources before sending `turn/steer`, and boundary validation handles unsupported sources.

## Relationship To Attachments

NFM image blocks and composer attachments are separate concepts.

NFM image blocks:

- are visible blocks in the rich editor document
- become numbered placeholders in thread-section prompt text
- become app-server image input items when sent from a thread section

Image attachments:

- remain attachment inputs
- do not create `[Image #N]` placeholders in NFM prompt text
- do not imply an NFM image block in the document

Plain composer sends remain text/config plus attachment inputs because the plain composer has no NFM image block surface.

## Implementation Contract

Thread-section prompt construction should:

- convert BlockNote section blocks to NFM blocks
- apply existing toggle-state synchronization
- walk the cleaned NFM tree in document order
- collect image inputs from valid image blocks
- replace those image blocks with placeholder paragraphs
- strip send-time control inline content from model-visible text
- serialize the resulting blocks with `serializeClipboardText`

Prompt compilation preserves the original image source in `promptInput.images[]`.
The shared Page submission boundary then materializes Library File sources as
authorized byte snapshots; portable source validation and `nodex://assets/...`
resolution belong in Main.

The model-visible text and app-server image input order must stay aligned by construction: `[Image #1]` refers to `promptInput.images[0]`, `[Image #2]` refers to `promptInput.images[1]`, and so on.

## Test Coverage

Required coverage:

- a captioned image block becomes `[Image #1] (caption: ...)`
- a captionless image block becomes `[Image #1]`
- multiple images are numbered in prompt order
- image-only sections are sendable
- extracted image inputs retain original source and caption metadata
- URL, data URL, absolute local path, and `nodex://assets/...` sources become the correct app-server input items
- running-turn sends with image inputs are normalized and sent through `turn/steer` with the same ordered image inputs as `turn/start`
