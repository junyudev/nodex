import { describe, expect, test } from "bun:test";
import { finalizeSideMenuBlockDrag } from "./side-menu-drag-lifecycle";

describe("finalizeSideMenuBlockDrag", () => {
  test("clears ProseMirror dragging and delegates to the side-menu cleanup", () => {
    let blockDragEnded = false;
    const editor = {
      prosemirrorView: {
        dragging: { id: "dragging" },
        root: {
          querySelectorAll: () => [],
        },
      },
      getExtension: () => ({
        blockDragEnd: () => {
          blockDragEnded = true;
        },
      }),
    };

    finalizeSideMenuBlockDrag(
      editor as unknown as Parameters<typeof finalizeSideMenuBlockDrag>[0],
    );

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(blockDragEnded).toBeTrue();
  });

  test("removes orphaned drag previews when blockDragEnd is unavailable", () => {
    let removed = 0;
    const editor = {
      prosemirrorView: {
        dragging: { id: "dragging" },
        root: {
          querySelectorAll: () => [
            { remove: () => { removed += 1; } },
            { remove: () => { removed += 1; } },
          ],
        },
      },
      getExtension: () => null,
    };

    finalizeSideMenuBlockDrag(
      editor as unknown as Parameters<typeof finalizeSideMenuBlockDrag>[0],
    );

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(removed).toBe(2);
  });
});
