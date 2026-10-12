import type { GeneratedImageLiveGroupInput } from "@/features/user-attachment-image-editor";
import { projectCodexMarkdownLabel } from "../../../../shared/codex-markdown-text";
import type { CodexTranscriptGeneratedImage } from "../normalized-transcript-read-owner";
import { isGeneratedImagePending } from "./generated-image-output";

/** The existing image collection consumes only native resident images, never materialized Turns. */
export function projectGeneratedImageTranscriptGroups(
  images: readonly CodexTranscriptGeneratedImage[],
  threadTitle: string,
): readonly GeneratedImageLiveGroupInput[] {
  const title = projectCodexMarkdownLabel(threadTitle);
  let ordinal = 0;
  return images.flatMap(({ entityKey, item, turnId, turnStartedAtMs }) => {
    const pending = isGeneratedImagePending(item.src, item.status);
    if (item.src == null && !pending) return [];
    const id = JSON.stringify([entityKey, item.id]);
    const alt = `Generated image ${++ordinal}`;
    return [
      {
        id,
        nativeItemIds: [item.id],
        images:
          item.src == null
            ? []
            : [
                {
                  id: item.id,
                  alt,
                  attachmentId: item.id.startsWith("image-playground:")
                    ? item.id
                    : `image-playground:${item.id}`,
                  attachmentSrc: item.src,
                  downloadSrc: item.src,
                  generatedOrdinal: ordinal,
                  groupId: id,
                  previewSrc: item.src,
                  referrerPolicy: "no-referrer" as const,
                  source: "generated" as const,
                  src: item.src,
                  status: "ready" as const,
                  tabTitle: title ? `${title} - ${alt}` : alt,
                  turnId: turnId ?? undefined,
                  turnStartedAtMs: turnStartedAtMs ?? undefined,
                },
              ],
        pendingImageCount: pending ? 1 : 0,
        pendingImageIds: pending ? [item.id] : [],
        turnStartedAtMs,
      },
    ];
  });
}
