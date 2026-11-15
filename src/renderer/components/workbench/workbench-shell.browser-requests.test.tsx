import "./workbench-testkit/workbench-shell-harness";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import type {
  BrowserSidebarOpenNewTabRequest,
  BrowserUsePageClosedEvent,
} from "../../../shared/browser-sidebar";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  makeWorkbenchBrowserConversationId,
  materializeInitialWorkbenchScene,
} from "../../../shared/workbench-scene";
import { settleAsyncRender } from "../../test/dom";
import {
  getPanelTabById,
  invokeCalls,
  renderWorkbench,
} from "./workbench-testkit/workbench-shell-harness";
import { makeAttachedSession, makeSessionTab } from "./workbench-testkit/workbench-shell-fixtures";

async function fixture(kind: "project" | "session", activeTabId = "opener") {
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
    activeTabId,
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
          browserConversationId: makeWorkbenchBrowserConversationId(owner),
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
  const emitPageClosed = async (browserTabId: string) => {
    await act(async () => {
      for (const listener of listeners.get("browser-sidebar-browser-use-page-closed") ?? []) {
        listener({
          browserConversationId: makeWorkbenchBrowserConversationId(owner),
          browserViewScopeId: "window-session:test",
          browserTabId,
          reason: "agent",
        } satisfies BrowserUsePageClosedEvent);
      }
      await Promise.resolve();
    });
    await settleAsyncRender();
  };
  return { view, emit, emitPageClosed };
}

describe("Workbench Browser requests", () => {
  test("opens a popup beside an opener whose panel body is not mounted", async () => {
    const { view, emit } = await fixture("project", "after");
    expect(view.queryByDisplayValue("opener.example")).toBeNull();
    expect(view.getByDisplayValue("after.example")).toBeDefined();
    const before = view.getAllByRole("tab").length;
    for (const extra of [
      { browserViewScopeId: "another-window" },
      { browserConversationId: "library" },
      { browserConversationId: "inbox" },
    ]) {
      await emit(extra);
      expect(view.getAllByRole("tab")).toHaveLength(before);
    }

    await emit();
    await view.findByDisplayValue("popup.example");
    const order = [...view.container.querySelectorAll<HTMLElement>("[data-panel-tab-id]")].map(
      (tab) => tab.dataset.panelTabId!,
    );
    const openerIndex = order.indexOf("opener");
    expect(order.slice(openerIndex - 1, openerIndex + 3)).toEqual([
      "before",
      "opener",
      expect.any(String),
      "after",
    ]);
    const popupId = order[openerIndex + 1]!;
    expect(popupId).not.toBe("after");
    expect(getPanelTabById(view.container, popupId).getAttribute("aria-selected")).toBe("true");
    expect(getPanelTabById(view.container, "after").getAttribute("aria-selected")).toBe("false");
  });

  test.each(["project", "session"] as const)(
    "a %s Scene drops the tab of a page Main closed",
    async (kind) => {
      const { view, emitPageClosed } = await fixture(kind);
      expect(getPanelTabById(view.container, "after")).toBeDefined();
      await emitPageClosed("after:runtime");
      expect(view.container.querySelector('[data-panel-tab-id="after"]')).toBeNull();
      expect(getPanelTabById(view.container, "opener").getAttribute("aria-selected")).toBe("true");
    },
  );

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
