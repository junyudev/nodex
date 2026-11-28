import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@nodex/agent-runtime/contracts";
import {
  MAX_TOOL_RESULT_AUDIO_BYTES,
  toolResultAudioMimeType,
} from "@nodex/agent-runtime/tool-result-audio";
import { isAgentRuntimeToolResultAttachmentId } from "../../shared/agent-runtime-attachments";
import * as Effect from "effect/Effect";
import type { z } from "zod";
import {
  RENDERABLE_IMAGE_SIGNATURE_BYTES,
  renderableImageType,
} from "@nodex/agent-runtime/renderable-image";
import {
  HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES,
  type AgentRuntimeAttachmentSchema,
  type HostedChatAttachmentChunk,
  type HostedChatAttachmentReadSchema,
} from "../../shared/schemas/agent-runtime-api";

type Reference = z.infer<typeof AgentRuntimeAttachmentSchema>;
type Range = z.infer<typeof HostedChatAttachmentReadSchema>;

/**
 * A hosted chat's picture or tool-result audio, read in versioned ranges from the Space host.
 * Images must have a renderable signature. Audio is admitted only for an inline tool result
 * with a supported MIME type.
 */
export const readHostedChatAttachment = <E>(
  reference: Reference,
  readRange: (range: Range) => Effect.Effect<HostedChatAttachmentChunk, E>,
) =>
  Effect.gen(function* () {
    const ranges: Buffer[] = [];
    let read = 0;
    let first: HostedChatAttachmentChunk | null = null;
    let audioMimeType: string | null = null;
    const canReadAudio = isAgentRuntimeToolResultAttachmentId(reference.attachmentId);
    do {
      const chunk: HostedChatAttachmentChunk = yield* readRange({
        ...reference,
        offset: read,
        length: HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES,
        ...(first ? { version: first.version } : {}),
      });
      if (!first) {
        first = chunk;
        audioMimeType = canReadAudio ? toolResultAudioMimeType(chunk.mimeType) : null;
      }
      const maximum = audioMimeType
        ? MAX_TOOL_RESULT_AUDIO_BYTES
        : PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
      const bytes = Buffer.from(chunk.base64, "base64");
      if (
        chunk.totalBytes !== first.totalBytes ||
        chunk.mimeType !== first.mimeType ||
        chunk.version !== first.version ||
        first.totalBytes <= 0 ||
        first.totalBytes > maximum ||
        bytes.length > HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES ||
        read + bytes.length > first.totalBytes ||
        (bytes.length === 0 && read < first.totalBytes)
      )
        return null;
      ranges.push(bytes);
      read += bytes.length;
    } while (read < first.totalBytes);
    const media = Buffer.concat(ranges);
    const type =
      audioMimeType ?? renderableImageType(media.subarray(0, RENDERABLE_IMAGE_SIGNATURE_BYTES));
    if (!type || (audioMimeType === null && type !== first.mimeType)) return null;
    return { dataUrl: `data:${type};base64,${media.toString("base64")}` };
  });
