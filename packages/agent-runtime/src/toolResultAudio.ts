// Leave room in the 16 MiB Runtime frame for the attachment response envelope, and
// in the separate 15 MiB full-item budget for an ordinary item's other fields.
export const MAX_TOOL_RESULT_AUDIO_BASE64_LENGTH = 14 * 1024 * 1024;
export const MAX_TOOL_RESULT_AUDIO_BYTES = (MAX_TOOL_RESULT_AUDIO_BASE64_LENGTH / 4) * 3;

const AUDIO_MIME_TYPE = /^audio\/(?:wav|x-wav|mpeg|mp4|aac|x-m4a|ogg|opus|flac|webm)$/u;
const DATA_URL_HEADER = /^data:(audio\/[a-z0-9-]+);base64,/iu;

export function toolResultAudioMimeType(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16) return null;
  const mimeType = value.toLowerCase();
  return AUDIO_MIME_TYPE.test(mimeType) ? mimeType : null;
}

export function isToolResultAudioBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TOOL_RESULT_AUDIO_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(value)
  )
    return false;
  const padding = value.indexOf("=");
  return padding === -1 || padding === value.length - (value.endsWith("==") ? 2 : 1);
}

export function parseToolResultAudioDataUrl(
  value: string,
): { readonly mimeType: string; readonly base64: string } | null {
  if (value.length > MAX_TOOL_RESULT_AUDIO_BASE64_LENGTH + 32) return null;
  const header = DATA_URL_HEADER.exec(value.slice(0, 32));
  const mimeType = toolResultAudioMimeType(header?.[1]);
  if (!header || !mimeType) return null;
  const base64 = value.slice(header[0].length);
  return isToolResultAudioBase64(base64) ? { mimeType, base64 } : null;
}
