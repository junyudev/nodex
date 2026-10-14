import type { ImageEditComposerTarget } from "@/features/user-attachment-image-editor/model/types";
import { openUserAttachmentImagePreview } from "@/features/user-attachment-image-editor/adapters/image-preview-opener-registry";
import {
  blobToDataUrl,
  dataUrlToBlob,
} from "@/features/user-attachment-image-editor/adapters/resolved-image-asset";
import { uploadImageAsset } from "../assets";
import { captureComposerImageAttachmentTarget } from "../composer-image-attachment-channel";
import { writeImageToClipboard, writeTextToClipboardStrict } from "../clipboard";
import { openFileLink } from "../file-system-operations";
import { conversationMediaFilename } from "./conversation-media-model";

export interface ConversationImageAction {
  readonly id: "open" | "address" | "add" | "copy" | "reveal" | "download";
  readonly label: string;
  readonly run: () => Promise<void>;
}
interface ImageActionInput {
  readonly url: string;
  readonly raw: string;
  readonly alt: string;
  readonly hostId?: string;
  readonly threadId?: string;
  readonly path: string | null;
  readonly composerTarget?: ImageEditComposerTarget;
  readonly isCurrent: () => boolean;
  readonly signal: AbortSignal;
  readonly download: () => Promise<void>;
}

export function conversationImageWebAddress(...sources: readonly string[]): string | null {
  for (const source of sources) {
    try {
      const url = new URL(source);
      if (url.protocol === "http:" || url.protocol === "https:") return source;
    } catch {
      // Other locators are not addresses that can be shared outside their owner.
    }
  }
  return null;
}

async function imageData(input: ImageActionInput): Promise<string | null> {
  if (!input.isCurrent() || input.signal.aborted) return null;
  if (/^data:image\//iu.test(input.url)) return input.url;
  const response = await fetch(input.url, { signal: input.signal, credentials: "omit" });
  if (!response.ok) throw new Error("Could not read image");
  if (!input.isCurrent() || input.signal.aborted) return null;
  const blob = await response.blob();
  if (!input.isCurrent() || input.signal.aborted) return null;
  const data = await blobToDataUrl(blob);
  return input.isCurrent() && !input.signal.aborted ? data : null;
}

/** Actions share the already admitted resource; authored filesystem locators never reach generic OS readers. */
export function createConversationImageActions(
  input: ImageActionInput,
): readonly ConversationImageAction[] {
  const filename = conversationMediaFilename(input.raw);
  const current = () => input.isCurrent() && !input.signal.aborted;
  const actions: ConversationImageAction[] = [
    {
      id: "open",
      label: "Open image in new tab",
      run: async () => {
        if (!current()) return;
        let source = conversationImageWebAddress(input.url);
        if (!source) {
          const data = await imageData(input);
          if (!data || !current()) return;
          const blob = dataUrlToBlob(data);
          source = await uploadImageAsset(new File([blob], filename, { type: blob.type }));
          if (!current()) return;
        }
        const opened = await openUserAttachmentImagePreview({
          src: source,
          attachmentSrc: source,
          alt: input.alt,
          title: filename,
          threadId: input.threadId,
          hostId: input.hostId,
          openInEditor: true,
          readOnly: true,
        });
        if (!opened && current()) throw new Error("Could not open image");
      },
    },
  ];
  const address = conversationImageWebAddress(input.raw, input.url);
  if (address)
    actions.push({
      id: "address",
      label: "Copy image address",
      run: async () => {
        if (current()) await writeTextToClipboardStrict(address);
      },
    });
  const composer = captureComposerImageAttachmentTarget(input.composerTarget);
  if (composer)
    actions.push({
      id: "add",
      label: "Add to chat",
      run: async () => {
        const data = await imageData(input);
        if (!data || !current()) return;
        const accepted = composer.append(
          [
            {
              src: data,
              filename,
              mimeType: /^data:([^;,]+)/iu.exec(data)?.[1],
              origin: "conversation",
              ...(input.path && input.hostId === composer.hostId && input.path.trim() === input.path
                ? { localPath: input.path, hostId: input.hostId }
                : {}),
            },
          ],
          current,
        );
        if (!accepted && current()) throw new Error("Could not add image to chat");
      },
    });
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function")
    actions.push({
      id: "copy",
      label: "Copy image",
      run: async () => {
        const data = await imageData(input);
        if (!data || !current()) return;
        const result = await writeImageToClipboard(data);
        if (!result.ok && current()) throw new Error(result.message);
      },
    });
  if (input.hostId === "local" && input.path)
    actions.push({
      id: "reveal",
      label: "Open in file manager",
      run: async () => {
        if (!current() || !input.path) return;
        if (!(await openFileLink({ path: input.path }, "fileManager")) && current())
          throw new Error("Could not reveal image");
      },
    });
  actions.push({
    id: "download",
    label: "Download a copy",
    run: async () => {
      if (current()) await input.download();
    },
  });
  return actions;
}
