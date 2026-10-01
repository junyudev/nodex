import type { UserInput } from "@nodex/codex-app-server-protocol/v2";

const FILE_SOURCE_PREFIX = "file-service://";

/** Hosted images retain their native file ID when a queued prompt is reconstructed. */
export function codexImageFileIdFromSource(source: string): string | null {
  const normalized = source.trim();
  if (!normalized.startsWith(FILE_SOURCE_PREFIX)) return null;
  return normalized.slice(FILE_SOURCE_PREFIX.length) || null;
}

export function codexImageInputSource(
  input: Extract<UserInput, { type: "image" | "localImage" }>,
): string {
  if (input.type === "localImage") return input.path;
  return "url" in input ? input.url : `${FILE_SOURCE_PREFIX}${input.fileId}`;
}
