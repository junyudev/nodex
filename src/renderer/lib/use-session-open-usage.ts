import { useLayoutEffect } from "react";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import { workspaceSessionCommands } from "./workspace-catalog-commands";

export function useSessionOpenUsage(owner: WorkbenchWindowOwner) {
  useLayoutEffect(
    () =>
      owner.registerSessionOpened((sessionId) => {
        void workspaceSessionCommands.recordOpened(sessionId).catch((error: unknown) => {
          console.error("Failed to record Session opening", error);
        });
      }),
    [owner],
  );
}
