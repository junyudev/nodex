import { act } from "@testing-library/react";
import { createElement, useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { render } from "@/test/dom";
import { useBoardElementDragMonitor } from "./use-board-element-drag-monitor";

type ElementMonitorArgs = Parameters<typeof monitorForElements>[0];

const monitorHarness = vi.hoisted(() => ({
  registrations: [] as unknown[],
  cleanupCount: 0,
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter", () => ({
  monitorForElements: (args: unknown) => {
    monitorHarness.registrations.push(args);
    return () => {
      monitorHarness.cleanupCount += 1;
    };
  },
}));

const event = {
  source: { data: { kind: "board-card" } },
  location: {
    initial: { input: {}, dropTargets: [] },
    current: { input: {}, dropTargets: [] },
    previous: { dropTargets: [] },
  },
} as unknown as Parameters<NonNullable<ElementMonitorArgs["onDragStart"]>>[0];

const observedRenders: number[] = [];
let dropCount = 0;

function MonitorProbe() {
  const [renderCount, setRenderCount] = useState(0);

  useBoardElementDragMonitor({
    scopeKey: Symbol.for("board-monitor-test"),
    canMonitor: () => true,
    onDragStart: () => setRenderCount((current) => current + 1),
    onDrag: () => observedRenders.push(renderCount),
    onDrop: () => {
      dropCount += 1;
    },
  });

  return createElement("div", null, renderCount);
}

describe("useBoardElementDragMonitor", () => {
  beforeEach(() => {
    monitorHarness.registrations.length = 0;
    monitorHarness.cleanupCount = 0;
    observedRenders.length = 0;
    dropCount = 0;
  });

  test("keeps source ownership across the drag-start rerender", async () => {
    const view = render(createElement(MonitorProbe));
    const registration = monitorHarness.registrations[0] as ElementMonitorArgs;

    await act(async () => {
      registration.onDragStart?.(event);
      await Promise.resolve();
    });

    expect(view.container.textContent).toBe("1");
    expect(monitorHarness.registrations).toHaveLength(1);
    expect(monitorHarness.cleanupCount).toBe(0);

    registration.onDrag?.(event);
    expect(observedRenders).toEqual([1]);

    registration.onDrop?.(event);
    expect(dropCount).toBe(1);

    view.unmount();
    expect(monitorHarness.cleanupCount).toBe(1);
  });
});
