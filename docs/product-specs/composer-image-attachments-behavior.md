# Composer Image Attachments Behavior

## Scope

This document owns image ingress, draft state, thumbnail presentation, submission, and transcript replay for the thread Composer. Image preview and editing after a thumbnail is opened are owned by [User Attachment Image Editor Behavior](./user-attachment-image-editor-behavior.md). Canonical user-message placement and transcript ordering are owned by [Codex Thread Transcript Behavior](./codex-thread-transcript-behavior.md).

## Supported image inputs

Users can add an image from the system picker, clipboard paste, native file drop, Browser handoff, or image-editor follow-up. Every entry point writes through one Composer-scoped image controller and produces the same attachment model and thumbnail surface.

Supported image MIME types are `image/gif`, `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, and `image/x-png`. When MIME is absent or generic, the supported filename extensions are `gif`, `jpeg`, `jpg`, `png`, and `webp`. Empty files are ignored. Unsupported image formats can still enter the ordinary file path where that Composer supports files; they never masquerade as image thumbnails.

Picker and native drop may use the trusted local path supplied by Electron. Paste never trusts or derives a local path from clipboard text. It reads the File bytes for immediate preview and independently saves those bytes through the managed-image boundary.

## Clipboard and drop ownership

The prompt editor classifies one `DataTransfer` before the ordinary ProseMirror paste pipeline:

- usable file-kind `items` win only when they contain more Files than `files`; otherwise a non-empty FileList wins, with items as the final fallback
- filename-only clipboard text is not treated as authored prompt text
- a pure image payload or media-only HTML payload becomes an image attachment and consumes the paste once
- an image plus meaningful visible text passes through to ProseMirror, preserving the text and not adding the image
- any ordinary file payload is consumed by the attachment owner
- media-only HTML is bounded to 100,000 characters, requires visible `img`, `svg`, `canvas`, or `video`, and ignores metadata, script/style/template content, hidden nodes, and text owned by the media element itself

Native file drag uses copy semantics and a nested drag counter, so entering child elements does not flicker the Composer drop affordance. Internal Browser image drag remains a separate producer but converges on the same image controller after its source is resolved.

## Draft model and materialization

`composerImageAttachmentsAtom` is the single draft owner within `ComposerScope`. A visible image attachment contains a stable id, filename, MIME type, immediate `src`, origin, generation, local materialization state, and independent upload state. A path is never required merely to render or submit an attachment.

For pasted and dropped File objects, preview reading and local materialization start in parallel. The attachment becomes visible only after a valid image source is readable. A late materialization patches that same id in place. Materialization failure retains the portable source and does not block submission. Removing, clearing, changing Composer scope, or unmounting invalidates late results; they cannot recreate an attachment. Repeating the same explicit paste or drop creates distinct attachments.

Browser `Send to chat` publishes one canonical managed-asset source. The Composer records that value as host-owned materialization metadata; it never relabels the managed URI as an inline data URL or absolute filesystem path. Display-only `file-service://` and `sediment://` pointers remain resolver inputs and are never sent directly to app-server.

Draft transfer, queued follow-up, completed-draft, image-edit follow-up, and thread-goal paths capture immutable attachment values. Image bytes are session-scoped and are not written to localStorage.

Queue capture adds a durable portability boundary. Main rejects renderer-only object URLs and relative file sources, preserves HTTP sources, and freezes data-image, absolute-file, and file-URL bytes in a private temporary cache. The complete prompt input and captured attachment evidence form an immutable manifest. Core publishes the manifest and attachments as shared Blobs; the queue commit consumes matching prepared receipts and retains the complete closure in one transaction. Capturing or publishing an attachment does not create a Library File.

Core retains those references with the ordered Thread ledger across restart, backup, and restore. Removing or replacing a queue row releases its references. Shared Blob collection preserves bytes still retained by another queue, a Thread input, a File, or recovery content. Submitted Thread inputs remain retained independently of the queue. Updating or deleting the source File cannot change captured input bytes.

Hydration reads through the owning Thread's authority and verifies the manifest and all referenced bytes before exposing the row, even when a temporary cache already exists. Cache loss is recoverable; missing or corrupt Core evidence produces an explicit queue load error. Each attachment is bounded to 256 MiB, each manifest to 64 MiB, and one ledger publication to 512 MiB and 1,024 prepared Blobs. Image MIME hints are captured with the payload so content-addressed storage names do not determine image presentation.

## Attachment row and thumbnail

Visible attachments occupy the Composer attachment slot above the prompt. The row scrolls horizontally without wrapping and aligns all attachment surfaces to the bottom with an 8px gap.

- image-only thumbnails are `80 × 80px`
- thumbnails become `54 × 54px` whenever any visible non-image attachment shares the slot
- the thumbnail uses the shared Composer attachment radius and heavy border token, a cropped image, and a permanently visible 16px remove control at the top right
- the remove control stops pointer and click propagation, removes immediately, and never opens preview
- a previewable thumbnail is a keyboard focus target named by its filename; click, Enter, and Space open it
- a real remote upload may show a labeled progress overlay; local managed-asset materialization never pretends to be an upload
- adding and removing thumbnails is an immediate state switch with no thumbnail-specific animation

Composer thumbnails always open the right-panel image editor directly, regardless of the transcript's shared image-click policy; they never create a Composer-owned lightbox. Transcript images continue to open the shared preview dialog and expose its Edit action. Disabled editing still allows transcript preview. The Composer thumbnail keeps focus when opening fails, while the right-panel tab owns subsequent focus behavior.

## Submission and execution host

One pure source selector compiles every attachment-bearing Composer action. A ready materialization belonging to the current execution host may supply its local path or managed-asset URI. Otherwise the source must be portable data or HTTP content. Main freezes images from the current machine and inline media, retains their exact bytes for the Thread through Core, and sends portable app-server media input. Media detail settings remain unchanged. A remote host's local image or audio path remains remote; Main never opens that path on the current machine.

Ordinary sends and steers complete Thread retention before transport. Captured managed file attachments point to immutable materialized bytes, while ordinary workspace file attachments keep their filesystem semantics. Repeating the same submission uses the same retention identity, and failure leaves captured bytes available for retry. Thread input retention creates no Library Files.

Ordinary send, new-thread start, Side chat, queue, steer, image-edit follow-up, and thread-goal materialization must not independently choose between a path and data URL. A missing or invalid source is rejected before transport rather than producing an empty image input.

Image editing binds to a stable root-or-side Composer channel rather than to a nullable Thread id. The editor contributes a typed intent; this Composer first resolves every original by its stable attachment id, preserving its portable bytes and execution-host ownership, then materializes newly generated masks or selections. It applies the exact prompt override and reuses the same first-send, idle-send, or active-turn queue boundary as ordinary input. New Chat therefore starts its first Thread through the normal Session send path, projectless Chats remain supported, and a running image edit queues rather than steers. Successful submission clears the matching image-edit draft; failure leaves prompt, attachments, comments, and editor state available for retry.

## Transcript replay and trust boundary

User-image projection preserves three source kinds:

- `inline-image` for app-server `image`
- `local-image` for app-server `localImage`
- `remote-pointer` for generated or remote asset pointers

Inline images resolve without filesystem access. A `local-image` may read its exact path only when the owning conversation host is the trusted local host; another host receives a named unavailable state and never probes the local machine. Remote pointers use the conversation asset resolver and its retry/object-URL lifecycle. A failed but resolvable thumbnail shows a named retry action instead of an unexplained punctuation placeholder.

## Accessibility and failure behavior

Thumbnail open, remove, upload, retry, dialog navigation, edit, and download controls have accessible names. Enter and Space open focused thumbnails, while Escape behavior remains owned by the preview/editor surface. Removal never steals prompt focus.

Unreadable image bytes report an attachment error and create no shell. Managed-path failure falls back only when a portable source exists. Unsupported-model rejection creates no partial draft. Remote-host local paths, malformed managed URIs, renderer-only pointers, and invalid sources remain unavailable without filesystem IPC. The Composer is the single error owner for a channel-routed send failure, so the editor must not add a duplicate toast. Submission failures preserve the attachment draft so the user can retry or remove it.
