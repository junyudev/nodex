import { describe, expect, test } from "bun:test";
import {
  endProjectionBlockDrag,
  startProjectionBlockDrag,
} from "./projection-drag-handle";

describe("projection drag handle helpers", () => {
  test("prevents drag start when SideMenu extension is unavailable", () => {
    let prevented = false;
    const editor = {
      getExtension: () => null,
    };

    const started = startProjectionBlockDrag(
      editor,
      { id: "owner" },
      {
        dataTransfer: null,
        clientY: 0,
        preventDefault: () => {
          prevented = true;
        },
      },
    );

    expect(started).toBeFalse();
    expect(prevented).toBeTrue();
  });

  test("starts drag with freshest block from editor when available", () => {
    let draggedBlock: unknown;
    const storedBlock = { id: "owner", type: "cardRef", props: { sourceProjectId: "default" } };
    const editor = {
      getExtension: () => ({
        blockDragStart: (_event: unknown, block: unknown) => {
          draggedBlock = block;
        },
        blockDragEnd: () => {},
      }),
      getBlock: () => storedBlock,
    };

    const started = startProjectionBlockDrag(
      editor,
      { id: "owner" },
      {
        dataTransfer: null,
        clientY: 12,
        preventDefault: () => {},
      },
    );

    expect(started).toBeTrue();
    expect(draggedBlock).toBe(storedBlock);
  });

  test("falls back to render block when editor.getBlock is missing", () => {
    let draggedBlock: unknown;
    const fallbackBlock = { id: "owner" };
    const editor = {
      getExtension: () => ({
        blockDragStart: (_event: unknown, block: unknown) => {
          draggedBlock = block;
        },
        blockDragEnd: () => {},
      }),
    };

    const started = startProjectionBlockDrag(
      editor,
      fallbackBlock,
      {
        dataTransfer: null,
        clientY: 8,
        preventDefault: () => {},
      },
    );

    expect(started).toBeTrue();
    expect(draggedBlock).toBe(fallbackBlock);
  });

  test("ends drag when SideMenu extension is available", () => {
    let ended = false;
    const editor = {
      getExtension: () => ({
        blockDragStart: () => {},
        blockDragEnd: () => {
          ended = true;
        },
      }),
    };

    endProjectionBlockDrag(editor);
    expect(ended).toBeTrue();
  });
});
