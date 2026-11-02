import "./workbench-testkit/workbench-shell-harness";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import type { BrowserSidebarOpenNewTabRequest } from "../../../shared/browser-sidebar";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../../shared/workbench-scene";
import { settleAsyncRender } from "../../test/dom";
import {
  getPanelTabById,
  invokeCalls,
  renderWorkbench,
} from "./workbench-testkit/workbench-shell-harness";
import { makeAttachedSession, makeSessionTab } from "./workbench-testkit/workbench-shell-fixtures";

async function fixture(kind: "project" | "session") {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  window.api = {
    ...window.api!,
    on: (channel, listener) => {
      const callbacks = listeners.get(channel) ?? new Set();
      callbacks.add(listener);
      listeners.set(channel, callbacks);
      return () => {
        callbacks.delete(listener);
      };
    },
  };
  const sessionId = "session:browser-requests";
  const owner =
    kind === "session" ? ({ kind, sessionId } as const) : ({ kind, projectId: "alpha" } as const);
  let scene = materializeInitialWorkbenchScene(owner);
  const tabs = ["before", "opener", "after"].map((id, order) =>
    makeSessionTab({
      id,
      order,
      sessionId,
      kind: "browser",
      browserTabId: `${id}:runtime`,
      title: id,
      config: { projectId: "alpha", url: `https://${id}.example/` },
    }),
  );
  for (const tab of tabs) {
    scene = createWorkbenchSceneSurface(scene, {
      panelId: "right",
      surface: {
        id: tab.id,
        kind: "browser",
        titleSnapshot: tab.title,
        state: null,
        stateKey: 0,
        config: { browserTabId: `${tab.id}:runtime`, url: `https://${tab.id}.example/` },
      },
    });
  }
  scene = activateWorkbenchSceneSurface(
    scene,
    "right",
    scene.panels.right.layout.activeLeafId,
    "opener",
  );
  const session = makeAttachedSession({
    id: sessionId,
    tabs,
    rightLayout: scene.panels.right.layout,
  });
  const view = renderWorkbench({
    sessionsByProject: { alpha: kind === "session" ? [session] : [] },
    initialSelectedSessionId: kind === "session" ? sessionId : null,
    initialWindowLayoutSnapshot: {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location:
        kind === "session"
          ? { kind, sessionId, projectContextId: "alpha" }
          : { kind, projectId: "alpha" },
      scenesByOwnerKey: { [makeWorkbenchSceneKey(owner)]: scene },
    },
  });
  await settleAsyncRender();
  await settleAsyncRender();
  const emit = async (extra: Partial<BrowserSidebarOpenNewTabRequest> = {}) => {
    await act(async () => {
      for (const listener of listeners.get("browser-sidebar-open-new-tab") ?? []) {
        listener({
          browserConversationId: kind === "session" ? sessionId : makeWorkbenchSceneKey(owner),
          browserViewScopeId: "window-session:test",
          browserTabId: "opener:runtime",
          url: "https://popup.example/",
          background: false,
          ...extra,
        } satisfies BrowserSidebarOpenNewTabRequest);
      }
      await Promise.resolve();
    });
    await settleAsyncRender();
  };
  return { view, emit };
}

describe("Workbench Browser requests", () => {
  for (const kind of ["project", "session"] as const) {
    test.each([false, true])(
      `${kind} popups appear beside their opener (background: %s)`,
      async (background) => {
        const { view, emit } = await fixture(kind);
        const opener = getPanelTabById(view.container, "opener");
        await act(async () => {
          opener.focus();
          await Promise.resolve();
        });
        const focused = document.activeElement;
        const existingIds = new Set(
          [...view.container.querySelectorAll<HTMLElement>("[data-panel-tab-id]")].map(
            (tab) => tab.dataset.panelTabId,
          ),
        );
        await emit({ background });
        const popup = await waitFor(() => {
          const shell = [
            ...view.container.querySelectorAll<HTMLElement>("[data-panel-tab-id]"),
          ].find((tab) => !existingIds.has(tab.dataset.panelTabId));
          if (!shell?.dataset.panelTabId) throw new Error("Expected a new Browser tab");
          return getPanelTabById(view.container, shell.dataset.panelTabId);
        });
        const popupId = popup.closest<HTMLElement>("[data-panel-tab-id]")!.dataset.panelTabId!;
        const order = [...view.container.querySelectorAll<HTMLElement>("[data-panel-tab-id]")]
          .map((tab) => tab.dataset.panelTabId)
          .filter((id) => id === "before" || id === "opener" || id === "after" || id === popupId);
        expect(order).toEqual(["before", "opener", popupId, "after"]);
        expect(popup.getAttribute("aria-selected")).toBe(String(!background));
        expect(getPanelTabById(view.container, "opener").getAttribute("aria-selected")).toBe(
          String(background),
        );
        if (background) expect(document.activeElement).toBe(focused);
      },
    );

    test(`${kind} context-menu window requests use the detached Browser workflow`, async () => {
      const { view, emit } = await fixture(kind);
      const before = view.getAllByRole("tab").length;
      await emit({ openInNewWindow: true });
      await waitFor(() => {
        expect(invokeCalls.filter((call) => call[0] === "window:new")).toEqual([
          ["window:new", { browserUrl: "https://popup.example/" }],
        ]);
      });
      expect(view.getAllByRole("tab")).toHaveLength(before);
      expect(getPanelTabById(view.container, "opener").getAttribute("aria-selected")).toBe("true");
    });
  }
});
