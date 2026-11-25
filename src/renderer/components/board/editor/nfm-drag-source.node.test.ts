import { describe, expect, test } from "vite-plus/test";
import { isBlockWithinOwnerTree } from "./block-tree-ancestry";
import { getElementFromTarget, resolveDraggedBlockIds } from "./drag-source-resolver";
import {
  resolveDraggedBlockPromotionTitle,
  resolveTopLevelDraggedBlocks,
  type DraggableEditorBlock,
} from "./dragged-block-roots";
import { endProjectionBlockDrag, startProjectionBlockDrag } from "./projection-drag-handle";
import { finalizeSideMenuBlockDrag } from "./side-menu-drag-lifecycle";

describe("Block tree ancestry", () => {
  test("finds a stable-ID ancestor without depending on mounted DOM", () => {
    const parents = new Map([
      ["leaf", { id: "nested" }],
      ["nested", { id: "owner" }],
    ]);
    expect(isBlockWithinOwnerTree((id) => parents.get(id), "owner", "leaf")).toBe(true);
    expect(isBlockWithinOwnerTree((id) => parents.get(id), "other", "leaf")).toBe(false);
  });

  test("fails closed for malformed ancestry cycles", () => {
    const parents = new Map([
      ["a", { id: "b" }],
      ["b", { id: "a" }],
    ]);
    expect(isBlockWithinOwnerTree((id) => parents.get(id), "owner", "a")).toBe(false);
  });
});

describe("drag source resolver", () => {
  test("prefers ProseMirror multi-node selection IDs", () => {
    const editor = {
      prosemirrorView: {
        state: {
          selection: {
            nodes: [{ attrs: { id: "a" } }, { attrs: { id: "b" } }],
          },
        },
      },
      getSelection: () => ({ blocks: [{ id: "fallback" }] }),
    };

    const container = {
      querySelector: () => null,
    } as unknown as HTMLElement;

    expect(JSON.stringify(resolveDraggedBlockIds(editor, container))).toBe(
      JSON.stringify(["a", "b"]),
    );
  });

  test("falls back to ProseMirror node selection ID", () => {
    const editor = {
      prosemirrorView: {
        state: {
          selection: {
            node: { attrs: { id: "single" } },
          },
        },
      },
      getSelection: () => ({ blocks: [{ id: "fallback" }] }),
    };

    const container = {
      querySelector: () => null,
    } as unknown as HTMLElement;

    expect(JSON.stringify(resolveDraggedBlockIds(editor, container))).toBe(
      JSON.stringify(["single"]),
    );
  });

  test("uses editor block selection when ProseMirror selection has no IDs", () => {
    const editor = {
      prosemirrorView: {
        state: {
          selection: {},
        },
      },
      getSelection: () => ({ blocks: [{ id: "one" }, { id: "two" }] }),
    };

    const container = {
      querySelector: () => null,
    } as unknown as HTMLElement;

    expect(JSON.stringify(resolveDraggedBlockIds(editor, container))).toBe(
      JSON.stringify(["one", "two"]),
    );
  });

  test("falls back to ProseMirror selected DOM node", () => {
    const selected = {
      matches: (selector: string) => selector === ".bn-block[data-id]",
      getAttribute: (name: string) => (name === "data-id" ? "selected-node" : null),
      querySelector: () => null,
      closest: () => null,
    } as unknown as HTMLElement;

    const editor = {
      prosemirrorView: {
        state: {
          selection: {},
        },
      },
      getSelection: () => undefined,
    };

    const container = {
      querySelector: (selector: string) =>
        selector === ".ProseMirror-selectednode" ? selected : null,
    } as unknown as HTMLElement;

    expect(JSON.stringify(resolveDraggedBlockIds(editor, container))).toBe(
      JSON.stringify(["selected-node"]),
    );
  });

  test("resolves element from text-like target parent", () => {
    const target = { parentElement: { closest: () => null } } as unknown as EventTarget;
    expect(getElementFromTarget(target)).not.toBeNull();
  });
});

describe("dragged Block roots", () => {
  test("does not duplicate a selected descendant", () => {
    const child: DraggableEditorBlock = {
      id: "child",
      type: "paragraph",
      content: "Child",
    };
    const root: DraggableEditorBlock = {
      id: "root",
      type: "paragraph",
      content: "Root",
      children: [child],
    };
    const byId = new Map([
      [root.id, root],
      [child.id, child],
    ]);
    expect(
      resolveTopLevelDraggedBlocks(
        {
          getBlock: (id) => byId.get(id),
          getParentBlock: (id) => (id === child.id ? root : undefined),
        },
        [root.id, child.id],
      ).map((block) => block.id),
    ).toEqual([root.id]);
  });

  test("uses Page authority for a Page shell promotion title", () => {
    const page: DraggableEditorBlock = {
      id: "page-1",
      type: "page",
    };

    expect(resolveDraggedBlockPromotionTitle(page, () => "Owned Page title")).toBe(
      "Owned Page title",
    );
    expect(resolveDraggedBlockPromotionTitle(page, () => null)).toBe("Untitled");
  });

  test("keeps ordinary Block promotion titles inline", () => {
    const paragraph: DraggableEditorBlock = {
      id: "paragraph-1",
      type: "paragraph",
      content: [{ type: "text", text: "Inline " }, { label: "title" }],
    };

    expect(resolveDraggedBlockPromotionTitle(paragraph, () => "Wrong Page title")).toBe(
      "Inline title",
    );
  });
});

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

    expect(started).toBe(false);
    expect(prevented).toBe(true);
  });

  test("starts drag with freshest block from editor when available", () => {
    let draggedBlock: unknown;
    const storedBlock = { id: "owner", type: "pageRef", props: { sourceProjectId: "default" } };
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

    expect(started).toBe(true);
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

    const started = startProjectionBlockDrag(editor, fallbackBlock, {
      dataTransfer: null,
      clientY: 8,
      preventDefault: () => {},
    });

    expect(started).toBe(true);
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
    expect(ended).toBe(true);
  });
});

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

    finalizeSideMenuBlockDrag(editor as unknown as Parameters<typeof finalizeSideMenuBlockDrag>[0]);

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(blockDragEnded).toBe(true);
  });

  test("removes orphaned drag previews when blockDragEnd is unavailable", () => {
    let removed = 0;
    const editor = {
      prosemirrorView: {
        dragging: { id: "dragging" },
        root: {
          querySelectorAll: () => [
            {
              remove: () => {
                removed += 1;
              },
            },
            {
              remove: () => {
                removed += 1;
              },
            },
          ],
        },
      },
      getExtension: () => null,
    };

    finalizeSideMenuBlockDrag(editor as unknown as Parameters<typeof finalizeSideMenuBlockDrag>[0]);

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(removed).toBe(2);
  });

  test("does not throw when Tiptap root is unavailable during unmount cleanup", () => {
    let blockDragEnded = false;
    const editor = {
      prosemirrorView: {
        dragging: { id: "dragging" },
        get root(): Document | ShadowRoot {
          throw new Error("[tiptap error]: The editor view is not available.");
        },
      },
      getExtension: () => ({
        blockDragEnd: () => {
          blockDragEnded = true;
        },
      }),
    };

    finalizeSideMenuBlockDrag(editor as unknown as Parameters<typeof finalizeSideMenuBlockDrag>[0]);

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(blockDragEnded).toBe(false);
  });
});
