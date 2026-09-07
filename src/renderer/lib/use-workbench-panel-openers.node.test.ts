import { describe, expect, test } from "vite-plus/test";

import { normalizeUserAttachmentImageEditorOptions } from "@/features/user-attachment-image-editor";
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
          accessContext: { kind: "project", projectId: "project-1" },
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
          accessContext: { kind: "project", projectId: "project-1" },
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
