import { useEffect, useMemo, useRef } from "react";
import { toast } from "../components/ui/toast";
import type {
  WorkbenchCommand,
  WorkbenchCommandReceipt,
} from "../../shared/nodex-app-tools/workbench-commands";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import { createWorkbenchSceneCommandLifecycle } from "./workbench-scene-command-lifecycle";
import {
  createWorkbenchSceneCommands,
  type WorkbenchSceneCommandOptions,
} from "./workbench-scene-commands";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { WorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";
import { workbenchSceneCommandOpenerLifecycle } from "./workbench-scene-command-opener";
import { createWorkbenchSceneSurfacePresenter } from "./workbench-scene-surface-presenter";

export type ExecuteWorkbenchUiCommand = (
  sceneOwner: WorkbenchSceneOwner,
  command: WorkbenchCommand,
  options?: WorkbenchSceneCommandOptions,
) => Promise<WorkbenchCommandReceipt>;

export function useWorkbenchSceneCommands(
  owner: WorkbenchWindowOwner,
  windowSessionId: string,
  discardSideChat: (threadId: string) => Promise<unknown>,
  tabOpenerStore: WorkbenchPanelTabOpenerStore,
) {
  const discardRef = useRef(discardSideChat);
  discardRef.current = discardSideChat;
  const generationRef = useRef({ active: true });
  useEffect(() => {
    const generation = { active: true };
    generationRef.current = generation;
    return () => {
      generation.active = false;
    };
  }, [owner, windowSessionId]);
  const executor = useMemo(
    () =>
      createWorkbenchSceneCommands(owner, {
        ...createWorkbenchSceneCommandLifecycle({
          owner,
          windowSessionId,
          discardSideChat: (threadId) => discardRef.current(threadId),
        }),
        ...workbenchSceneCommandOpenerLifecycle(tabOpenerStore),
      }),
    [owner, windowSessionId, tabOpenerStore],
  );
  const execute = useMemo<ExecuteWorkbenchUiCommand>(
    () => async (sceneOwner, command, options) => {
      const generation = generationRef.current;
      const receipt = await executor.execute(
        {
          operationId: createSecureRuntimeId("ui-operation"),
          sceneOwner,
          expectedPresentationRevision: owner.read().presentationRevision,
          command,
        },
        () => generation.active,
        options,
      );
      if (!generation.active) return receipt;
      if (receipt.error === "save_failed")
        toast.danger("Save pending changes before closing this tab");
      else if (receipt.error === "stale_presentation")
        toast.danger("The panel changed while this action was preparing. Try again.");
      else if (receipt.error === "persistence_failed")
        toast.danger("The panel changed, but its layout could not be saved");
      else if (receipt.error) toast.danger("This panel action is unavailable");
      return receipt;
    },
    [executor, owner],
  );
  const present = useMemo(
    () =>
      createWorkbenchSceneSurfacePresenter(owner, executor, () => {
        const generation = generationRef.current;
        return () => generation.active;
      }),
    [owner, executor],
  );
  return { executor, execute, present };
}
