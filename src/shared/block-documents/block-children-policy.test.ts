import { describe, expect, test } from "vitest";
import normalizationFixtures from "./block-children-normalization-v1.json";
import {
  acceptsBlockChildren,
  assertBlockChildrenContract,
  BlockChildrenContractError,
  CURRENT_BLOCK_TYPES,
  getBlockChildrenRule,
  normalizeBlockChildrenForest,
  type BlockChildrenNode,
} from "./block-children-policy";

interface TestBlock extends BlockChildrenNode {
  readonly id: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly TestBlock[];
}

const block = (
  id: string,
  type: string,
  children: readonly TestBlock[] = [],
  props: Readonly<Record<string, unknown>> = {},
): TestBlock => ({ id, type, props, children });

describe("block children contract", () => {
  test("covers the complete current Block vocabulary", () => {
    expect(CURRENT_BLOCK_TYPES).toEqual([
      "paragraph",
      "heading",
      "bulletListItem",
      "numberedListItem",
      "checkListItem",
      "toggleListItem",
      "codeBlock",
      "mathBlock",
      "table",
      "quote",
      "divider",
      "image",
      "callout",
      "page",
      "database",
      "canvas",
      "databaseViewRef",
      "pageRef",
      "syncedBlockRef",
      "templateRef",
    ]);
    expect(() => getBlockChildrenRule("obsoleteBlock")).toThrow(BlockChildrenContractError);
  });

  test("allows only toggleable headings to own children", () => {
    expect(acceptsBlockChildren(block("normal", "heading"))).toBe(false);
    expect(acceptsBlockChildren(block("toggle", "heading", [], { isToggleable: true }))).toBe(true);
  });

  test("lifts forbidden children immediately after their parent without losing order", () => {
    const a = block("a", "paragraph");
    const b = block("b", "callout", [block("nested", "paragraph")]);
    const source = [block("code", "codeBlock", [a, b]), block("c", "paragraph")];

    const result = normalizeBlockChildrenForest(source);

    expect(result.changed).toBe(true);
    expect(result.liftedRoots).toBe(2);
    expect(result.blocks.map(({ id }) => id)).toEqual(["code", "a", "b", "c"]);
    expect(result.blocks[0]?.children).toEqual([]);
    expect(result.blocks[2]).toBe(b);
  });

  test("normalizes nested forbidden chains in visible depth-first order", () => {
    const source = [
      block("image", "image", [block("code", "codeBlock", [block("content", "paragraph")])]),
    ];

    const result = normalizeBlockChildrenForest(source);

    expect(result.blocks.map(({ id }) => id)).toEqual(["image", "code", "content"]);
    // `content` crosses two forbidden parent edges, so the migration records
    // three root promotions while preserving three distinct Blocks.
    expect(result.liftedRoots).toBe(3);
    expect(result.blocks.every(({ children }) => children.length === 0)).toBe(true);
  });

  test("normalizes a ten-thousand-level forbidden chain without recursion", () => {
    let root = block("content", "paragraph");
    for (let index = 9_999; index >= 0; index -= 1) {
      root = block(`code-${index}`, "codeBlock", [root]);
    }

    const result = normalizeBlockChildrenForest([root]);

    expect(result.blocks).toHaveLength(10_001);
    expect(result.blocks[0]?.id).toBe("code-0");
    expect(result.blocks.at(-1)?.id).toBe("content");
    expect(result.liftedRoots).toBe(50_005_000);
    expect(result.blocks.every(({ children }) => children.length === 0)).toBe(true);
  });

  test("preserves valid object identity and is idempotent", () => {
    const source = [
      block("callout", "callout", [block("paragraph", "paragraph")]),
      block("divider", "divider"),
    ];

    const first = normalizeBlockChildrenForest(source);
    const second = normalizeBlockChildrenForest(first.blocks);

    expect(first).toMatchObject({ changed: false, liftedRoots: 0 });
    expect(first.blocks).toBe(source);
    expect(second).toMatchObject({ changed: false, liftedRoots: 0 });
    expect(second.blocks).toBe(source);
    expect(() => assertBlockChildrenContract(source)).not.toThrow();
  });

  test("reports an invalid tree without silently hiding children", () => {
    const source = [block("image", "image", [block("body", "paragraph")])];
    expect(() => assertBlockChildrenContract(source)).toThrow(
      "Block image must not contain generic child Blocks",
    );
  });

  test("matches the cross-runtime normalization fixtures", () => {
    expect(normalizationFixtures.contractVersion).toBe(1);
    for (const fixture of normalizationFixtures.cases) {
      const result = normalizeBlockChildrenForest(fixture.input);
      expect(result.blocks, fixture.name).toEqual(fixture.expected);
      expect(result.liftedRoots, fixture.name).toBe(fixture.liftedRoots);
    }
  });
});
