import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  BlockReferenceRuntimeProvider,
  type BlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import { useLibraryCanvasTarget } from "@/lib/use-library-navigation";
import { readCanvasInlineFramePreference } from "@/lib/canvas-presentation-preference";
import { installMeasuredResizeObserver } from "@/test/browser-globals";
import { CanvasBlock, CanvasBlockFrame, canvasInlineSurfaceActivationBudget } from "./canvas-block";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";

vi.mock("@/lib/use-element-visibility", () => ({
  useElementVisibility: () => ({
    ref: () => undefined,
    visible: true,
  }),
}));

vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryCanvasTarget: vi.fn(),
}));

vi.mock("@/components/canvas/canvas-document-surface", () => ({
  CanvasDocumentSurface: (props: {
    canvasBlockId: string;
    variant: string;
    viewportPreferenceScope: string;
  }) => (
    <div
      data-testid="inline-canvas-surface"
      data-canvas-block-id={props.canvasBlockId}
      data-variant={props.variant}
      data-viewport-preference-scope={props.viewportPreferenceScope}
    />
  ),
}));

describe("CanvasBlock", () => {
  test("delivers history input to the embedded Canvas before the parent can claim it", async () => {
    const view = render(
      <div className="nfm-editor">
        <CanvasBlockFrame canvasBlockId="canvas-history" title="Canvas" active>
          <button aria-label="Canvas scene" />
        </CanvasBlockFrame>
      </div>,
    );
    const parent = view.container.firstElementChild as HTMLElement;
    const scene = view.getByRole("button", { name: "Canvas scene" });
    const parentHistory = vi.fn();
    const canvasHistory = vi.fn();
    const capture = (event: Event) => {
      if (!ownsNfmEditorEvent(parent, event.target)) return;
      parentHistory();
      event.preventDefault();
      event.stopPropagation();
    };
    parent.addEventListener("keydown", capture, true);
    parent.addEventListener("beforeinput", capture, true);
    scene.addEventListener("keydown", canvasHistory);
    scene.addEventListener("beforeinput", canvasHistory);
    try {
      await act(async () => {
        scene.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        scene.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "historyUndo",
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
      });
      expect(parentHistory).not.toHaveBeenCalled();
      expect(canvasHistory).toHaveBeenCalledTimes(2);
    } finally {
      parent.removeEventListener("keydown", capture, true);
      parent.removeEventListener("beforeinput", capture, true);
      view.unmount();
    }
  });

  beforeEach(() => {
    canvasInlineSurfaceActivationBudget.clear();
    localStorage.clear();
    vi.mocked(useLibraryCanvasTarget).mockReturnValue({
      data: {
        kind: "canvas_target",
        value: {
          status: "available",
          summary: {
            canvasId: "canvas-1",
            projectId: "project-1",
            libraryId: "library-1",
            title: "System map",
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

  test("mounts the independent Canvas surface and opens the same public identity", async () => {
    const openCanvas = vi.fn();
    const renameCanvas = vi.fn(async () => undefined);
    const host = {
      contentAccessContext: { kind: "project", projectId: "project-1" } as const,
      projectName: "Project",
      projectWorkspacePath: null,
      hostPageId: "page-1",
      ancestorPageIds: ["page-1"],
      ancestorDocumentOwnerBlockIds: ["page-1"],
      isActiveSurface: true,
      documentSurfaceId: "page-surface-1",
      openCanvas,
      renameCanvas,
    } satisfies BlockReferenceHostRuntime;

    render(
      <BlockReferenceRuntimeProvider value={host}>
        <CanvasBlock canvasBlockId="canvas-1" />
      </BlockReferenceRuntimeProvider>,
    );

    const surface = await screen.findByTestId("inline-canvas-surface");
    expect(surface.getAttribute("data-canvas-block-id")).toBe("canvas-1");
    expect(surface.getAttribute("data-variant")).toBe("inline");
    expect(surface.getAttribute("data-viewport-preference-scope")).toBe(
      JSON.stringify(["inline", "canvas-1"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open System map" }));
    expect(openCanvas).toHaveBeenCalledWith({
      accessContext: { kind: "project", projectId: "project-1" },
      canvasBlockId: "canvas-1",
      titleSnapshot: "System map",
    });

    fireEvent.click(screen.getByRole("button", { name: "Rename System map" }));
    const titleInput = screen.getByRole("textbox", { name: "Canvas name" });
    fireEvent.change(titleInput, { target: { value: "Architecture map" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    expect(renameCanvas).toHaveBeenCalledWith({
      canvasBlockId: "canvas-1",
      displayName: "Architecture map",
    });
  });

  test("auto-admits a bounded set and keeps an engaged Canvas mounted", async () => {
    const host = {
      contentAccessContext: { kind: "project", projectId: "project-1" } as const,
      projectName: "Project",
      projectWorkspacePath: null,
      hostPageId: "page-1",
      ancestorPageIds: ["page-1"],
      ancestorDocumentOwnerBlockIds: ["page-1"],
      isActiveSurface: true,
      documentSurfaceId: "page-surface-1",
    } satisfies BlockReferenceHostRuntime;

    render(
      <BlockReferenceRuntimeProvider value={host}>
        <CanvasBlock canvasBlockId="canvas-1" />
        <CanvasBlock canvasBlockId="canvas-2" />
        <CanvasBlock canvasBlockId="canvas-3" />
      </BlockReferenceRuntimeProvider>,
    );

    const mounted = await screen.findAllByTestId("inline-canvas-surface");
    expect(mounted).toHaveLength(2);
    expect(screen.queryByText("Activate Canvas")).toBeNull();

    const firstShell = document.querySelector('[data-canvas-block="canvas-1"]');
    expect(firstShell).not.toBeNull();
    fireEvent.pointerDown(firstShell!);
    await waitFor(() => {
      const reactivated = screen.getAllByTestId("inline-canvas-surface");
      expect(reactivated).toHaveLength(2);
      expect(
        reactivated.some((surface) => surface.getAttribute("data-canvas-block-id") === "canvas-1"),
      ).toBe(true);
    });
  });

  test("Escape selects the host shell without hiding an admitted Canvas", async () => {
    const setTextCursorPosition = vi.fn();
    const focus = vi.fn();
    const hostEditor = {
      document: [{ id: "canvas-1", type: "canvas" }],
      getTextCursorPosition: () => ({
        block: { id: "canvas-1", type: "canvas" },
      }),
      setTextCursorPosition,
      focus,
    };
    const host = {
      contentAccessContext: { kind: "project", projectId: "project-1" } as const,
      projectName: "Project",
      projectWorkspacePath: null,
      hostPageId: "page-1",
      ancestorPageIds: ["page-1"],
      ancestorDocumentOwnerBlockIds: ["page-1"],
      isActiveSurface: true,
      documentSurfaceId: "page-surface-1",
    } satisfies BlockReferenceHostRuntime;

    render(
      <BlockReferenceRuntimeProvider value={host}>
        <CanvasBlock canvasBlockId="canvas-1" hostEditor={hostEditor} />
      </BlockReferenceRuntimeProvider>,
    );
    await screen.findByTestId("inline-canvas-surface");

    const shell = document.querySelector('[data-canvas-block="canvas-1"]');
    expect(shell).not.toBeNull();
    fireEvent.keyDown(shell!, { key: "Escape" });

    expect(setTextCursorPosition).toHaveBeenCalledWith("canvas-1", "start");
    expect(focus).toHaveBeenCalledOnce();
    expect(screen.getByTestId("inline-canvas-surface")).not.toBeNull();
  });

  test("restores frame height across Page runtime replacement", async () => {
    installMeasuredResizeObserver({ blockSize: 520, inlineSize: 800 });
    const host = {
      contentAccessContext: { kind: "project", projectId: "project-1" } as const,
      projectName: "Project",
      projectWorkspacePath: null,
      hostPageId: "page-1",
      ancestorPageIds: ["page-1"],
      ancestorDocumentOwnerBlockIds: ["page-1"],
      isActiveSurface: true,
      documentSurfaceId: "page-client-1",
    } satisfies BlockReferenceHostRuntime;

    const first = render(
      <BlockReferenceRuntimeProvider value={host}>
        <CanvasBlock canvasBlockId="canvas-1" />
      </BlockReferenceRuntimeProvider>,
    );
    await screen.findByTestId("inline-canvas-surface");
    const firstFrame = first.container.querySelector<HTMLElement>("[data-canvas-inline-frame]");
    expect(firstFrame?.style.height).toBe("288px");
    if (firstFrame) firstFrame.style.height = "520px";
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    first.unmount();

    expect(
      readCanvasInlineFramePreference({
        storeEpoch: "epoch-1",
        canvasBlockId: "canvas-1",
      }),
    ).toEqual({ heightPx: 520 });

    const second = render(
      <BlockReferenceRuntimeProvider
        value={{
          ...host,
          documentSurfaceId: "page-client-2",
        }}
      >
        <CanvasBlock canvasBlockId="canvas-1" />
      </BlockReferenceRuntimeProvider>,
    );
    await screen.findByTestId("inline-canvas-surface");
    expect(
      second.container.querySelector<HTMLElement>("[data-canvas-inline-frame]")?.style.height,
    ).toBe("520px");

    second.unmount();
    expect(
      readCanvasInlineFramePreference({
        storeEpoch: "epoch-1",
        canvasBlockId: "canvas-1",
      }),
    ).toEqual({ heightPx: 520 });
  });

  test("keeps compact height out of the expanded frame preference", async () => {
    installMeasuredResizeObserver({ blockSize: 520, inlineSize: 800 });
    const frame = render(
      <CanvasBlockFrame
        canvasBlockId="canvas-compact"
        title="Canvas"
        active
        expanded
        heightPreferenceStoreEpoch="epoch-1"
      >
        <div />
      </CanvasBlockFrame>,
    );
    const viewport = frame.container.querySelector<HTMLElement>("[data-canvas-inline-frame]");
    expect(viewport?.style.height).toBe("288px");
    if (viewport) viewport.style.height = "520px";
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    frame.rerender(
      <CanvasBlockFrame
        canvasBlockId="canvas-compact"
        title="Canvas"
        active={false}
        expanded={false}
        heightPreferenceStoreEpoch="epoch-1"
      >
        <div />
      </CanvasBlockFrame>,
    );
    expect(viewport?.style.height).toBe("");
    expect(
      readCanvasInlineFramePreference({
        storeEpoch: "epoch-1",
        canvasBlockId: "canvas-compact",
      }),
    ).toEqual({ heightPx: 520 });

    frame.rerender(
      <CanvasBlockFrame
        canvasBlockId="canvas-compact"
        title="Canvas"
        active
        expanded
        heightPreferenceStoreEpoch="epoch-1"
      >
        <div />
      </CanvasBlockFrame>,
    );
    expect(viewport?.style.height).toBe("520px");
  });
});
