import type { ComposerFileSearchEvent } from "../../../shared/composer-file-search";
import { invokeRendererControl } from "@/lib/renderer-command";
import { resolveRendererTransport } from "@/lib/renderer-transport";

export interface ComposerFileSearchController {
  readonly update: (query: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** One lazy native session per mounted search scope; edits reuse the index and closing stops it. */
export function createComposerFileSearchSession(input: {
  readonly roots: readonly string[];
  readonly onEvent: (event: ComposerFileSearchEvent) => void;
}): ComposerFileSearchController {
  const sessionId = crypto.randomUUID();
  let start: Promise<void> | null = null;
  let stopped = false;
  let latestQuery = "";
  const unsubscribe = resolveRendererTransport().subscribeComposerFileSearchEvents((event) => {
    if (stopped || event.params.sessionId !== sessionId) return;
    if (event.method === "fuzzyFileSearch/sessionUpdated" && event.params.query !== latestQuery)
      return;
    input.onEvent(event);
  });
  const ensureStarted = (): Promise<void> => {
    if (start) return start;
    const request = invokeRendererControl("codex:composer-file-search:start", {
      sessionId,
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
      if (!query && !start) return;
      await ensureStarted();
      if (stopped || latestQuery !== query) return;
      await invokeRendererControl("codex:composer-file-search:update", { sessionId, query });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (!start) return;
      await start.catch(() => undefined);
      await invokeRendererControl("codex:composer-file-search:stop", { sessionId });
    },
  };
}
