/** Electron prefixes a rejected IPC call with its channel; the readable reason follows. */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/u;

/** The readable reason of a rejected call, or the fallback when it carries none. */
export function readableIpcError(error: unknown, fallback = ""): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.replace(REMOTE_METHOD_PREFIX, "").trim() || fallback;
}
