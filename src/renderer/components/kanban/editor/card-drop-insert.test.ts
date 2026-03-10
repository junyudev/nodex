import { describe, expect, test } from "bun:test";
import {
  insertCardTogglesAtPointer,
  insertCardToggleAtPointer,
  resolveCardDropIndicatorPosition,
  type EditorForCardDropInsert,
} from "./card-drop-insert";

function createBlockElement(id: string, top: number, height: number): HTMLElement {
  const element = {
    matches: (selector: string) => selector === ".bn-block[data-id]",
    getAttribute: (name: string) => (name === "data-id" ? id : null),
    querySelector: () => null,
    closest: (selector: string) => (selector === ".bn-block[data-id]" ? element : null),
    getBoundingClientRect: () => ({
      top,
      left: 0,
      width: 100,
      height,
      right: 100,
      bottom: top + height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  };

  return element as unknown as HTMLElement;
}

function createContainer(elements: HTMLElement[]): HTMLElement {
  return {
    ownerDocument: {
      elementsFromPoint: () => elements,
    },
    contains: () => true,
    querySelectorAll: () => elements,
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      width: 320,
      height: 240,
      right: 320,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    clientWidth: 320,
  } as unknown as HTMLElement;
}

function createEditor(
  blocks: Array<{ id: string; type: string; children?: Array<{ id: string; type: string }> }>,
): EditorForCardDropInsert & {
  insertCalls: Array<{ reference: string; placement: "before" | "after" }>;
  replaceCalls: Array<{ toRemove: unknown[]; replacements: unknown[] }>;
} {
  const byId = new Map<string, { id: string; type: string; children?: Array<{ id: string; type: string }> }>();
  const parentById = new Map<string, { id: string; type: string; children?: Array<{ id: string; type: string }> }>();

  for (const block of blocks) {
    byId.set(block.id, block);
    for (const child of block.children ?? []) {
      byId.set(child.id, child);
      parentById.set(child.id, block);
    }
  }

  const insertCalls: Array<{ reference: string; placement: "before" | "after" }> = [];
  const replaceCalls: Array<{ toRemove: unknown[]; replacements: unknown[] }> = [];

  return {
    document: blocks as Array<{ id: string; type: string; children?: Array<{ id: string; type: string }> }>,
    insertCalls,
    replaceCalls,
    getBlock(id) {
      return byId.get(id) as { id: string; type: string; children?: Array<{ id: string; type: string }> } | undefined;
    },
    getParentBlock(id) {
      return parentById.get(id) as { id: string; type: string; children?: Array<{ id: string; type: string }> } | undefined;
    },
    insertBlocks(_blocks, referenceBlock, placement) {
      insertCalls.push({ reference: referenceBlock, placement });
    },
    replaceBlocks(toRemove, replacements) {
      replaceCalls.push({ toRemove, replacements });
    },
  };
}

describe("card drop insert", () => {
  test("inserts before or after anchor based on pointer midpoint", () => {
    const blockEl = createBlockElement("target", 100, 40);
    const container = createContainer([blockEl]);
    const editor = createEditor([{ id: "target", type: "paragraph" }]);

    const insertedAtTop = insertCardToggleAtPointer(
      editor,
      container,
      { x: 10, y: 110 },
      { id: "new", type: "cardToggle" },
    );
    const insertedAtBottom = insertCardToggleAtPointer(
      editor,
      container,
      { x: 10, y: 135 },
      { id: "new-2", type: "cardToggle" },
    );

    expect(insertedAtTop).toBeTrue();
    expect(insertedAtBottom).toBeTrue();
    expect(JSON.stringify(editor.insertCalls[0])).toBe(
      JSON.stringify({ reference: "target", placement: "before" }),
    );
    expect(JSON.stringify(editor.insertCalls[1])).toBe(
      JSON.stringify({ reference: "target", placement: "after" }),
    );
  });

  test("inserts into empty document via replaceBlocks", () => {
    const container = createContainer([]);
    const editor = createEditor([]);

    const inserted = insertCardToggleAtPointer(
      editor,
      container,
      { x: 10, y: 10 },
      { id: "new", type: "cardToggle" },
    );

    expect(inserted).toBeTrue();
    expect(editor.replaceCalls.length).toBe(1);
  });

  test("inline mode inserts into target cardToggle children only", () => {
    const rootEl = createBlockElement("root", 100, 40);
    const container = createContainer([rootEl]);
    const editor = createEditor([{ id: "root", type: "cardToggle", children: [] }]);

    const inserted = insertCardToggleAtPointer(
      editor,
      container,
      { x: 10, y: 110 },
      { id: "new", type: "cardToggle" },
      { inlineOnly: true },
    );

    expect(inserted).toBeTrue();
    expect(editor.replaceCalls.length).toBe(1);
  });

  test("can insert multiple card toggles in one operation", () => {
    const blockEl = createBlockElement("target", 100, 40);
    const container = createContainer([blockEl]);
    const editor = createEditor([{ id: "target", type: "paragraph" }]);

    const inserted = insertCardTogglesAtPointer(
      editor,
      container,
      { x: 10, y: 110 },
      [
        { id: "new-1", type: "cardToggle" },
        { id: "new-2", type: "cardToggle" },
      ],
    );

    expect(inserted).toBeTrue();
    expect(editor.insertCalls.length).toBe(1);
    expect(JSON.stringify(editor.insertCalls[0])).toBe(
      JSON.stringify({ reference: "target", placement: "before" }),
    );
  });

  test("resolves indicator via block midline fallback when pointer is over gap", () => {
    const topBlock = createBlockElement("top", 20, 30);
    const bottomBlock = createBlockElement("bottom", 80, 30);
    const container = createContainer([topBlock, bottomBlock]);
    container.ownerDocument.elementsFromPoint = () => [];
    const editor = createEditor([
      { id: "top", type: "paragraph" },
      { id: "bottom", type: "paragraph" },
    ]);

    const indicator = resolveCardDropIndicatorPosition(
      editor,
      container,
      { x: 10, y: 70 },
    );

    expect(indicator).not.toBeNull();
    expect(indicator?.top).toBe(80);
  });
});
