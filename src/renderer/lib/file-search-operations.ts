import type { FileSearchEvent, FileSearchScope } from "../../shared/file-search";
import { invokeRendererControl } from "@/lib/renderer-command";
import { resolveRendererTransport } from "@/lib/renderer-transport";

export interface FileSearchController {
  readonly update: (query: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** One lazy native session per mounted search scope; edits reuse the index and closing stops it. */
export function createFileSearchSession(
  input: FileSearchScope & {
    readonly onEvent: (event: FileSearchEvent) => void;
  },
): FileSearchController {
  const sessionId = crypto.randomUUID();
  let start: Promise<void> | null = null;
  let stopped = false;
  let latestQuery = "";
  const unsubscribe = resolveRendererTransport().subscribeFileSearchEvents((event) => {
    if (stopped || event.params.sessionId !== sessionId) return;
    if (event.method === "fuzzyFileSearch/sessionUpdated" && event.params.query !== latestQuery)
      return;
    input.onEvent(event);
  });
  const ensureStarted = (): Promise<void> => {
    if (start) return start;
    const request = invokeRendererControl("file-search:start", {
      sessionId,
      hostId: input.hostId,
      roots: [...input.roots],
    });
    start = request.catch((error: unknown) => {
      start = null;
      throw error;
    });
    return start;
  };
  return {
    update: async (query) => {
      if (stopped) return;
      latestQuery = query;
      if (!query) return;
      await ensureStarted();
      if (stopped || latestQuery !== query) return;
      await invokeRendererControl("file-search:update", { sessionId, query });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (!start) return;
      await start.catch(() => undefined);
      await invokeRendererControl("file-search:stop", { sessionId });
    },
  };
}
