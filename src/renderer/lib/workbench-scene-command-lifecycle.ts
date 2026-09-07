import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
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

const closeBrowserTab = defineRendererCommand({
  key: "workbench.close_browser_tab",
  channel: "browser-sidebar-command",
  authority: "main",
  owner: "WorkbenchSceneCommands",
  protocol: { kind: "returned_value" },
});

const presentationOwnerId = (sceneOwner: WorkbenchSceneOwner) =>
  sceneOwner.kind === "session" ? sceneOwner.sessionId : makeWorkbenchSceneKey(sceneOwner);

/** Narrow lifecycle Adapter shared by UI and Agent presentation commands. */
export function createWorkbenchSceneCommandLifecycle(input: {
  readonly owner: WorkbenchWindowOwner;
  readonly windowSessionId: string;
  readonly discardSideChat: (threadId: string) => Promise<unknown>;
}): WorkbenchSceneCommandLifecycle {
  return {
    async prepareClose(sceneOwner, tab) {
      const surface = tab.surface;
      if (!surface) return true;
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
      if (tab.auxiliary && "sideChat" in tab.auxiliary && tab.auxiliary.threadId)
        await input.discardSideChat(tab.auxiliary.threadId);
    },
  };
}
