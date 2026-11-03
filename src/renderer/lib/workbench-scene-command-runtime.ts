import { toast } from "../components/ui/toast";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import type {
  WorkbenchCommand,
  WorkbenchCommandReceipt,
} from "../../shared/nodex-app-tools/workbench-commands";
import { createWorkbenchSceneCommandLifecycle } from "./workbench-scene-command-lifecycle";
import { workbenchSceneCommandOpenerLifecycle } from "./workbench-scene-command-opener";
import {
  createWorkbenchSceneCommands,
  type WorkbenchSceneCommandExecutor,
  type WorkbenchSceneCommandOptions,
} from "./workbench-scene-commands";
import { createWorkbenchSceneSurfacePresenter } from "./workbench-scene-surface-presenter";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { WorkbenchPanelTabOpenerStore } from "./workbench-panel-tab-opener-state";

export type ExecuteWorkbenchUiCommand = (
  sceneOwner: WorkbenchSceneOwner,
  command: WorkbenchCommand,
  options?: WorkbenchSceneCommandOptions,
) => Promise<WorkbenchCommandReceipt>;

type LifecycleHandlers = Pick<
  Parameters<typeof createWorkbenchSceneCommandLifecycle>[0],
  "discardSideChat" | "confirmSideChatClose"
>;
type ActivationInput = {
  readonly owner: WorkbenchWindowOwner;
  readonly windowSessionId: string;
  readonly tabOpenerStore: WorkbenchPanelTabOpenerStore;
};
type Presenter = ReturnType<typeof createWorkbenchSceneSurfacePresenter>;

/** A committed window activation owns the executor and every in-flight generation lease. */
export function createWorkbenchSceneCommandRuntime() {
  let handlers: LifecycleHandlers | null = null;
  let active: {
    readonly owner: WorkbenchWindowOwner;
    readonly executor: WorkbenchSceneCommandExecutor;
    readonly present: Presenter;
    readonly lease: { active: boolean; handlers: LifecycleHandlers };
  } | null = null;

  // This Interface is stable across commits; only activation may construct a lifecycle.
  const executor: WorkbenchSceneCommandExecutor = {
    execute: (input, isCurrent, options) => {
      const generation = active;
      if (!generation)
        return Promise.resolve({
          operationId: input.operationId,
          sceneOwner: input.sceneOwner,
          applied: false,
          persisted: false,
          presentationRevision: input.expectedPresentationRevision,
          layoutRevision: null,
          tabId: null,
          groupId: null,
          error: "revoked_generation",
        });
      return generation.executor.execute(
        input,
        () => generation.lease.active && (isCurrent?.() ?? true),
        options,
      );
    },
  };
  const execute: ExecuteWorkbenchUiCommand = async (sceneOwner, command, options) => {
    const generation = active;
    const receipt = await executor.execute(
      {
        operationId: createSecureRuntimeId("ui-operation"),
        sceneOwner,
        expectedPresentationRevision: generation?.owner.read().presentationRevision ?? 0,
        command,
      },
      undefined,
      options,
    );
    if (!generation?.lease.active) return receipt;
    if (receipt.error === "save_failed")
      toast.danger("Save pending changes before closing this tab");
    else if (receipt.error === "stale_presentation")
      toast.danger("The panel changed while this action was preparing. Try again.");
    else if (receipt.error === "persistence_failed")
      toast.danger("The panel changed, but its layout could not be saved");
    else if (receipt.error) toast.danger("This panel action is unavailable");
    return receipt;
  };
  const present: Presenter = (input, surface) => {
    if (!active)
      return Promise.resolve({ status: "unavailable", reason: "This window is unavailable" });
    return active.present(input, surface);
  };

  return {
    executor,
    execute,
    present,
    updateHandlers: (next: LifecycleHandlers) => {
      handlers = next;
      if (active) active.lease.handlers = next;
    },
    activate: ({ owner, windowSessionId, tabOpenerStore }: ActivationInput) => {
      if (!handlers) throw new Error("Scene command handlers must be committed before activation");
      if (active) throw new Error("Scene command runtime already has an active window");
      const lease = { active: true, handlers };
      const commands = createWorkbenchSceneCommands(owner, {
        ...createWorkbenchSceneCommandLifecycle({
          owner,
          windowSessionId,
          discardSideChat: (threadId) => lease.handlers.discardSideChat(threadId),
          confirmSideChatClose: (tab) =>
            lease.handlers.confirmSideChatClose?.(tab) ?? Promise.resolve(true),
        }),
        ...workbenchSceneCommandOpenerLifecycle(tabOpenerStore),
      });
      const generation = {
        owner,
        lease,
        executor: commands,
        present: createWorkbenchSceneSurfacePresenter(owner, commands, () => () => lease.active),
      };
      active = generation;
      return () => {
        lease.active = false;
        if (active === generation) active = null;
      };
    },
  };
}
