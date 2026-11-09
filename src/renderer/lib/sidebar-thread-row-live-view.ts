import type { ThreadExecutionLocationView } from "../../shared/codex-thread-handoff";
import type { CodexSidebarThreadItem } from "../../shared/types";
import type { SessionLiveIndicator } from "./session-execution";
import {
  nativeThreadWaitsOnPerson,
  resolveSidebarRowStatus,
  type SidebarRowLiveStatus,
} from "./sidebar-status";

export interface SidebarThreadRowRuntimeFacts {
  readonly indicator: SessionLiveIndicator | null;
  readonly location: ThreadExecutionLocationView | null;
  /** The active Run's opening statement, once the agent has made one. */
  readonly readback?: string | null;
}

export interface SidebarThreadRowLiveView {
  /** The row item with its execution owner's location applied. */
  readonly item: CodexSidebarThreadItem;
  readonly running: boolean;
  /** No foreground Run, but delegated or background work is live or will resume the chat. */
  readonly background: boolean;
  readonly needsAttention: boolean;
  readonly needsApproval?: boolean;
  /** The live status the row shows; with none, the row may rest on a resting status. */
  readonly status: SidebarRowLiveStatus | null;
  /** What the agent said it would do in the Run it is working on. */
  readonly readback: string | null;
}

function withStatus(
  view: Omit<SidebarThreadRowLiveView, "status" | "readback"> & {
    readonly readback?: string | null;
  },
): SidebarThreadRowLiveView {
  return {
    ...view,
    readback: view.readback ?? null,
    status: resolveSidebarRowStatus({ ...view, unread: view.item.unread }),
  };
}

/**
 * Native rows keep their Core thread status, waiting while it asks for approval or input. Runtime
 * rows read live status from Session activity (idle is absent) and their location from the
 * execution owner, never from a native thread.
 */
export function projectSidebarThreadRowLiveView(
  item: CodexSidebarThreadItem,
  runtime: SidebarThreadRowRuntimeFacts | null,
): SidebarThreadRowLiveView {
  if (!runtime)
    return withStatus({
      item,
      running: item.statusType === "active",
      background: false,
      ...(item.statusActiveFlags?.includes("waitingOnApproval") ? { needsApproval: true } : {}),
      needsAttention:
        item.needsAttention === true || nativeThreadWaitsOnPerson(item.statusActiveFlags),
    });
  const located = runtime.location
    ? {
        ...item,
        cwd: runtime.location.cwd,
        runLocation: runtime.location.managedWorktreePath
          ? ({
              kind: "local-worktree",
              path: runtime.location.managedWorktreePath,
              phase: "ready",
            } as const)
          : ({ kind: "local-checkout" } as const),
      }
    : item;
  return withStatus({
    item: located,
    readback: runtime.readback,
    running: runtime.indicator === "running",
    background: runtime.indicator === "background",
    ...(runtime.indicator === "approval" ? { needsApproval: true } : {}),
    needsAttention:
      item.needsAttention === true ||
      runtime.indicator === "waiting" ||
      runtime.indicator === "approval",
  });
}
