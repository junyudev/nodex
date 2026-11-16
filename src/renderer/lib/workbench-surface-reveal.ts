import { useSyncExternalStore } from "react";
import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";
import type { ChatSearchReveal } from "./chat-search-reveal";
import type { PageSearchReveal } from "./page-search-reveal";
import { useWorkbenchWindowOwner } from "./use-workbench-window-state";

export type WorkbenchLocalSurfaceReveal = PageSearchReveal | ChatSearchReveal;

export interface WorkbenchPendingSurfaceReveal {
  readonly operationId: string;
  readonly sceneKey: string;
  readonly surfaceId: string;
  readonly target: WorkbenchLocalSurfaceReveal;
}

interface WorkbenchSurfaceSearchRequest<T extends WorkbenchLocalSurfaceReveal> {
  readonly operationId: string;
  readonly target: T;
  readonly consume: () => void;
}

export type WorkbenchPageSearchRequest = WorkbenchSurfaceSearchRequest<PageSearchReveal>;
export type WorkbenchChatSearchRequest = WorkbenchSurfaceSearchRequest<ChatSearchReveal>;

function useWorkbenchSurfaceSearchReveal<K extends WorkbenchLocalSurfaceReveal["kind"]>(
  sceneOwner: WorkbenchSceneOwner | undefined,
  surfaceId: string,
  kind: K,
): WorkbenchSurfaceSearchRequest<Extract<WorkbenchLocalSurfaceReveal, { kind: K }>> | undefined {
  const owner = useWorkbenchWindowOwner();
  const sceneKey = sceneOwner && makeWorkbenchSceneKey(sceneOwner);
  const pending = useSyncExternalStore(owner.subscribe, () => {
    const reveal = owner.read().ephemeralPanels.pendingSurfaceReveal;
    return reveal?.sceneKey === sceneKey && reveal?.surfaceId === surfaceId ? reveal : null;
  });
  if (pending?.target.kind !== kind) return undefined;

  return {
    operationId: pending.operationId,
    target: pending.target as Extract<WorkbenchLocalSurfaceReveal, { kind: K }>,
    consume: () =>
      owner.dispatchEphemeral({
        type: "update",
        field: "pendingSurfaceReveal",
        update: (current) => (current?.operationId === pending.operationId ? null : current),
      }),
  };
}

export function useWorkbenchPageSearchReveal(
  sceneOwner: WorkbenchSceneOwner | undefined,
  surfaceId: string,
): WorkbenchPageSearchRequest | undefined {
  return useWorkbenchSurfaceSearchReveal(sceneOwner, surfaceId, "page-search");
}

export function useWorkbenchChatSearchReveal(
  sessionId: string | null,
): WorkbenchChatSearchRequest | undefined {
  return useWorkbenchSurfaceSearchReveal(
    sessionId ? { kind: "session", sessionId } : undefined,
    sessionId ?? "",
    "chat-search",
  );
}
