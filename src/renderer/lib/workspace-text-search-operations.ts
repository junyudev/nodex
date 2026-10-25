import type {
  WorkspaceTextSearchEvent,
  WorkspaceTextSearchRequest,
} from "../../shared/workspace-text-search";
import { invokeRendererControl } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

export interface WorkspaceTextSearchController {
  readonly stop: () => Promise<void>;
}

/** One query owns one streamed request; disposal also fences events racing with Main. */
export function createWorkspaceTextSearch(
  input: Omit<WorkspaceTextSearchRequest, "requestId"> & {
    readonly onEvent: (event: WorkspaceTextSearchEvent) => void;
  },
): WorkspaceTextSearchController {
  const { onEvent, ...request } = input;
  const requestId = crypto.randomUUID();
  let active = true;
  let completed = false;
  let unsubscribe = () => {};
  const release = () => {
    const cleanup = unsubscribe;
    unsubscribe = () => {};
    cleanup();
  };
  unsubscribe = resolveRendererTransport().subscribeWorkspaceTextSearchEvents((event) => {
    if (!active || completed || event.requestId !== requestId) return;
    if (event.type !== "match") {
      completed = true;
      release();
    }
    onEvent(event);
  });
  const started = invokeRendererControl("workspace-text-search:start", { ...request, requestId })
    .then(() => true)
    .catch((error: unknown) => {
      if (active && !completed) {
        completed = true;
        release();
        onEvent({
          requestId,
          type: "error",
          code: "search-failed",
          message: error instanceof Error ? error.message : "Unable to search files",
        });
      }
      return false;
    });
  return {
    stop: async () => {
      if (!active) return;
      active = false;
      release();
      if (!(await started) || completed) return;
      await invokeRendererControl("workspace-text-search:stop", { requestId });
    },
  };
}
