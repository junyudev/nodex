import { vi } from "vite-plus/test";
import { makeTestWorkbenchSession } from "@/components/workbench/workbench-testkit/panel-fixtures";
import {
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
} from "../../shared/workbench-scene";
import { findWorkbenchPanelLeafForTab } from "../../shared/workbench-panel-layout";
import {
  presentWorkbenchSessionDomainWithScene,
  workbenchSurfaceFromCreateInput,
} from "./workbench-scene-presentation";
import {
  openSessionPageFileTab,
  findPageFileTab,
  type OpenPageFileTabInput,
} from "./workbench-page-file-opener";
import {
  makePinnedPreviewTabCreateInput,
  makePreviewWorkbenchTabProjection,
  type ProjectSessionPreviewTab,
} from "./workbench-panel-preview";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import type { WorkbenchTabCreateInput, PanelId } from "./types";
import type { WorkbenchEphemeralPanelStateUpdate } from "./workbench-ephemeral-panel-state";
import { describe, expect, test } from "vite-plus/test";

import { normalizeUserAttachmentImageEditorOptions } from "@/lib/content-image";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import {
  consumeImagePanelAutoExpansion,
  createImageEditorPanelTab,
  findCanvasStageTab,
  IMAGE_SIDE_PANEL_AUTO_EXPANDED_STORAGE_KEY,
  removeImageEditorPreviewsFromLeaf,
} from "./use-workbench-panel-openers";

function makeSession(): Pick<WorkbenchSessionRenderProjection, "tabs"> {
  return {
    tabs: [
      {
        id: "canvas-a",
        sessionId: "session-1",
        projectId: "project-1",
        panelId: "right",
        kind: "canvas_stage",
        title: "Canvas A",
        order: 0,
        config: {
          routingContext: { kind: "project", projectId: "project-1" },
          canvasBlockId: "canvas-1",
        },
        browserTabId: null,
        stateKey: 0,
        state: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        id: "canvas-b",
        sessionId: "session-1",
        projectId: "project-1",
        panelId: "bottom",
        kind: "canvas_stage",
        title: "Canvas B",
        order: 0,
        config: {
          routingContext: { kind: "project", projectId: "project-1" },
          canvasBlockId: "canvas-2",
        },
        browserTabId: null,
        stateKey: 0,
        state: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
}

describe("findCanvasStageTab", () => {
  test("deduplicates the same public Canvas identity across panel leaves", () => {
    const session = makeSession();

    expect(findCanvasStageTab(session, "project-1", "canvas-1")?.id).toBe("canvas-a");
    expect(findCanvasStageTab(session, "project-1", "canvas-2")?.id).toBe("canvas-b");
    expect(findCanvasStageTab(session, "project-2", "canvas-1")).toBeNull();
  });
});

describe("image editor panel opening", () => {
  function imageOptions() {
    return normalizeUserAttachmentImageEditorOptions({
      alt: "Attachment",
      attachmentSrc: "data:image/png;base64,AA==",
      src: "data:image/png;base64,AA==",
      openInEditor: true,
      projectId: "project-1",
      threadId: "thread-1",
    });
  }

  test("builds a pinnable right-panel preview descriptor", () => {
    const tab = createImageEditorPanelTab({
      id: "image:00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      leafId: "right-leaf",
      options: imageOptions(),
      stateKey: 42,
    });

    expect(tab).toMatchObject({
      imageEditor: true,
      id: "image:00000000-0000-4000-8000-000000000000",
      sessionId: "session-1",
      projectId: "project-1",
      threadId: "thread-1",
      panelId: "right",
      leafId: "right-leaf",
      title: "User attachment",
      tooltip: "User attachment",
      stateKey: 42,
      preview: true,
      pinBehavior: "automatic",
    });
  });

  test("replaces only the image preview in the destination leaf", () => {
    const first = createImageEditorPanelTab({
      id: "image:00000000-0000-4000-8000-000000000001",
      sessionId: "session-1",
      leafId: "right-leaf",
      options: imageOptions(),
    });
    const sibling = createImageEditorPanelTab({
      id: "image:00000000-0000-4000-8000-000000000002",
      sessionId: "session-1",
      leafId: "right-leaf-2",
      options: imageOptions(),
    });

    expect(removeImageEditorPreviewsFromLeaf([first, sibling], "right-leaf")).toEqual([sibling]);
  });

  test("persists the first expansion once and tolerates storage failure", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    expect(consumeImagePanelAutoExpansion(storage)).toBe(true);
    expect(values.get(IMAGE_SIDE_PANEL_AUTO_EXPANDED_STORAGE_KEY)).toBe("true");
    expect(consumeImagePanelAutoExpansion(storage)).toBe(false);
    expect(
      consumeImagePanelAutoExpansion({
        getItem: () => {
          throw new Error("unavailable");
        },
        setItem: () => undefined,
      }),
    ).toBe(true);
  });
});

function pageFileHarness() {
  const session = makeTestWorkbenchSession({ id: "session", projectId: null, tabs: [] });
  let scene = materializeInitialWorkbenchScene({ kind: "session", sessionId: session.id });
  let previews: Record<string, ProjectSessionPreviewTab> = {};
  const readSession = () => presentWorkbenchSessionDomainWithScene(session, scene);
  const createTab = vi.fn(async (input: WorkbenchTabCreateInput) => {
    const surface = workbenchSurfaceFromCreateInput(input);
    scene = createWorkbenchSceneSurface(scene, {
      panelId: input.panelId,
      targetLeafId: input.targetLeafId,
      targetIndex: input.targetIndex,
      surface,
    });
    return readSession().tabs.find((tab) => tab.id === surface.id) ?? null;
  });
  const setActivePanelTab = vi.fn(async () => {});
  const pinPreviewTab = vi.fn(async (panelId: PanelId, tabId: string, leafId?: string) => {
    const key = makeWorkbenchSessionPanelSlotKey(session.id, panelId, leafId);
    const tab = previews[key];
    if (!tab || tab.id !== tabId || !leafId) return;
    await createTab(makePinnedPreviewTabCreateInput(readSession(), panelId, leafId, tab));
    delete previews[key];
  });
  const prepareClose = vi.fn(async () => true);
  const ports = {
    readSession,
    readPreviews: () => previews,
    controller: {
      updateTabOrderByPanelGroup: () => {},
      updatePreviewTabsByPanel: (
        update: WorkbenchEphemeralPanelStateUpdate<Record<string, ProjectSessionPreviewTab>>,
      ) => {
        previews = typeof update === "function" ? update(previews) : update;
      },
      durable: {
        ensureLeafToRight: () => {
          throw new Error("Unexpected split");
        },
      },
    },
    lifecycle: { setActivePanelTab, pinPreviewTab },
    rightPanelFullWidth: false,
    createTab,
    prepareClose,
  };
  return {
    ports,
    createTab,
    prepareClose,
    setActivePanelTab,
    pinPreviewTab,
    get scene() {
      return scene;
    },
    get previews() {
      return previews;
    },
  };
}
const pageFileInput: OpenPageFileTabInput = {
  routingContext: { kind: "library" },
  pageId: "page",
  fileId: "file",
  logicalPath: "profile/report.html",
  title: "report.html",
};

describe("Page File opening", () => {
  test("inserts after the source Page and activates the same File across routes and panels", async () => {
    const h = pageFileHarness();
    const page = await h.createTab({
      sessionId: "session",
      panelId: "bottom",
      kind: "page_stage",
      title: "Page",
      config: { routingContext: { kind: "library" }, pageId: "page" },
    });
    const sibling = await h.createTab({
      sessionId: "session",
      panelId: "bottom",
      kind: "page_stage",
      title: "Other",
      config: { routingContext: { kind: "library" }, pageId: "other" },
    });
    expect(page && sibling).toBeTruthy();
    const input = {
      ...pageFileInput,
      placement: { kind: "same-group" as const, sourceSurfaceId: page!.id },
    };
    expect(await openSessionPageFileTab(input, h.ports)).toBe(true);
    const file = findPageFileTab(h.ports.readSession(), input)!;
    const leaf = findWorkbenchPanelLeafForTab(h.scene.panels.bottom.layout, page!.id)!;
    expect(leaf.tabIds).toEqual([page!.id, file.id, sibling!.id]);
    const count = h.createTab.mock.calls.length;
    expect(
      await openSessionPageFileTab(
        { ...input, routingContext: { kind: "project", projectId: "elsewhere" } },
        h.ports,
      ),
    ).toBe(true);
    expect(h.createTab.mock.calls.length).toBe(count);
    expect(h.setActivePanelTab).toHaveBeenLastCalledWith("bottom", file.id, {
      leafId: leaf.id,
      openPanel: true,
    });
  });
  test("reuses a preview, replaces its slot, and pins the current File with the same identity", async () => {
    const h = pageFileHarness();
    expect(await openSessionPageFileTab({ ...pageFileInput, openMode: "preview" }, h.ports)).toBe(
      true,
    );
    const first = Object.values(h.previews)[0]!;
    expect(await openSessionPageFileTab({ ...pageFileInput, openMode: "preview" }, h.ports)).toBe(
      true,
    );
    expect(Object.values(h.previews)[0]?.id).toBe(first.id);
    expect(
      await openSessionPageFileTab(
        { ...pageFileInput, fileId: "next", openMode: "preview" },
        h.ports,
      ),
    ).toBe(true);
    const next = Object.values(h.previews)[0]!;
    expect(next.id).not.toBe(first.id);
    expect(Object.keys(h.previews)).toHaveLength(1);
    expect(h.createTab).not.toHaveBeenCalled();
    expect(
      await openSessionPageFileTab(
        { ...pageFileInput, fileId: "next", openMode: "durable" },
        h.ports,
      ),
    ).toBe(true);
    expect(h.ports.readSession().tabs[0]?.id).toBe(next.id);
    expect(Object.values(h.previews)).toHaveLength(0);
  });
  test("retains an unsaved preview when its content owner vetoes replacement", async () => {
    const h = pageFileHarness();
    await openSessionPageFileTab({ ...pageFileInput, openMode: "preview" }, h.ports);
    const first = Object.values(h.previews)[0]!;
    h.prepareClose.mockResolvedValue(false);
    expect(
      await openSessionPageFileTab(
        { ...pageFileInput, fileId: "next", openMode: "preview" },
        h.ports,
      ),
    ).toBe(false);
    expect(Object.values(h.previews)[0]).toBe(first);
  });
  test("keeps a source preview Page before its File", async () => {
    const h = pageFileHarness();
    const session = h.ports.readSession();
    const leaf = session.panels.right.layout.activeLeafId;
    const page = makePreviewWorkbenchTabProjection({ ...session, projectId: "project" }, "right", {
      kind: "page_stage",
      title: "Page",
      config: { routingContext: { kind: "library" }, pageId: "page" },
    });
    h.ports.controller.updatePreviewTabsByPanel({
      [makeWorkbenchSessionPanelSlotKey(session.id, "right", leaf)]: page,
    });
    expect(
      await openSessionPageFileTab(
        {
          ...pageFileInput,
          openMode: "preview",
          placement: { kind: "same-group", sourceSurfaceId: page.id },
        },
        h.ports,
      ),
    ).toBe(true);
    expect(h.ports.readSession().tabs[0]?.id).toBe(page.id);
    expect(Object.values(h.previews)[0]).toMatchObject({
      kind: "page_file",
      previewTargetIndex: 1,
    });
  });
});
