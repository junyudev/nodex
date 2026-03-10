import { describe, expect, test } from "bun:test";
import { blockNoteToNfm, serializeNfm } from "../../../lib/nfm";
import {
  mapDraggedBlocksToCardInputs,
  resolveTopLevelDraggedBlocks,
} from "./block-drop-card-mapper";
import { encodeCardToggleSnapshot } from "./card-toggle-snapshot";
import type {
  DragSessionBlock,
  EditorForExternalBlockDrop,
} from "./external-block-drag-session";

function makeBlock(
  block: Partial<DragSessionBlock> & Pick<DragSessionBlock, "id" | "type">,
): DragSessionBlock {
  return {
    id: block.id,
    type: block.type,
    props: block.props ?? {},
    content: block.content ?? [],
    children: block.children ?? [],
  };
}

function createEditor(blocks: DragSessionBlock[]): EditorForExternalBlockDrop {
  const byId = new Map<string, DragSessionBlock>();
  const parentById = new Map<string, DragSessionBlock>();

  const walk = (items: DragSessionBlock[], parent?: DragSessionBlock) => {
    for (const item of items) {
      byId.set(item.id, item);
      if (parent) parentById.set(item.id, parent);
      walk(item.children ?? [], item);
    }
  };
  walk(blocks);

  return {
    document: blocks,
    getBlock(id) {
      return byId.get(id);
    },
    getParentBlock(id) {
      return parentById.get(id);
    },
    removeBlocks() {},
    replaceBlocks() {},
  };
}

describe("block drop card mapper", () => {
  test("maps text-like block to title and children-only description", () => {
    const child = makeBlock({
      id: "child",
      type: "paragraph",
      content: [{ type: "text", text: "Child text" }],
    });
    const parent = makeBlock({
      id: "parent",
      type: "paragraph",
      content: [{ type: "text", text: "Parent title" }],
      children: [child],
    });

    const result = mapDraggedBlocksToCardInputs([parent]);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe("Parent title");
    expect(result[0].description).toBe(serializeNfm(blockNoteToNfm([child])));
  });

  test("maps heading with children like text-like blocks", () => {
    const child = makeBlock({
      id: "h-child",
      type: "paragraph",
      content: [{ type: "text", text: "Details" }],
    });
    const heading = makeBlock({
      id: "heading",
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: "Heading title" }],
      children: [child],
    });

    const result = mapDraggedBlocksToCardInputs([heading]);
    expect(result[0].title).toBe("Heading title");
    expect(result[0].description).toBe(serializeNfm(blockNoteToNfm([child])));
  });

  test("uses fallback title and preserves full non-text block in description", () => {
    const codeBlock = makeBlock({
      id: "code",
      type: "codeBlock",
      props: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
    const image = makeBlock({
      id: "image",
      type: "image",
      props: { url: "https://example.com/a.png", caption: "caption" },
    });
    const divider = makeBlock({
      id: "divider",
      type: "divider",
    });

    const result = mapDraggedBlocksToCardInputs([codeBlock, image, divider]);

    expect(result[0].title).toBe("Code block");
    expect(result[1].title).toBe("Image");
    expect(result[2].title).toBe("Divider");
    expect(result[0].description).toBe(serializeNfm(blockNoteToNfm([codeBlock])));
    expect(result[1].description).toBe(serializeNfm(blockNoteToNfm([image])));
    expect(result[2].description).toBe(serializeNfm(blockNoteToNfm([divider])));
  });

  test("keeps selection order for multi-block mapping", () => {
    const first = makeBlock({
      id: "a",
      type: "paragraph",
      content: [{ type: "text", text: "Alpha" }],
    });
    const second = makeBlock({
      id: "b",
      type: "paragraph",
      content: [{ type: "text", text: "Beta" }],
    });

    const result = mapDraggedBlocksToCardInputs([first, second]);
    expect(JSON.stringify(result.map((card) => card.title))).toBe(
      JSON.stringify(["Alpha", "Beta"]),
    );
  });

  test("parses strict smart prefixes into card properties", () => {
    const blocks = [
      makeBlock({
        id: "p1-xl-tag",
        type: "paragraph",
        content: [{ type: "text", text: "1XL(thread) Build import parser" }],
      }),
      makeBlock({
        id: "p2-s",
        type: "paragraph",
        content: [{ type: "text", text: "2S Tighten tests" }],
      }),
      makeBlock({
        id: "p2-tag",
        type: "paragraph",
        content: [{ type: "text", text: "2(editor) Polish editor flow" }],
      }),
      makeBlock({
        id: "p0",
        type: "paragraph",
        content: [{ type: "text", text: "0 Urgent hotfix" }],
      }),
      makeBlock({
        id: "p1",
        type: "paragraph",
        content: [{ type: "text", text: "1 Investigate race condition" }],
      }),
      makeBlock({
        id: "p2-xl-colon",
        type: "paragraph",
        content: [{ type: "text", text: "2XL: Build migration plan" }],
      }),
      makeBlock({
        id: "p4-l-colon",
        type: "paragraph",
        content: [{ type: "text", text: "4L: Cleanup follow-up" }],
      }),
    ];

    const result = mapDraggedBlocksToCardInputs(blocks, {
      smartPrefixParsingEnabled: true,
      stripSmartPrefixFromTitleEnabled: true,
    });

    expect(result[0]?.title).toBe("Build import parser");
    expect(result[0]?.priority).toBe("p1-high");
    expect(result[0]?.estimate).toBe("xl");
    expect(JSON.stringify(result[0]?.tags)).toBe(JSON.stringify(["thread"]));
    expect(result[1]?.title).toBe("Tighten tests");
    expect(result[1]?.priority).toBe("p2-medium");
    expect(result[1]?.estimate).toBe("s");
    expect(result[2]?.title).toBe("Polish editor flow");
    expect(result[2]?.priority).toBe("p2-medium");
    expect(JSON.stringify(result[2]?.tags)).toBe(JSON.stringify(["editor"]));
    expect(result[3]?.title).toBe("Urgent hotfix");
    expect(result[3]?.priority).toBe("p0-critical");
    expect(result[4]?.title).toBe("Investigate race condition");
    expect(result[4]?.priority).toBe("p1-high");
    expect(result[5]?.title).toBe("Build migration plan");
    expect(result[5]?.priority).toBe("p2-medium");
    expect(result[5]?.estimate).toBe("xl");
    expect(result[6]?.title).toBe("Cleanup follow-up");
    expect(result[6]?.priority).toBe("p4-later");
    expect(result[6]?.estimate).toBe("l");
  });

  test("does not parse near-prefix or malformed prefix values", () => {
    const blocks = [
      makeBlock({
        id: "near-prefix",
        type: "paragraph",
        content: [{ type: "text", text: "2fa auth hardening" }],
      }),
      makeBlock({
        id: "malformed-paren",
        type: "paragraph",
        content: [{ type: "text", text: "2(thread broken tag" }],
      }),
    ];

    const result = mapDraggedBlocksToCardInputs(blocks, {
      smartPrefixParsingEnabled: true,
      stripSmartPrefixFromTitleEnabled: true,
    });

    expect(result[0]?.title).toBe("2fa auth hardening");
    expect("priority" in result[0]).toBeFalse();
    expect(result[1]?.title).toBe("2(thread broken tag");
    expect("priority" in result[1]).toBeFalse();
  });

  test("keeps original title when stripped prefix would be empty", () => {
    const block = makeBlock({
      id: "prefix-only",
      type: "paragraph",
      content: [{ type: "text", text: "2XL:" }],
    });

    const [result] = mapDraggedBlocksToCardInputs([block], {
      smartPrefixParsingEnabled: true,
      stripSmartPrefixFromTitleEnabled: true,
    });

    expect(result.title).toBe("2XL:");
    expect(result.priority).toBe("p2-medium");
    expect(result.estimate).toBe("xl");
  });

  test("respects smart parsing toggle off", () => {
    const block = makeBlock({
      id: "parsing-off",
      type: "paragraph",
      content: [{ type: "text", text: "1XL(thread) Keep full text" }],
    });

    const [result] = mapDraggedBlocksToCardInputs([block], {
      smartPrefixParsingEnabled: false,
      stripSmartPrefixFromTitleEnabled: true,
    });

    expect(result.title).toBe("1XL(thread) Keep full text");
    expect("priority" in result).toBeFalse();
    expect("estimate" in result).toBeFalse();
    expect("tags" in result).toBeFalse();
  });

  test("parses prefix but preserves full title when strip toggle is off", () => {
    const block = makeBlock({
      id: "strip-off",
      type: "paragraph",
      content: [{ type: "text", text: "2S Preserve title prefix" }],
    });

    const [result] = mapDraggedBlocksToCardInputs([block], {
      smartPrefixParsingEnabled: true,
      stripSmartPrefixFromTitleEnabled: false,
    });

    expect(result.title).toBe("2S Preserve title prefix");
    expect(result.priority).toBe("p2-medium");
    expect(result.estimate).toBe("s");
  });

  test("maps cardToggle block back to card input with snapshot defaults", () => {
    const snapshot = encodeCardToggleSnapshot({
      card: {
        title: "Original card",
        description: "Original description",
        priority: "p3-low",
        estimate: "l",
        tags: ["backend", "infra"],
        dueDate: "2026-02-10T00:00:00.000Z",
        assignee: "alex",
        agentBlocked: true,
      },
      projectId: "default",
      columnId: "3-backlog",
      columnName: "Backlog",
      capturedAt: "2026-02-10T00:00:00.000Z",
    });

    const child = makeBlock({
      id: "ct-child",
      type: "paragraph",
      content: [{ type: "text", text: "Nested body" }],
    });
    const cardToggle = makeBlock({
      id: "ct",
      type: "cardToggle",
      props: {
        cardId: "c-1",
        meta: "[P1] [M] [In Progress] [backend] [infra]",
        snapshot,
      },
      content: [{ type: "text", text: "Snapshot title" }],
      children: [child],
    });

    const [result] = mapDraggedBlocksToCardInputs([cardToggle]);
    expect(result.title).toBe("Snapshot title");
    expect(result.description).toBe(serializeNfm(blockNoteToNfm([child])));
    expect(result.priority).toBe("p1-high");
    expect(result.estimate).toBe("m");
    expect(JSON.stringify(result.tags)).toBe(JSON.stringify(["backend", "infra"]));
    expect(result.assignee).toBe("alex");
    expect(result.agentBlocked).toBeTrue();
    expect(result.dueDate?.toISOString()).toBe("2026-02-10T00:00:00.000Z");
  });

  test("does not smart-parse cardToggle title prefixes", () => {
    const cardToggle = makeBlock({
      id: "ct-prefix",
      type: "cardToggle",
      props: {
        cardId: "c-1",
        meta: "",
        snapshot: encodeCardToggleSnapshot({
          card: {
            title: "Original",
            priority: "p3-low",
          },
        }),
      },
      content: [{ type: "text", text: "1XL(thread) card toggle title" }],
    });

    const [result] = mapDraggedBlocksToCardInputs([cardToggle], {
      smartPrefixParsingEnabled: true,
      stripSmartPrefixFromTitleEnabled: true,
    });

    expect(result.title).toBe("1XL(thread) card toggle title");
    expect(result.priority).toBe("p3-low");
    expect(result.estimate).toBe(undefined);
    expect(result.tags).toBe(undefined);
  });

  test("filters dragged IDs to top-level entries only", () => {
    const child = makeBlock({
      id: "child",
      type: "paragraph",
      content: [{ type: "text", text: "Child" }],
    });
    const parent = makeBlock({
      id: "parent",
      type: "paragraph",
      content: [{ type: "text", text: "Parent" }],
      children: [child],
    });
    const sibling = makeBlock({
      id: "sibling",
      type: "paragraph",
      content: [{ type: "text", text: "Sibling" }],
    });

    const editor = createEditor([parent, sibling]);
    const result = resolveTopLevelDraggedBlocks(editor, [
      "parent",
      "child",
      "sibling",
    ]);
    expect(JSON.stringify(result.map((block) => block.id))).toBe(
      JSON.stringify(["parent", "sibling"]),
    );
  });
});
