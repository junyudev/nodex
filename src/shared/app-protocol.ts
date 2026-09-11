export const APP_PROTOCOL_SCHEME = "app";
export const APP_RENDERER_HOST = "-";
export const APP_FILESYSTEM_HOST = "fs";
export const APP_RENDERER_ENTRY = "index.html";
export const APP_FILESYSTEM_PREFIX = "/@fs";

export const APP_RENDERER_ORIGIN = `${APP_PROTOCOL_SCHEME}://${APP_RENDERER_HOST}`;
export const APP_RENDERER_URL = `${APP_RENDERER_ORIGIN}/${APP_RENDERER_ENTRY}`;
export const APP_FILESYSTEM_ORIGIN = `${APP_PROTOCOL_SCHEME}://${APP_FILESYSTEM_HOST}`;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const RENDERER_WINDOWS_DRIVE_PATH = /^\/[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^\\\\[^\\]+\\[^\\]+/u;
const RENDERER_UNC_PATH = /^\/\/[^/]+\/[^/]+/u;

export function normalizeAppFilesystemPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return WINDOWS_DRIVE_PATH.test(normalized) && !normalized.startsWith("/")
    ? `/${normalized}`
    : normalized;
}

/** Encodes a path for either Vite's /@fs route or the app://fs namespace. */
export function buildAppFilesystemPath(filePath: string): string {
  const encoded = encodeURI(normalizeAppFilesystemPath(filePath))
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F");
  return `${APP_FILESYSTEM_PREFIX}${encoded}`;
}

export function buildAppFilesystemUrl(filePath: string): string {
  return `${APP_FILESYSTEM_ORIGIN}${buildAppFilesystemPath(filePath)}`;
}

/** Used only by resource surfaces whose development owner is Vite. */
export function buildEnvironmentAwareFilesystemUrl(
  filePath: string,
  rendererProtocol: string,
): string {
  return rendererProtocol === "http:" || rendererProtocol === "https:"
    ? buildAppFilesystemPath(filePath)
    : buildAppFilesystemUrl(filePath);
}

export function isAbsoluteAppFilesystemPath(filePath: string): boolean {
  return (
    (filePath.startsWith("/") && !filePath.startsWith("//")) ||
    WINDOWS_DRIVE_PATH.test(filePath) ||
    WINDOWS_UNC_PATH.test(filePath) ||
    RENDERER_UNC_PATH.test(filePath)
  );
}

/** Restores the native Windows drive form from a renderer path such as /C:/work/image.png. */
export function restoreNativeAppFilesystemPath(filePath: string): string {
  return RENDERER_WINDOWS_DRIVE_PATH.test(filePath) ? filePath.slice(1) : filePath;
}

/** Host-qualified assets never resolve against the Desktop filesystem. */
export function buildAppHostFilesystemUrl(hostId: string, filePath: string): string {
  return `${APP_FILESYSTEM_ORIGIN}/host?${new URLSearchParams({ hostId, path: filePath })}`;
}
