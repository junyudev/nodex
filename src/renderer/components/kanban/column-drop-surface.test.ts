import { describe, expect, test } from "bun:test";
import { bindKanbanColumnDropSurface } from "./column-drop-surface";

function createCleanupTracker() {
  let count = 0;
  return {
    cleanup: () => {
      count += 1;
    },
    getCount: () => count,
  };
}

describe("bindKanbanColumnDropSurface", () => {
  test("registers a drop target even when the column has no scroll surface", () => {
    const dropCleanup = createCleanupTracker();
    let dropCalls = 0;
    let autoScrollCalls = 0;
    let combineCalls = 0;

    const cleanup = bindKanbanColumnDropSurface(
      {
        columnId: "done",
        columnDropDisabled: false,
        dragInstanceId: Symbol("kanban"),
        element: {} as HTMLElement,
        scrollElement: null,
      },
      {
        dropTargetForElements: () => {
          dropCalls += 1;
          return dropCleanup.cleanup;
        },
        autoScrollForElements: () => {
          autoScrollCalls += 1;
          return () => undefined;
        },
        combine: (...cleanups) => {
          combineCalls += 1;
          return () => {
            for (const run of cleanups) {
              run();
            }
          };
        },
      },
    );

    expect(dropCalls).toBe(1);
    expect(autoScrollCalls).toBe(0);
    expect(combineCalls).toBe(0);
    cleanup?.();
    expect(dropCleanup.getCount()).toBe(1);
  });

  test("combines drop-target and auto-scroll cleanup when the scroll surface exists", () => {
    const dropCleanup = createCleanupTracker();
    const autoScrollCleanup = createCleanupTracker();
    let combineCalls = 0;

    const cleanup = bindKanbanColumnDropSurface(
      {
        columnId: "in_progress",
        columnDropDisabled: false,
        dragInstanceId: Symbol("kanban"),
        element: {} as HTMLElement,
        scrollElement: {} as HTMLElement,
      },
      {
        dropTargetForElements: () => dropCleanup.cleanup,
        autoScrollForElements: () => autoScrollCleanup.cleanup,
        combine: (...cleanups) => {
          combineCalls += 1;
          return () => {
            for (const run of cleanups) {
              run();
            }
          };
        },
      },
    );

    expect(combineCalls).toBe(1);
    cleanup?.();
    expect(dropCleanup.getCount()).toBe(1);
    expect(autoScrollCleanup.getCount()).toBe(1);
  });
});
