import type {
  DictationHttpDiagnostics,
  DictationTextResult,
} from "../../../shared/dictation-diagnostics";
import { cancelDictationRequest, transcribeDictationRequest } from "./dictation-command-runtime";

const DEFAULT_DICTATION_CONTENT_TYPE = "audio/webm";
const BASE64_CHUNK_SIZE = 32_768;

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const sanitizeDictationFilename = (value: string): string => value.replaceAll('"', "");

export const createDictationBoundary = (): string => `----codex-transcribe-${crypto.randomUUID()}`;

export const encodeDictationBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let index = 0; index < bytes.byteLength; index += BASE64_CHUNK_SIZE) {
    text += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_SIZE));
  }
  return btoa(text);
};

export async function buildDictationMultipartPayload(input: {
  readonly blob: Blob;
  readonly boundary: string;
  readonly filename: string;
  readonly contentType: string;
  readonly language?: string;
}): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    encoder.encode(`--${input.boundary}\r\n`),
    encoder.encode(`Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n`),
    encoder.encode(`Content-Type: ${input.contentType}\r\n\r\n`),
    new Uint8Array(await input.blob.arrayBuffer()),
    encoder.encode("\r\n"),
  ];
  if (input.language) {
    chunks.push(
      encoder.encode(`--${input.boundary}\r\n`),
      encoder.encode(`Content-Disposition: form-data; name="language"\r\n\r\n`),
      encoder.encode(`${input.language}\r\n`),
    );
  }
  chunks.push(encoder.encode(`--${input.boundary}--\r\n`));
  return concatBytes(chunks);
}

const resolveDictationContentType = (blob: Blob, override?: string): string =>
  (override ?? blob.type).trim() || DEFAULT_DICTATION_CONTENT_TYPE;

const resolveDictationFilename = (contentType: string, override?: string): string => {
  const extension = contentType.split(/[/;]/)[1] ?? "webm";
  return sanitizeDictationFilename(override ?? `codex.${extension}`);
};

export async function transcribeDictationBlob(
  blob: Blob,
  options?: {
    readonly contentType?: string;
    readonly filename?: string;
    readonly language?: string;
    readonly signal?: AbortSignal;
    readonly onDiagnostics?: (diagnostics: DictationHttpDiagnostics) => void;
    readonly transcribe?: (input: {
      readonly contentType: string;
      readonly base64Payload: string;
    }) => Promise<DictationTextResult>;
  },
): Promise<string> {
  const contentType = resolveDictationContentType(blob, options?.contentType);
  const filename = resolveDictationFilename(contentType, options?.filename);
  const boundary = createDictationBoundary();
  const multipartBody = await buildDictationMultipartPayload({
    blob,
    boundary,
    filename,
    contentType,
    language: options?.language,
  });
  const input = {
    contentType: `multipart/form-data; boundary=${boundary}`,
    base64Payload: encodeDictationBase64(multipartBody),
  };
  const readResult = (result: DictationTextResult): string => {
    options?.onDiagnostics?.(result.diagnostics);
    if (result.diagnostics.outcome !== "completed") {
      throw Object.assign(new Error("Unable to transcribe dictation"), {
        status: result.diagnostics.status === 200 ? 502 : result.diagnostics.status,
      });
    }
    return result.text;
  };
  if (options?.transcribe) return readResult(await options.transcribe(input));
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Dictation was aborted", "AbortError");
  }

  const requestId = crypto.randomUUID();
  const cancel = (): void => {
    void cancelDictationRequest(requestId).catch(() => undefined);
  };
  options?.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await transcribeDictationRequest({ ...input, requestId });
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Dictation was aborted", "AbortError");
    }
    return readResult(result);
  } finally {
    options?.signal?.removeEventListener("abort", cancel);
  }
}
