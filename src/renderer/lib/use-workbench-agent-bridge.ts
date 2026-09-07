import { useEffect, useRef } from "react";
import {
  createElectronWorkbenchAgentBridgePort,
  createWorkbenchAgentBridge,
} from "./workbench-agent-bridge";
import type { WorkbenchAgentContextOptions } from "./workbench-agent-context";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { WorkbenchSceneCommandExecutor } from "./workbench-scene-commands";

/** WorkbenchRuntime owns the registration lifetime; unrelated renders keep its generation stable. */
export function useWorkbenchAgentBridge(
  owner: WorkbenchWindowOwner,
  context: WorkbenchAgentContextOptions = {},
  commands?: WorkbenchSceneCommandExecutor,
) {
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    if (!window.api) return;
    const capability = createWorkbenchAgentBridge(
      owner,
      createElectronWorkbenchAgentBridgePort(window.api),
      {
        commands,
        context: () => contextRef.current,
        onError: (error) => console.error("Workbench Agent bridge failed", error),
      },
    );
    return capability.dispose;
  }, [owner, commands]);
}
