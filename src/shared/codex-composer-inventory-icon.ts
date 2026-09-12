import { buildAppFilesystemUrl, isAbsoluteAppFilesystemPath } from "./app-protocol";

export type ComposerInventoryIconResolver = (filePath: string) => string | null;

/** Local composer capability icons use the app protocol in development and production. */
export function resolveComposerInventoryIconUrl(
  filePath: string | null | undefined,
): string | null {
  const normalizedPath = filePath?.trim() ?? "";
  if (!normalizedPath || !isAbsoluteAppFilesystemPath(normalizedPath)) return null;
  return buildAppFilesystemUrl(normalizedPath);
}
