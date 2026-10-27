import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";

export interface NativeAttachmentResource {
  readonly name: string;
  readonly source: string;
  readonly mimeType?: string;
}
export interface NativeMediaResource {
  readonly id: string;
  readonly media: "image" | "audio";
  /** Null is a real opaque provider identity, never a guessed local path. */
  readonly resource: NativeAttachmentResource | null;
}
const basename = (source: string) => source.split(/[\\/]/u).at(-1) || "Attachment";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Project only actual media fields of the generated producer item union. */
export function nativeSessionMediaResources(item: ThreadItem): readonly NativeMediaResource[] {
  if (item.type === "imageView")
    return [
      { id: "image", media: "image", resource: { name: basename(item.path), source: item.path } },
    ];
  if (item.type === "imageGeneration") {
    if (!item.savedPath && !item.result) return [];
    return [
      {
        id: "image",
        media: "image",
        resource: {
          name: "Generated image.png",
          source: item.result ? `data:image/png;base64,${item.result}` : item.savedPath!,
          mimeType: "image/png",
        },
      },
    ];
  }
  if (item.type === "userMessage")
    return item.content.flatMap((part, index): NativeMediaResource[] => {
      const id = `input:${index}`;
      if (part.type === "localImage" || part.type === "localAudio")
        return [
          {
            id,
            media: part.type === "localImage" ? "image" : "audio",
            resource: { name: basename(part.path), source: part.path },
          },
        ];
      if (part.type === "image")
        return [
          {
            id,
            media: "image",
            resource: "url" in part ? { name: "Attached image", source: part.url } : null,
          },
        ];
      if (part.type === "audio")
        return [{ id, media: "audio", resource: { name: "Attached audio", source: part.url } }];
      return [];
    });
  if (item.type === "dynamicToolCall")
    return (item.contentItems ?? []).flatMap((part, index): NativeMediaResource[] => {
      if (part.type === "inputText") return [];
      return [
        {
          id: `content:${index}`,
          media: part.type === "inputImage" ? "image" : "audio",
          resource: {
            name: part.type === "inputImage" ? "Tool image" : "Tool audio",
            source: part.type === "inputImage" ? part.imageUrl : part.audioUrl,
          },
        },
      ];
    });
  if (item.type === "functionCallOutput" && Array.isArray(item.output))
    return item.output.flatMap((part, index): NativeMediaResource[] => {
      if (part.type === "input_image")
        return [
          {
            id: `content:${index}`,
            media: "image",
            resource: "image_url" in part ? { name: "Tool image", source: part.image_url } : null,
          },
        ];
      if (part.type === "input_audio")
        return [
          {
            id: `content:${index}`,
            media: "audio",
            resource: { name: "Tool audio", source: part.audio_url },
          },
        ];
      return [];
    });
  if (item.type !== "mcpToolCall") return [];
  return (item.result?.content ?? []).flatMap((part, index): NativeMediaResource[] => {
    if (!record(part) || (part.type !== "image" && part.type !== "audio")) return [];
    const media = part.type;
    return [
      {
        id: `content:${index}`,
        media,
        resource:
          typeof part.mimeType === "string" && typeof part.data === "string"
            ? {
                name: media === "image" ? "Tool image" : "Tool audio",
                mimeType: part.mimeType,
                source: `data:${part.mimeType};base64,${part.data}`,
              }
            : null,
      },
    ];
  });
}

/** Native resources have source item/content coordinates, not invented attachment identities. */
export function nativeSessionAttachmentResource(
  item: ThreadItem,
  attachmentId: string,
): NativeAttachmentResource | null {
  const media = nativeSessionMediaResources(item).find((resource) => resource.id === attachmentId);
  if (media) return media.resource;
  const match = /^input:(0|[1-9]\d*)$/u.exec(attachmentId);
  if (!match || item.type !== "userMessage") return null;
  const part = item.content[Number(match[1])];
  return part?.type === "mention" ? { name: part.name, source: part.path } : null;
}
