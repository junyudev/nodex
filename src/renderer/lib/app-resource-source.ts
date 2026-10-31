import {
  APP_FILESYSTEM_PREFIX,
  buildEnvironmentAwareFilesystemUrl,
  isAbsoluteAppFilesystemPath,
} from "../../shared/app-protocol";

/** Normalizes generic local app resources while leaving conversation media to its own owner. */
export function normalizeEnvironmentAwareAppResourceSource(
  rawSource: string | null | undefined,
  rendererProtocol: string,
): string | null {
  const source = rawSource?.trim() ?? "";
  if (!source) return null;
  if (source.startsWith(APP_FILESYSTEM_PREFIX)) return source;
  if (/^(?:app:|data:|https?:)/iu.test(source)) return source;
  if (!isAbsoluteAppFilesystemPath(source)) return null;
  return buildEnvironmentAwareFilesystemUrl(source, rendererProtocol);
}
