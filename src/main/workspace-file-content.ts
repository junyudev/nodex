import type { WorkspaceFileMetadata } from "../shared/types";

export const WORKSPACE_FILE_CONTENT_SAMPLE_BYTES = 4_096;

const archiveExtensions = new Set(
  "7z,Z,apk,bz2,docm,docx,epub,gz,jar,odp,ods,odt,potm,potx,ppsm,ppsx,pptm,pptx,rar,tar,tar.gz,xlsm,xlsx,xpi,xz,zip,zst".split(
    ",",
  ),
);
const textMimeTypes = new Set([
  "application/eps",
  "application/postscript",
  "application/rtf",
  "application/x-ms-regedit",
  "application/xml",
]);

/** Local and host reads classify the same sample; filenames never override its signature. */
export async function describeWorkspaceFileBytes(
  bytes: Uint8Array,
): Promise<Pick<WorkspaceFileMetadata, "contentKind" | "mimeType">> {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg")))
    return { contentKind: "image", mimeType: "image/svg+xml" };

  const { fileTypeFromBuffer } = await import("file-type");
  // Truncated or malformed samples can make a detector throw. Fall back to the text heuristic.
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (!detected) {
    const binary = bytes.some((byte) => byte < 32 && (byte < 7 || byte > 14));
    return { contentKind: binary ? "binary" : "text" };
  }
  const { mime: mimeType, ext } = detected;
  if (mimeType === "application/pdf") return { contentKind: "pdf", mimeType };
  if (mimeType.startsWith("image/")) return { contentKind: "image", mimeType };
  if (mimeType.startsWith("audio/")) return { contentKind: "audio", mimeType };
  if (mimeType.startsWith("video/")) return { contentKind: "video", mimeType };
  if (mimeType.startsWith("text/") || textMimeTypes.has(mimeType))
    return { contentKind: "text", mimeType };
  return { contentKind: archiveExtensions.has(ext) ? "archive" : "binary", mimeType };
}
