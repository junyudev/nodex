import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";
import {
  codexSidebarProjectThreadContainerId,
  isCodexSidebarThreadContainerId,
  readCodexSidebarThreadContainerLocation,
} from "../../../shared/codex-sidebar-thread-move";
import { readSidebarSectionContainerId } from "../../../shared/sidebar-sections";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import {
  listAllSidebarSectionItems,
  readSidebarPinnedSessionOrder,
} from "@/lib/sidebar-sections-api";
import type { ProjectSession, ProjectSessionPlacement } from "@/lib/types";
import type { WorkbenchSessionCatalog } from "@/lib/use-workbench-session-catalog";
import {
  workspaceSessionCommands,
  workspaceSidebarCommands,
} from "@/lib/workspace-catalog-commands";
import { resolveSidebarSectionItemPlacement } from "./sidebar-section-item-dnd";
import type { SidebarThreadDropCommit, SidebarThreadDropRequest } from "./sidebar-thread-reorder";

export async function resolveSidebarDropSession(
  drop: SidebarThreadDropRequest,
  knownSessions: readonly ProjectSession[],
  catalog: Pick<WorkbenchSessionCatalog, "readCurrent" | "ensureThreadSession">,
): Promise<ProjectSession | null> {
  const sessionId =
    drop.sessionId ??
    knownSessions.find(
      (candidate) =>
        candidate.thread?.threadId === drop.threadId ||
        candidate.executionRef?.threadId === drop.threadId,
    )?.id;
  if (sessionId) return await catalog.readCurrent(sessionId);
  if (drop.threadId === null) return null;
  return await catalog.ensureThreadSession(drop.threadId);
}

async function pinSidebarSessionAtBoundary(
  sessionId: string,
  beforeSessionId: string | null | undefined,
): Promise<void> {
  await workspaceSessionCommands.setPinned(sessionId, { pinned: true });
  if (beforeSessionId === undefined || beforeSessionId === null) return;
  const order = await readSidebarPinnedSessionOrder();
  const remaining = order.sessionIds.filter((id) => id !== sessionId);
  const beforeIndex = remaining.indexOf(beforeSessionId);
  if (beforeIndex < 0) throw new Error("Pinned chat position changed. Try the move again.");
  await workspaceSessionCommands.reorderPinned(order.orderRevision, [
    ...remaining.slice(0, beforeIndex),
    sessionId,
    ...remaining.slice(beforeIndex),
  ]);
}

/**
 * The chat a lane drop lands beside. Only lanes that keep a manual arrangement send an anchor;
 * a drop that follows the destination's own order has none.
 */
export function resolveSidebarLaneDropPlacement(
  drop: Pick<SidebarThreadDropRequest, "beforeItemId" | "targetItemIds" | "useDefaultOrder">,
  sessionId: string,
): ProjectSessionPlacement | null {
  if (drop.useDefaultOrder || drop.beforeItemId === undefined || !drop.targetItemIds) return null;
  const remaining = drop.targetItemIds.filter((id) => id !== sessionId);
  if (drop.beforeItemId !== null) {
    return remaining.includes(drop.beforeItemId)
      ? { kind: "before", sessionId: drop.beforeItemId }
      : null;
  }
  const last = remaining.at(-1);
  return last === undefined ? null : { kind: "after", sessionId: last };
}

/**
 * Moves a chat by its durable Session, whichever Agent runs it: the execution owner changes its
 * Project, then the Session leaves its Section and takes its pin or lane position.
 */
export async function moveSidebarSession({
  drop,
  session,
  moveNativeThread,
}: {
  readonly drop: SidebarThreadDropRequest;
  readonly session: ProjectSession;
  readonly moveNativeThread: (
    drop: SidebarThreadDropRequest,
  ) => Promise<SidebarThreadDropCommit | null>;
}): Promise<void> {
  const targetSectionId = readSidebarSectionContainerId(drop.targetContainerId);
  if (targetSectionId !== null) {
    const items = await listAllSidebarSectionItems(targetSectionId);
    await workspaceSidebarCommands.moveItem({
      item: { kind: "session", sessionId: session.id },
      sectionId: targetSectionId,
      placement: resolveSidebarSectionItemPlacement(items, drop.beforeItemId),
    });
    return;
  }

  if (!isCodexSidebarThreadContainerId(drop.targetContainerId)) {
    throw new Error("Invalid sidebar chat destination");
  }
  const target = readCodexSidebarThreadContainerLocation(drop.targetContainerId);
  if (target === null) throw new Error("Unsupported sidebar chat destination");

  const nativeThread = !session.executionRef && session.thread;
  if (nativeThread && isCodexAgentBackendBinding(nativeThread.backendBinding)) {
    const sourceContainerId =
      session.projectId === null
        ? session.pinned
          ? "pinned"
          : "chats"
        : codexSidebarProjectThreadContainerId(session.projectId, session.pinned);
    // Anchors may be drafts or chats on other Agents, which have no native Thread record.
    // The execution owner moves membership; the Session owner places the row below.
    const committed = await moveNativeThread({
      ...drop,
      beforeThreadId: null,
      afterThreadId: undefined,
      insertAtEnd: undefined,
      useDefaultOrder: true,
      sessionId: session.id,
      threadId: nativeThread.threadId,
      sourceContainerId,
    });
    if (committed === null) throw new Error("Couldn’t move chat");
  } else {
    if (session.projectId !== target.projectId) {
      await agentRuntimeRuntime.moveSession({
        operationId: `session-move:${createUuidV7()}`,
        sessionId: session.id,
        projectId: target.projectId,
      });
    }
    if (session.pinned && !target.pinned) {
      await workspaceSessionCommands.setPinned(session.id, { pinned: false });
    }
  }

  // The root Pinned lane owns projectless chats; Project pin lanes keep their Project.
  // Pinning clears direct Section placement.
  if (target.pinned) {
    await pinSidebarSessionAtBoundary(session.id, drop.beforeItemId);
    return;
  }
  // Keep the Section placement until the execution owner's Project move succeeds.
  if (readSidebarSectionContainerId(drop.sourceContainerId) !== null) {
    await workspaceSidebarCommands.moveItem({
      item: { kind: "session", sessionId: session.id },
      sectionId: null,
      placement: { kind: "end" },
    });
  }
  const placement = resolveSidebarLaneDropPlacement(drop, session.id);
  if (placement) await workspaceSessionCommands.place(session.id, placement);
}
