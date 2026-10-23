import type { ThreadExecutionLocationView } from "../../shared/codex-thread-handoff";
import type { CodexSidebarThreadItem } from "../../shared/types";
import type { SessionLiveIndicator } from "./session-execution";
import { resolveSidebarRowStatus, type SidebarRowStatus } from "./sidebar-status";

export interface SidebarThreadRowRuntimeFacts {
  readonly indicator: SessionLiveIndicator | null;
  readonly location: ThreadExecutionLocationView | null;
}

export interface SidebarThreadRowLiveView {
  /** The row item with its execution owner's location applied. */
  readonly item: CodexSidebarThreadItem;
  readonly running: boolean;
  /** No foreground Run, but delegated or background work is live or will resume the chat. */
  readonly background: boolean;
  readonly needsAttention: boolean;
  /** The single trailing status the row shows. */
  readonly status: SidebarRowStatus | null;
}

function withStatus(view: Omit<SidebarThreadRowLiveView, "status">): SidebarThreadRowLiveView {
  return { ...view, status: resolveSidebarRowStatus({ ...view, unread: view.item.unread }) };
}

/**
 * Native rows keep their Core thread status. Runtime rows read live status from Session activity
 * (idle is absent) and their location from the execution owner, never from a native thread.
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
      needsAttention: item.needsAttention === true,
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
    running: runtime.indicator === "running",
    background: runtime.indicator === "background",
    needsAttention: item.needsAttention === true || runtime.indicator === "waiting",
  });
}
