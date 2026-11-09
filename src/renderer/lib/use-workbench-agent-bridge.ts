import { isRemoteSpace } from "./renderer-space";
import { useEffectEvent, useEffect } from "react";
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
  const readContext = useEffectEvent(() => context);
  useEffect(() => {
    if (isRemoteSpace() || !window.api) return;
    const capability = createWorkbenchAgentBridge(
      owner,
      createElectronWorkbenchAgentBridgePort(window.api),
      {
        commands,
        context: () => readContext(),
        onError: (error) => console.error("Workbench Agent bridge failed", error),
      },
    );
    return capability.dispose;
  }, [owner, commands]);
}
