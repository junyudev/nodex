import { describe, expect, test } from "bun:test";
import {
  resolveColumnDropIndex,
  resolveDragPointer,
} from "./drag-pointer";

function createDragEvent(options?: {
  activatorEvent?: Event | null;
  delta?: {
    x: number;
    y: number;
  };
  initialRect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  translatedRect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
}) {
  return {
    activatorEvent: options?.activatorEvent ?? null,
    delta: options?.delta ?? { x: 0, y: 0 },
    active: {
      rect: {
        current: {
          initial: options?.initialRect ?? null,
          translated: options?.translatedRect ?? null,
        },
      },
    },
  };
}

describe("drag pointer", () => {
  test("resolves pointer coordinates from the activator event plus drag delta", () => {
    const pointer = resolveDragPointer(createDragEvent({
      activatorEvent: {
        clientX: 40,
        clientY: 90,
      } as MouseEvent,
      delta: { x: 12, y: 18 },
    }));

    expect(pointer?.x).toBe(52);
    expect(pointer?.y).toBe(108);
  });

  test("falls back to the translated rect center when pointer coordinates are unavailable", () => {
    const pointer = resolveDragPointer(createDragEvent({
      translatedRect: {
        left: 100,
        top: 200,
        width: 60,
        height: 80,
      },
    }));

    expect(pointer?.x).toBe(130);
    expect(pointer?.y).toBe(240);
  });

  test("computes the correct insertion slot when the pointer is in the gap between cards", () => {
    const surface = {
      querySelectorAll: () => [
        {
          getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
        },
        {
          getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
        },
      ],
    } as unknown as HTMLElement;

    const index = resolveColumnDropIndex({
      surface,
      fallbackIndex: 2,
      event: createDragEvent({
        activatorEvent: {
          clientX: 20,
          clientY: 145,
        } as MouseEvent,
      }),
    });

    expect(index).toBe(1);
  });
});
