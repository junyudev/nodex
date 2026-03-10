import { describe, expect, test } from "bun:test";
import {
  getElementFromTarget,
  resolveDraggedBlockIds,
} from "./drag-source-resolver";

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
