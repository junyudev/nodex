import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import type { z } from "zod";
import {
  RENDERABLE_IMAGE_SIGNATURE_BYTES,
  renderableImageType,
} from "../../shared/renderable-image";
import {
  HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES,
  type AgentRuntimeAttachmentSchema,
  type HostedChatAttachmentChunk,
  type HostedChatAttachmentReadSchema,
} from "../../shared/schemas/agent-runtime-api";

type Reference = z.infer<typeof AgentRuntimeAttachmentSchema>;
type Range = z.infer<typeof HostedChatAttachmentReadSchema>;

/**
 * A hosted chat's picture, read whole from its Space host in bounded ranges, so the renderer here
 * gets exactly what a local chat's attachment read gives it. Only bytes that are a renderable
 * image become one; anything else, or an image larger than a chat can hold, is not shown.
 */
export const readHostedChatImage = <E>(
  reference: Reference,
  readRange: (range: Range) => Effect.Effect<HostedChatAttachmentChunk, E>,
) =>
  Effect.gen(function* () {
    const ranges: Buffer[] = [];
    let read = 0;
    let first: HostedChatAttachmentChunk | null = null;
    do {
      const chunk: HostedChatAttachmentChunk = yield* readRange({
        ...reference,
        offset: read,
        length: HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES,
        ...(first ? { version: first.version } : {}),
      });
      first ??= chunk;
      const bytes = Buffer.from(chunk.base64, "base64");
      if (
        chunk.totalBytes !== first.totalBytes ||
        first.totalBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
        bytes.length > HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES ||
        read + bytes.length > first.totalBytes ||
        (bytes.length === 0 && read < first.totalBytes)
      )
        return null;
      ranges.push(bytes);
      read += bytes.length;
    } while (read < first.totalBytes);
    const image = Buffer.concat(ranges);
    const type = renderableImageType(image.subarray(0, RENDERABLE_IMAGE_SIGNATURE_BYTES));
    if (!type || type !== first.mimeType) return null;
    return { dataUrl: `data:${type};base64,${image.toString("base64")}` };
  });
