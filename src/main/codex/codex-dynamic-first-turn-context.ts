import path from "node:path";
import { readCodexThreadUuidV7TimestampMs } from "./codex-thread-timestamps";

/** Native time-bearing Thread identities select their UTC visualization day directory. */
export function resolveCodexThreadVisualizationDirectory(
  codexHome: string,
  threadId: string,
  pathApi: Pick<typeof path, "join"> = path,
): string | null {
  const timestamp =
    /^[0-9a-f]{8}-[0-9a-f]{3}[048c]-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)
      ? Number.parseInt(threadId.slice(0, 8), 16) * 1_000
      : readCodexThreadUuidV7TimestampMs(threadId);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return pathApi.join(
    codexHome,
    "visualizations",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    threadId,
  );
}
