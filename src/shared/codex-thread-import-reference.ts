import { isNativeCodexThreadId } from "./agent-runtime-api";

/** Import resolves a local native identity, never a remote host or an arbitrary file path. */
export function parseCodexThreadImportReference(reference: string): string | null {
  const value = reference.trim();
  if (isNativeCodexThreadId(value)) return value.toLowerCase();
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "codex:" ||
    url.hostname !== "threads" ||
    url.username ||
    url.password ||
    url.port ||
    url.searchParams.getAll("hostId").some((host) => host !== "local")
  )
    return null;
  const id = url.pathname.slice(1).replace(/\/$/u, "");
  return isNativeCodexThreadId(id) ? id.toLowerCase() : null;
}
