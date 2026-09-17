import { describe, expect, test } from "vite-plus/test";
import {
  resolveDraggedBlockPromotionTitle,
  resolveTopLevelDraggedBlocks,
  type DraggableEditorBlock,
} from "./dragged-block-roots";

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
