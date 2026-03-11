import { describe, expect, test } from "bun:test";
import type { ToggleListCard } from "../../../lib/toggle-list/types";
import {
  PROJECTION_OWNER_PROP,
  PROJECTION_CARD_ID_PROP,
  PROJECTION_SOURCE_PROJECT_PROP,
  buildProjectedChildren,
  buildProjectedCardToggleBlock,
  collectProjectedCardPatchesForOwner,
  hasRecursiveCardRefAncestor,
  hasRecursiveInlineProjectAncestor,
  isProjectedCardToggleBlock,
  makeProjectedCardToggleBlockId,
  serializeProjectionRows,
  splitEmbedChildren,
  stripProjectedSubtrees,
} from "./projection-card-toggle";

function makeCard(overrides: Partial<ToggleListCard> = {}): ToggleListCard {
  return {
    id: "card-1",
    status: "backlog",
    archived: false,
    title: "Example card",
    description: "First paragraph",
    priority: "p1-high",
    estimate: "m",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-10T00:00:00.000Z"),
    order: 0,
    columnId: "backlog",
    columnName: "Ready",
    boardIndex: 1,
    ...overrides,
  };
}

describe("projection card toggle helpers", () => {
  test("projected id is deterministic and owner-scoped", () => {
    const first = makeProjectedCardToggleBlockId("embed-1", "default", "abc");
    const second = makeProjectedCardToggleBlockId("embed-1", "default", "abc");
    const third = makeProjectedCardToggleBlockId("embed-2", "default", "abc");

    expect(first).toBe(second);
    expect(first === third).toBeFalse();
  });

  test("buildProjectedCardToggleBlock marks projection metadata", () => {
    const block = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({ id: "abc" }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    }) as { props?: Record<string, unknown> };

    expect(isProjectedCardToggleBlock(block, "embed-1")).toBeTrue();
    expect(block.props?.[PROJECTION_OWNER_PROP]).toBe("embed-1");
    expect(block.props?.[PROJECTION_CARD_ID_PROP]).toBe("abc");
    expect(block.props?.[PROJECTION_SOURCE_PROJECT_PROP]).toBe("default");
  });

  test("serializeProjectionRows ignores volatile ids and keeps semantic equality", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({
        id: "abc",
        title: "Projected title",
        description: "- child item",
      }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    }) as {
      id?: string;
      children?: Array<{ id?: string; [key: string]: unknown }>;
    };

    const sameSemanticDifferentIds: {
      id?: string;
      children?: Array<{ id?: string; [key: string]: unknown }>;
    } = {
      ...projected,
      id: "different-root-id",
      children: projected.children?.map((child, index) => ({
        ...child,
        id: `different-child-${index}`,
      })),
    };

    const first = serializeProjectionRows([projected]);
    const second = serializeProjectionRows([sameSemanticDifferentIds]);

    expect(first).toBe(second);
  });

  test("splitEmbedChildren separates projected rows from host children", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({ id: "abc" }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    });

    const host = { id: "host-1", type: "paragraph", content: "Host" };

    const split = splitEmbedChildren([projected, host], "embed-1");
    expect(split.projectedRows.length).toBe(1);
    expect(split.hostChildren.length).toBe(1);
  });

  test("buildProjectedChildren keeps only projected rows", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({ id: "abc" }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    }) as {
      props?: Record<string, unknown>;
      content?: unknown;
      children?: unknown[];
    };

    const leaked = {
      id: "legacy-leaked",
      type: "cardToggle",
      props: {
        cardId: "abc",
        sourceProjectId: "default",
        meta: "[P1] [Backlog]",
      },
      content: projected.content,
      children: projected.children,
    };

    const hostParagraph = { id: "host-1", type: "paragraph", content: "Host" };
    const merged = buildProjectedChildren("embed-1", [projected], [leaked, hostParagraph]);
    expect(merged.length).toBe(1);
    expect((merged[0] as { type?: string })?.type).toBe("cardToggle");
  });

  test("collectProjectedCardPatchesForOwner extracts text + chip-editable fields", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "toggleListInlineView",
      sourceProjectId: "default",
      card: makeCard({
        id: "abc",
        title: "Projected title",
        description: "Projected description",
      }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    });

    const patches = collectProjectedCardPatchesForOwner([projected], "embed-1");
    expect(patches.length).toBe(1);
    expect(patches[0]?.cardId).toBe("abc");
    expect(patches[0]?.sourceProjectId).toBe("default");
    expect(patches[0]?.updates.title).toBe("Projected title");
    expect(patches[0]?.updates.description).toBe("Projected description");
    expect(patches[0]?.updates.priority).toBe("p1-high");
    expect(patches[0]?.updates.estimate).toBe("m");
    expect(patches[0]?.targetStatus).toBe(undefined);
  });

  test("collectProjectedCardPatchesForOwner strips nested projected rows from description", () => {
    const nestedProjected = buildProjectedCardToggleBlock({
      ownerBlockId: "nested-owner",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({
        id: "nested",
        title: "Nested projected title",
      }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    });

    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({
        id: "abc",
        title: "Projected title",
      }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    }) as {
      children?: unknown[];
    };

    projected.children = [
      {
        id: "nested-ref",
        type: "cardRef",
        props: {
          sourceProjectId: "default",
          cardId: "nested",
        },
        children: [nestedProjected],
      },
    ];

    const patches = collectProjectedCardPatchesForOwner([projected], "embed-1");
    expect(patches.length).toBe(1);
    expect(patches[0]?.updates.description).toBe('<card-ref project="default" card="nested" />');
  });

  test("stripProjectedSubtrees removes projected rows recursively", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({ id: "abc" }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    });

    const tree = [
      {
        id: "card-ref-block",
        type: "cardRef",
        children: [
          projected,
          { id: "host-child", type: "paragraph", content: "Host" },
        ],
      },
    ];

    const stripped = stripProjectedSubtrees(tree) as Array<{ children?: unknown[] }>;
    const children = stripped[0]?.children ?? [];
    expect(children.length).toBe(1);
    expect((children[0] as { id?: string })?.id).toBe("host-child");
  });

  test("stripProjectedSubtrees also removes leaked unmarked duplicates beside projected rows", () => {
    const projected = buildProjectedCardToggleBlock({
      ownerBlockId: "embed-1",
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card: makeCard({ id: "abc" }),
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
    });

    const leaked = {
      id: "legacy-leaked",
      type: "cardToggle",
      props: {
        cardId: "abc",
        sourceProjectId: "default",
        meta: "[P1] [Backlog]",
      },
      children: [],
    };

    const tree = [
      {
        id: "card-ref-block",
        type: "cardRef",
        children: [
          projected,
          leaked,
          { id: "host-child", type: "paragraph", content: "Host" },
        ],
      },
    ];

    const stripped = stripProjectedSubtrees(tree) as Array<{ children?: unknown[] }>;
    const children = stripped[0]?.children ?? [];
    expect(children.length).toBe(1);
    expect((children[0] as { id?: string })?.id).toBe("host-child");
  });

  test("recursive ancestor detection for cardRef checks projected ancestors", () => {
    const projectedParent = {
      id: "parent",
      type: "cardToggle",
      props: {
        [PROJECTION_SOURCE_PROJECT_PROP]: "default",
        [PROJECTION_CARD_ID_PROP]: "abc",
      },
    };

    const parents = new Map<string, unknown>([
      ["leaf", projectedParent],
      ["parent", null],
    ]);

    const editor = {
      getBlock: () => undefined,
      getParentBlock: (id: string) => parents.get(id),
    };

    expect(hasRecursiveCardRefAncestor(editor, "leaf", "default:abc")).toBeTrue();
  });

  test("recursive ancestor detection for inline project checks ancestor inline blocks", () => {
    const inlineParent = {
      id: "inline-parent",
      type: "toggleListInlineView",
      props: {
        sourceProjectId: "default",
      },
    };

    const parents = new Map<string, unknown>([
      ["leaf", inlineParent],
      ["inline-parent", null],
    ]);

    const editor = {
      getParentBlock: (id: string) => parents.get(id),
    };

    expect(hasRecursiveInlineProjectAncestor(editor, "leaf", "default")).toBeTrue();
  });
});
