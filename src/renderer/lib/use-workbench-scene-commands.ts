import { useLayoutEffect, useState } from "react";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { WorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";
import { useSideChatCloseConfirmation } from "./use-side-chat-close-confirmation";
import { createWorkbenchSceneCommandRuntime } from "./workbench-scene-command-runtime";

export type { ExecuteWorkbenchUiCommand } from "./workbench-scene-command-runtime";

export function useWorkbenchSceneCommands(
  owner: WorkbenchWindowOwner,
  windowSessionId: string,
  discardSideChat: (threadId: string) => Promise<unknown>,
  tabOpenerStore: WorkbenchPanelTabOpenerStore,
) {
  const confirmSideChatClose = useSideChatCloseConfirmation();
  const [runtime] = useState(createWorkbenchSceneCommandRuntime);
  useLayoutEffect(() => {
    runtime.updateHandlers({ discardSideChat, confirmSideChatClose });
  }, [runtime, discardSideChat, confirmSideChatClose]);
  useLayoutEffect(
    () => runtime.activate({ owner, windowSessionId, tabOpenerStore }),
    [runtime, owner, windowSessionId, tabOpenerStore],
  );
  return runtime;
}
