import type { WorkbenchSceneOwner, WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { workspaceTextDocumentRegistry } from "../features/workspace-files/workspace-text-document-controller";
import {
  canvasSceneSurfaceRegistry,
  makeCanvasSceneSurfaceKey,
} from "./canvas-scene-surface-runtime";
import { documentSessionRegistry } from "./document-session-registry";
import { workbenchPageEditorKey } from "./workbench-page-editor-key";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { terminalSessionStore } from "./terminal-session-store";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import type { WorkbenchSceneCommandLifecycle } from "./workbench-scene-commands";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { SideChatPanelTab } from "./workbench-panel-tab-model";

const closeBrowserTab = defineRendererCommand({
  key: "workbench.close_browser_tab",
  channel: "browser-sidebar-command",
  authority: "main",
  owner: "WorkbenchSceneCommands",
  protocol: { kind: "returned_value" },
});

const presentationOwnerId = (sceneOwner: WorkbenchSceneOwner) =>
  sceneOwner.kind === "session" ? sceneOwner.sessionId : makeWorkbenchSceneKey(sceneOwner);

/** Prepare a Scene preview replacement through the same content owners as durable closing. */
export async function prepareWorkbenchSceneSurfaceClose(
  sceneOwner: WorkbenchSceneOwner,
  surface: WorkbenchSurfaceDescriptor,
): Promise<boolean> {
  if (surface.kind === "files") return workspaceTextDocumentRegistry.flush(surface.id);
  if (surface.kind === "page_stage") {
    const lease = documentSessionRegistry.get(workbenchPageEditorKey(sceneOwner, surface.id));
    if (!lease) return true;
    try {
      const result = await lease.runtime.persist();
      return result.flush === "completed" && result.checkpoint === "completed";
    } catch {
      return false;
    }
  }
  if (surface.kind !== "canvas_stage") return true;
  try {
    await canvasSceneSurfaceRegistry.flushOwnerCommitted(surface.config.canvasBlockId);
    return true;
  } catch {
    return false;
  }
}

/** Narrow lifecycle Adapter shared by UI and Agent presentation commands. */
export function createWorkbenchSceneCommandLifecycle(input: {
  readonly owner: WorkbenchWindowOwner;
  readonly windowSessionId: string;
  readonly discardSideChat: (threadId: string) => Promise<unknown>;
  readonly confirmSideChatClose?: (tab: SideChatPanelTab) => Promise<boolean>;
}): WorkbenchSceneCommandLifecycle {
  return {
    async prepareClose(sceneOwner, tab) {
      const sideChat = tab.auxiliary && "sideChat" in tab.auxiliary ? tab.auxiliary : null;
      if (
        sideChat?.threadId &&
        input.confirmSideChatClose &&
        !(await input.confirmSideChatClose(sideChat))
      )
        return "cancelled";
      return tab.surface ? prepareWorkbenchSceneSurfaceClose(sceneOwner, tab.surface) : true;
    },
    async close(sceneOwner, tab) {
      const surface = tab.surface;
      if (surface?.kind === "terminal")
        terminalSessionStore.release(surface.config.terminalSessionId);
      if (surface?.kind === "page_stage")
        await documentSessionRegistry.dispose(workbenchPageEditorKey(sceneOwner, surface.id));
      if (surface?.kind === "canvas_stage")
        await canvasSceneSurfaceRegistry.dispose(
          makeCanvasSceneSurfaceKey(
            input.windowSessionId,
            presentationOwnerId(sceneOwner),
            surface.id,
          ),
        );
      if (surface?.kind === "browser") {
        const retained = readWorkbenchAgentContext(input.owner.read(), sceneOwner)?.tabs.some(
          (candidate) =>
            candidate.surface?.kind === "browser" &&
            candidate.surface.config.browserTabId === surface.config.browserTabId,
        );
        if (retained) return;
        await invokePlainCommand(closeBrowserTab, {
          type: "close-tab",
          browserConversationId: presentationOwnerId(sceneOwner),
          browserViewScopeId: input.windowSessionId,
          browserTabId: surface.config.browserTabId,
        });
      }
      const sideChat = tab.auxiliary && "sideChat" in tab.auxiliary ? tab.auxiliary : null;
      if (sideChat?.runtimeSession) {
        await agentRuntimeRuntime.discardSideChat({
          sessionId: sideChat.runtimeSession.id,
          requestId: createUuidV7(),
        });
        return;
      }
      if (sideChat?.threadId) await input.discardSideChat(sideChat.threadId);
    },
  };
}
