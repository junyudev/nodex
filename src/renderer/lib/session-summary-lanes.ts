import { MAX_PROJECT_SESSION_SUMMARY_LANES } from "../../shared/schemas/session-order";
import type { ProjectSessionSummaryWindow, ProjectSessionSummaryWindowInput } from "./types";
import { invokeRendererQuery } from "./renderer-command";

interface PendingLane {
  readonly input: ProjectSessionSummaryWindowInput;
  readonly resolve: (window: ProjectSessionSummaryWindow) => void;
  readonly reject: (error: unknown) => void;
}

/** Lanes asked for in the current task, by scope; a renderer document reads one Space. */
const pendingByScope = new Map<string | null, PendingLane[]>();
let flushScheduled = false;

async function readLanes(projectId: string | null, lanes: readonly PendingLane[]): Promise<void> {
  try {
    const windows =
      lanes.length === 1
        ? [await invokeRendererQuery("workspace:tasks:list", projectId, lanes[0]!.input)]
        : await invokeRendererQuery(
            "workspace:tasks:lanes",
            projectId,
            lanes.map((lane) => lane.input),
          );
    if (windows.length !== lanes.length) throw new Error("Chat list lanes are incomplete");
    lanes.forEach((lane, index) => lane.resolve(windows[index]!));
  } catch (error) {
    for (const lane of lanes) lane.reject(error);
  }
}

function flush(): void {
  flushScheduled = false;
  const batches = [...pendingByScope];
  pendingByScope.clear();
  for (const [projectId, lanes] of batches) {
    for (let start = 0; start < lanes.length; start += MAX_PROJECT_SESSION_SUMMARY_LANES) {
      void readLanes(projectId, lanes.slice(start, start + MAX_PROJECT_SESSION_SUMMARY_LANES));
    }
  }
}

/**
 * Reads one lane of a scope's chat list. Lanes of the same scope asked for in the same task, such
 * as the chat catalog's and the sidebar's when a window first shows them, share one request and
 * one Core snapshot.
 */
export function readSessionSummaryLane(
  projectId: string | null,
  input: ProjectSessionSummaryWindowInput,
): Promise<ProjectSessionSummaryWindow> {
  return new Promise((resolve, reject) => {
    const lanes = pendingByScope.get(projectId);
    if (lanes) lanes.push({ input, resolve, reject });
    else pendingByScope.set(projectId, [{ input, resolve, reject }]);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  });
}
