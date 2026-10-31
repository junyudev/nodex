import type { ImageEditSubmissionIntent, ResolvedComposerImageInput } from "@/lib/content-image";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../../shared/codex-host";
import {
  createResolvedComposerImageAttachment,
  isAbsoluteComposerImagePath,
  isManagedComposerImageSource,
  isPortableComposerImagePromptSource,
  selectComposerImagePromptSource,
  type ComposerImageAttachment,
} from "./composer-image-attachment-model";

function firstSource(
  candidates: readonly (string | null | undefined)[],
  predicate: (source: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    const source = candidate?.trim() ?? "";
    if (source && predicate(source)) return source;
  }
  return null;
}

function resolveIntentImage(
  item: ImageEditSubmissionIntent["attachments"][number],
): ResolvedComposerImageInput | null {
  const image = item.image;
  const portableSource = firstSource(
    [image.dataUrl, image.downloadSrc, image.attachmentSrc, image.src],
    isPortableComposerImagePromptSource,
  );
  const managedSource = firstSource(
    [
      image.managedSource,
      image.localPath,
      image.attachmentSrc,
      image.downloadSrc,
      image.src,
      image.dataUrl,
    ],
    isManagedComposerImageSource,
  );
  const localPath = firstSource(
    [image.localPath, image.attachmentSrc, image.downloadSrc, image.src],
    isAbsoluteComposerImagePath,
  );
  const hostId =
    image.hostId?.trim() || (managedSource || localPath ? DEFAULT_CODEX_HOST_ID : null);
  const source = portableSource ?? managedSource ?? localPath;
  if (!source) return null;

  return {
    id: item.attachmentId,
    filename: item.role === "mask" ? "image-mask.png" : image.alt.trim() || "Image",
    mimeType: portableSource?.match(/^data:([^;,]+)/iu)?.[1] ?? "image/png",
    src: source,
    origin: "image-editor",
    ...(hostId && (localPath || managedSource)
      ? {
          hostId,
          localPath,
          managedSource: managedSource ?? localPath,
        }
      : {}),
  };
}

/**
 * Materializes one editor intent through the Composer's canonical attachment
 * model. Existing attachments win by id so editing never discards their
 * portable bytes or host ownership metadata.
 */
export function buildComposerImageEditAttachments(input: {
  readonly currentAttachments: readonly ComposerImageAttachment[];
  readonly executionHostId: string | null;
  readonly generation: number;
  readonly intent: ImageEditSubmissionIntent;
}): readonly ComposerImageAttachment[] | null {
  const currentById = new Map(
    input.currentAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const attachments: ComposerImageAttachment[] = [];

  for (const item of input.intent.attachments) {
    // Masks are newly generated edit inputs. They must never inherit stale
    // bytes if a caller accidentally reuses an attachment id.
    const current = item.role === "mask" ? undefined : currentById.get(item.attachmentId);
    if (current && selectComposerImagePromptSource(current, input.executionHostId)) {
      attachments.push(current);
      continue;
    }

    const resolved = resolveIntentImage(item);
    if (!resolved) return null;
    const attachment = createResolvedComposerImageAttachment({
      id: item.attachmentId,
      generation: input.generation,
      value: resolved,
    });
    if (!attachment) return null;
    if (!selectComposerImagePromptSource(attachment, input.executionHostId)) {
      return null;
    }
    attachments.push(attachment);
  }

  return attachments;
}
