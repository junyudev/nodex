import type { FileSearchEvent, FileSearchScope } from "../../shared/file-search";
import { invokeRendererControl } from "@/lib/renderer-command";
import { resolveRendererTransport } from "@/lib/renderer-transport";

export interface FileSearchController {
  readonly update: (query: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** One lazy session per mounted search scope; query edits reuse it and closing stops it. */
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
    if ("query" in event.params && event.params.query !== latestQuery) return;
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
      if (!query && (!start || input.hostId !== "local")) return;
      for (let attempt = 0; ; attempt++) {
        await ensureStarted();
        if (stopped || latestQuery !== query) return;
        try {
          await invokeRendererControl("file-search:update", { sessionId, query });
          return;
        } catch (error) {
          if (stopped || latestQuery !== query) return;
          if (attempt > 0) throw error;
          // Main may have released this session; starting it again under the same id recovers.
          start = null;
        }
      }
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
