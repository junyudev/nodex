# Page Prompt Image Inputs

Status: Active
Last Updated: 2026-10-28

This document owns send-time image input behavior for Page text selections, the Block side menu, whole-Page sends and selected Blocks.

This is intentionally focused on send-time prompt construction. It does not redefine Page editor image editing, image upload, clipboard image copy, or general attachment behavior.

## Overview

When a user sends Page content to chat, image blocks in the selection or Page must reach Codex as actual image inputs, not only as markdown-like text.

At the same time, the model-visible prompt text must include a stable local reference at the original image block position so the user can write prompts such as:

```text
Compare this chart with the notes below.
![Q1 revenue chart](nodex://files/chart-file-id)
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

Each valid image Block in a sent Page prompt is replaced in the cleaned prompt text with a numbered placeholder.

Placeholder formats:

- captionless image: `[Image #N]`
- captioned image: `[Image #N] (caption: <plain caption text>)`

Rules:

- numbering starts at `1` for each send
- numbering follows document order within the selected content
- placeholders are inserted at the original image block position
- raw image sources are intentionally omitted from model-visible prompt text
- captions are plain text and retain their text in the placeholder

Example:

```text
Before
![Sidebar screenshot](/tmp/sidebar.png)
Between
![](/tmp/dialog.png)
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
boundary reads each Library image through its exact source Page and File identity. Current Page edits are flushed before a selected-Block send so newly
inserted File occurrences are represented by the committed Document.

Each distinct File is read once per submission and encoded with its authoritative
image MIME type. Repeated occurrences keep their individual position and caption.
The capture belongs to that submission: a later File update or removal cannot
change bytes already submitted or queued. A later send validates the current
source identity, lifecycle and version, then reads again. Cached display URLs never substitute for this read, and a missing, cross-Library,
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

## Page Prompt Sends

Selected text, selected Blocks, the Block side menu, whole-Page Send to chat, and
Send & wrap share this image capture boundary. Nested image Blocks in the selected
content retain document order. Image-only content is a valid send: its prompt is
`[Image #1]` plus the corresponding image input.

An idle chat receives `turn/start`. A running chat uses the same normalized
`UserInput[]` preparation path as active-turn steering. Main resolves supported
image sources before `turn/steer`; boundary validation rejects unsupported sources.
Queued sends retain the captured bytes and occurrence ordering until submission.

## Relationship To Attachments

Page image Blocks and composer attachments are separate concepts.

Page image Blocks:

- are visible blocks in the rich editor document
- become numbered placeholders in Page prompt text
- become app-server image input items when sent from a Page

Image attachments:

- remain attachment inputs
- do not create `[Image #N]` placeholders in Page prompt text
- do not imply an image Block in the document

Plain composer sends remain text/config plus attachment inputs because the plain composer has no Page image Block surface.

## Implementation Contract

Page prompt construction should:

- walk the selected BlockNote tree in document order, including table cells
- collect image inputs from image Blocks and inline images
- replace image Blocks with placeholder paragraphs and inline images with placeholder text
- move Agent config atoms into typed sidecars and omit them from model-visible text
- write the resulting Blocks as exact Nodex Markdown through `writeMarkdown`

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
- image-only content is sendable
- extracted image inputs retain original source and caption metadata
- URL, data URL, absolute local path, and `nodex://assets/...` sources become the correct app-server input items
- running-turn sends with image inputs are normalized and sent through `turn/steer` with the same ordered image inputs as `turn/start`
