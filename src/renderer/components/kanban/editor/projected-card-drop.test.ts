import { describe, expect, test } from "bun:test";
import {
  materializeProjectedCardToggleBlock,
  resolveProjectedCardDropSource,
} from "./projected-card-drop";
import {
  PROJECTION_CARD_ID_PROP,
  PROJECTION_KIND_PROP,
  PROJECTION_OWNER_PROP,
  PROJECTION_SOURCE_PROJECT_PROP,
} from "./projection-card-toggle";
import type { DragSessionBlock } from "./external-block-drag-session";

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

describe("projected card drop helpers", () => {
  test("resolves projected source metadata from projected card toggle props", () => {
    const projectedBlock = makeBlock({
      id: "projected-1",
      type: "cardToggle",
      props: {
        cardId: "card-123",
        sourceProjectId: "default",
        sourceColumnId: "6-in-progress",
        [PROJECTION_OWNER_PROP]: "owner-1",
        [PROJECTION_SOURCE_PROJECT_PROP]: "default",
        [PROJECTION_CARD_ID_PROP]: "card-123",
      },
    });

    expect(
      JSON.stringify(resolveProjectedCardDropSource(projectedBlock)),
    ).toBe(JSON.stringify({
      ownerBlockId: "owner-1",
      sourceProjectId: "default",
      sourceCardId: "card-123",
      sourceColumnId: "6-in-progress",
    }));
  });

  test("returns null for non-projected card toggles", () => {
    const nonProjected = makeBlock({
      id: "toggle-1",
      type: "cardToggle",
      props: {
        cardId: "card-123",
        sourceProjectId: "default",
      },
    });

    expect(resolveProjectedCardDropSource(nonProjected) === null).toBeTrue();
  });

  test("materializes projected card toggle by stripping projection metadata", () => {
    const projectedBlock = makeBlock({
      id: "projected-1",
      type: "cardToggle",
      props: {
        cardId: "card-123",
        meta: "[P1]",
        sourceProjectId: "default",
        sourceColumnId: "6-in-progress",
        [PROJECTION_OWNER_PROP]: "owner-1",
        [PROJECTION_SOURCE_PROJECT_PROP]: "default",
        [PROJECTION_CARD_ID_PROP]: "card-123",
        [PROJECTION_KIND_PROP]: "toggleListInlineView",
      },
      content: [{ type: "text", text: "Dragged title" }],
      children: [{ id: "child-1", type: "paragraph", content: [{ type: "text", text: "Body" }], children: [] }],
    });

    const source = resolveProjectedCardDropSource(projectedBlock);
    if (!source) throw new Error("expected projected source metadata");

    const materialized = materializeProjectedCardToggleBlock(projectedBlock, source);
    expect("id" in materialized).toBeFalse();
    expect(materialized.type).toBe("cardToggle");
    expect(materialized.props?.cardId).toBe("card-123");
    expect(materialized.props?.sourceProjectId).toBe("default");
    expect(materialized.props?.sourceColumnId).toBe("6-in-progress");
    expect(materialized.props?.[PROJECTION_OWNER_PROP] === undefined).toBeTrue();
    expect(materialized.props?.[PROJECTION_SOURCE_PROJECT_PROP] === undefined).toBeTrue();
    expect(materialized.props?.[PROJECTION_CARD_ID_PROP] === undefined).toBeTrue();
    expect(materialized.props?.[PROJECTION_KIND_PROP] === undefined).toBeTrue();
    expect(JSON.stringify(materialized.content)).toBe(
      JSON.stringify(projectedBlock.content),
    );
    expect(JSON.stringify(materialized.children)).toBe(
      JSON.stringify(projectedBlock.children),
    );
  });
});
