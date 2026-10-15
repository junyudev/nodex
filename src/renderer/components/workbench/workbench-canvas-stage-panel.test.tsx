import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { WorkbenchSurfaceDescriptor } from "../../../shared/workbench-scene";
import { useLibraryCanvasTarget } from "@/lib/use-library-navigation";
import { WorkbenchCanvasStagePanel } from "./workbench-canvas-stage-panel";

vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryCanvasTarget: vi.fn(),
}));

vi.mock("@/components/canvas/canvas-document-surface", () => ({
  CanvasDocumentSurface: (props: {
    canvasBlockId: string;
    active: boolean;
    viewportPreferenceScope: string;
  }) => (
    <div
      data-testid="canvas-document-surface"
      data-canvas-block-id={props.canvasBlockId}
      data-active={String(props.active)}
      data-viewport-preference-scope={props.viewportPreferenceScope}
    />
  ),
}));

const canvasSurface = {
  id: "canvas-tab",
  kind: "canvas_stage",
  titleSnapshot: "Snapshot title",
  config: {
    routingContext: { kind: "project", projectId: "project-1" },
    canvasBlockId: "canvas-1",
    titleSnapshot: "Snapshot title",
  },
  stateKey: 0,
  state: null,
} satisfies WorkbenchSurfaceDescriptor;

describe("WorkbenchCanvasStagePanel", () => {
  beforeEach(() => {
    vi.mocked(useLibraryCanvasTarget).mockReturnValue({
      data: {
        kind: "canvas_target",
        value: {
          status: "available",
          summary: {
            canvasId: "canvas-1",
            projectId: "project-1",
            libraryId: "library-1",
            title: "Live title",
            lifecycle: "active",
            isPrimary: false,
            location: {
              parentKind: "page",
              parentId: "page-1",
              hostPageId: "page-1",
              parentBlockId: null,
              rankKey: "a",
            },
            metadataRevision: 1,
            locationRevision: 1,
            documentGeneration: 0,
            documentHeadSeq: 0,
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        },
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 1,
      },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useLibraryCanvasTarget>);
  });

  test("replaces the snapshot chrome title with live Canvas metadata", async () => {
    const onTitleChange = vi.fn();

    render(
      <WorkbenchCanvasStagePanel
        surface={canvasSurface}
        windowSessionId="window-1"
        presentationOwnerId="session-1"
        isActivePanelTab
        onClose={vi.fn()}
        onTitleChange={onTitleChange}
      />,
    );

    await waitFor(() => {
      expect(onTitleChange).toHaveBeenCalledWith("Live title");
    });
    const surface = await screen.findByTestId("canvas-document-surface");
    expect(surface.getAttribute("data-canvas-block-id")).toBe("canvas-1");
    expect(surface.getAttribute("data-active")).toBe("true");
  });

  test("keeps the Stage viewport scope stable when the Canvas tab is reopened", async () => {
    const rendered = render(
      <WorkbenchCanvasStagePanel
        surface={canvasSurface}
        windowSessionId="window-1"
        presentationOwnerId="session-1"
        isActivePanelTab
        onClose={vi.fn()}
        onTitleChange={vi.fn()}
      />,
    );
    const firstScope = (await screen.findByTestId("canvas-document-surface")).getAttribute(
      "data-viewport-preference-scope",
    );

    rendered.rerender(
      <WorkbenchCanvasStagePanel
        surface={{ ...canvasSurface, id: "reopened-canvas-tab" }}
        windowSessionId="window-1"
        presentationOwnerId="session-1"
        isActivePanelTab
        onClose={vi.fn()}
        onTitleChange={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("canvas-document-surface").getAttribute("data-viewport-preference-scope"),
    ).toBe(firstScope);
  });
});
