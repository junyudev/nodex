import { act } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { draggable } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { render } from "@/test/dom";
import type { BoardCardDragData } from "@/components/board/pragmatic-drag-data";

import {
  createDatabaseListPageDragPreviewElement,
  useDatabaseViewPageDragSource,
} from "./database-view-page-drag";

type ElementDraggableArgs = Parameters<typeof draggable>[0];

const draggableHarness = vi.hoisted(() => ({
  registration: null as ElementDraggableArgs | null,
  cleanupCount: 0,
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter", () => ({
  draggable: (args: ElementDraggableArgs) => {
    draggableHarness.registration = args;
    return () => {
      draggableHarness.cleanupCount += 1;
    };
  },
}));

const dragData = {
  type: "board-card",
  instanceId: Symbol("board"),
  projectId: "project-a",
  databaseBlockId: "database-a",
  dataSourceId: "source-a",
  storeEpoch: "epoch-a",
  sourcePageId: "page-a",
  sourceColumnId: "triage",
  sourcePage: { id: "page-a", title: "Page A" },
  dragItems: [
    {
      card: { id: "page-a", title: "Page A" },
      columnId: "triage",
      columnName: "Triage",
    },
  ],
} as unknown as BoardCardDragData;

function DragSourceProbe({
  onDragFinished,
  data = dragData,
}: {
  readonly onDragFinished: () => void;
  readonly data?: BoardCardDragData;
}) {
  const { setElementRef } = useDatabaseViewPageDragSource(data, { onDragFinished });
  return createElement("div", { ref: setElementRef });
}

describe("Database View Page drag preview", () => {
  beforeEach(() => {
    draggableHarness.registration = null;
    draggableHarness.cleanupCount = 0;
  });

  test("keeps List source presentation and adds a multi-Page count badge", () => {
    const source = document.createElement("div");
    source.style.boxShadow = "0 0 0 1px blue";
    source.textContent = "List Page";
    source.getBoundingClientRect = () => ({
      bottom: 56,
      height: 44,
      left: 12,
      right: 252,
      top: 12,
      width: 240,
      x: 12,
      y: 12,
      toJSON: () => undefined,
    });

    const preview = createDatabaseListPageDragPreviewElement({
      element: source,
      itemCount: 3,
    });
    const clone = preview.firstElementChild as HTMLElement;

    expect(clone.style.boxShadow).toBe("0 0 0 1px blue");
    expect(preview.lastElementChild?.textContent).toBe("3");
  });

  test("uses current committed data and completion callbacks while keeping an active drag stable", async () => {
    const previousFinish = vi.fn();
    const currentFinish = vi.fn();
    const view = render(createElement(DragSourceProbe, { onDragFinished: previousFinish }));
    const registration = draggableHarness.registration;
    if (!registration) throw new Error("Page drag source was not registered");
    const nextData = { ...dragData, sourcePageId: "page-b" };
    view.rerender(
      createElement(DragSourceProbe, { onDragFinished: currentFinish, data: nextData }),
    );
    expect(draggableHarness.registration).toBe(registration);
    expect(registration.getInitialData?.({} as never)).toBe(nextData);
    view.rerender(
      createElement(DragSourceProbe, { onDragFinished: currentFinish, data: dragData }),
    );
    expect(registration.getInitialData?.({} as never)).toBe(nextData);
    view.unmount();
    expect(previousFinish).not.toHaveBeenCalled();
    expect(currentFinish).toHaveBeenCalledOnce();
  });

  test("finishes an active Page drag when its source unmounts", async () => {
    const onDragFinished = vi.fn();
    const view = render(createElement(DragSourceProbe, { onDragFinished }));
    const registration = draggableHarness.registration;
    if (!registration) throw new Error("Page drag source was not registered");

    await act(async () => {
      registration.getInitialData?.({} as never);
      registration.onDragStart?.({} as never);
      await Promise.resolve();
    });

    view.unmount();

    expect(onDragFinished).toHaveBeenCalledTimes(1);
    expect(draggableHarness.cleanupCount).toBe(1);
  });
});
