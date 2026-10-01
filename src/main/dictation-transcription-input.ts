import { DICTATION_HISTORY_MAX_AUDIO_BYTES } from "../shared/dictation-history";

export interface DictationTranscriptionInput {
  readonly contentType: string;
  readonly base64Payload: string;
  readonly requestId: string;
}

const MULTIPART_CONTENT_TYPE = /^multipart\/form-data;\s*boundary=[^;\s]+$/iu;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/u;
// Multipart headers and fields fit within 4 KiB; Base64 expands the complete envelope.
const MAX_ENCODED_PAYLOAD_BYTES = Math.ceil((DICTATION_HISTORY_MAX_AUDIO_BYTES + 4 * 1024) / 3) * 4;

export function validateDictationTranscriptionInput(
  input: unknown,
  maxEncodedBytes = MAX_ENCODED_PAYLOAD_BYTES,
): DictationTranscriptionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid dictation content type");
  }

  const candidate = input as Partial<DictationTranscriptionInput>;
  const contentType = typeof candidate.contentType === "string" ? candidate.contentType.trim() : "";
  if (!MULTIPART_CONTENT_TYPE.test(contentType)) {
    throw new Error("Invalid dictation content type");
  }

  const base64Payload = candidate.base64Payload;
  if (
    typeof base64Payload !== "string" ||
    base64Payload.length === 0 ||
    Buffer.byteLength(base64Payload, "utf8") > maxEncodedBytes ||
    base64Payload.length % 4 !== 0 ||
    !BASE64_PAYLOAD.test(base64Payload)
  ) {
    throw new Error("Invalid or oversized dictation payload");
  }

  const requestId = candidate.requestId;
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(requestId)) {
    throw new Error("Invalid dictation request id");
  }

  return { contentType, base64Payload, requestId };
}
