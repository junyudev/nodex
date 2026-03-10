import { describe, expect, test } from "bun:test";
import { TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import {
  createCopiedSelectionPayloadFromSelection,
  createStructuredPlainTextPayload,
  resolveNormalizedSelectionBlocks,
  resolveStructuredPlainTextForSelection,
  rewriteAssetSources,
  rewriteCopiedSelectionAssetSources,
  rewriteCopiedSelectionAssetSourcesSync,
  writeCopiedSelectionToClipboard,
  type CopiedSelectionPayload,
  type SelectionEditorLike,
} from "./special-block-copy";

class FakeClipboardItem {
  constructor(public readonly data: Record<string, Blob>) {}
}

type TestSelectionBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown[];
  children?: TestSelectionBlock[];
} & Record<string, unknown>;

function renderVisibleSelectionText(blocks: TestSelectionBlock[], indent = 0): string {
  const lines: string[] = [];
  const indentation = "\t".repeat(indent);

  for (const block of blocks) {
    const type = block.type;
    const content = Array.isArray(block.content)
      ? block.content
        .map((item) => {
          if (typeof item !== "object" || item === null) return "";
          if ("text" in item && typeof item.text === "string") return item.text;
          return "";
        })
        .join("")
      : "";

    const prefix = type === "bulletListItem"
      ? `${indentation}- `
      : indentation;
    lines.push(prefix + content);

    if (Array.isArray(block.children) && block.children.length > 0) {
      lines.push(renderVisibleSelectionText(block.children as TestSelectionBlock[], indent + 1));
    }
  }

  return lines.join("\n");
}

function createSelectionEditorStub(
  selection: {
    blocks: TestSelectionBlock[];
    blockCutAtStart?: string;
    blockCutAtEnd?: string;
  },
  parentById: Record<string, TestSelectionBlock | undefined> = {},
): SelectionEditorLike {
  return {
    getSelectionCutBlocks: () => selection,
    getParentBlock: (id: string) => parentById[id],
    blocksToFullHTML: (blocks) => {
      return `<full>${renderVisibleSelectionText(blocks as TestSelectionBlock[])}</full>`;
    },
    blocksToHTMLLossy: (blocks) => {
      return `<external>${renderVisibleSelectionText(blocks as TestSelectionBlock[])}</external>`;
    },
  };
}

describe("special block copy", () => {
  test("resolveStructuredPlainTextForSelection returns fallback when no block selection exists", () => {
    const fallback = "- fallback";
    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => undefined,
      },
      fallback,
    );

    expect(value).toBe(fallback);
  });

  test("resolveStructuredPlainTextForSelection reconstructs structure from external HTML when selection snapshot is unavailable", () => {
    const fallback = "fallback";
    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => undefined,
        tryParseHTMLToBlocks: () => [
          {
            id: "block1",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "block1-line1\nblock1-line2", styles: {} }],
            children: [],
          },
          {
            id: "block2",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "block2", styles: {} }],
            children: [
              {
                id: "child-1",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "child", styles: {} }],
                children: [],
              },
            ],
          },
          {
            id: "empty",
            type: "paragraph",
            props: {},
            content: [],
            children: [],
          },
          {
            id: "block3",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "block3", styles: {} }],
            children: [],
          },
        ],
      },
      fallback,
      "<div>ignored-by-test-double</div>",
    );

    expect(value).toBe("block1-line1\nblock1-line2\nblock2\n\tchild\n\nblock3");
  });

  test("resolveStructuredPlainTextForSelection serializes top-level selected blocks only", () => {
    const child = {
      id: "child-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Child line", styles: {} }],
      children: [],
    };

    const parent = {
      id: "parent-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Parent line", styles: {} }],
      children: [child],
    };

    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => ({ blocks: [parent, child] }),
        getParentBlock: (id) => (id === child.id ? parent : undefined),
      },
      "fallback",
    );

    expect(value).toBe("Parent line\n\tChild line");
  });

  test("createStructuredPlainTextPayload preserves html and rewrites structured text only", () => {
    const payload = {
      clipboardHTML: "<div>clipboard</div>",
      externalHTML: "<div>external</div>",
      markdown: "fallback",
    };

    const parent = {
      id: "parent-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Parent line", styles: {} }],
      children: [
        {
          id: "child-1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Child line", styles: {} }],
          children: [],
        },
      ],
    };

    const nextPayload = createStructuredPlainTextPayload(payload, {
      getSelection: () => ({ blocks: [parent] }),
      getParentBlock: () => undefined,
    });

    expect(nextPayload.clipboardHTML).toBe(payload.clipboardHTML);
    expect(nextPayload.externalHTML).toBe(payload.externalHTML);
    expect(nextPayload.structuredText).toBe("Parent line\n\tChild line");
  });

  test("resolveNormalizedSelectionBlocks downgrades only the first cut wrapper block to paragraph", () => {
    const child = {
      id: "child-1",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "Child", styles: {} }],
      children: [],
    };
    const first = {
      id: "first",
      type: "bulletListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
        checked: true,
      },
      content: [{ type: "text", text: "first", styles: {} }],
      children: [child],
    };
    const second = {
      id: "second",
      type: "bulletListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "second", styles: {} }],
      children: [],
    };

    const blocks = resolveNormalizedSelectionBlocks(
      createSelectionEditorStub({
        blocks: [first, second],
        blockCutAtStart: "first",
        blockCutAtEnd: "second",
      }),
    );

    expect(blocks[0]?.type).toBe("paragraph");
    expect(JSON.stringify(blocks[0]?.props)).toBe(
      JSON.stringify({
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      }),
    );
    expect(blocks[0]?.children?.[0]?.id).toBe("child-1");
    expect(blocks[1]?.type).toBe("bulletListItem");
  });

  test("resolveNormalizedSelectionBlocks does not downgrade a block that is only cut at the end", () => {
    const block = {
      id: "last",
      type: "toggleListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "tail", styles: {} }],
      children: [],
    };

    const blocks = resolveNormalizedSelectionBlocks(
      createSelectionEditorStub({
        blocks: [block],
        blockCutAtEnd: "last",
      }),
    );

    expect(blocks[0]?.type).toBe("toggleListItem");
  });

  test("resolveStructuredPlainTextForSelection uses the structured inline serializer for partial inline text selection", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    const doc = schema.node("doc", undefined, [schema.node("paragraph", undefined, schema.text("Alpha Beta"))]);
    const selection = TextSelection.create(doc, 2, 7);

    const value = resolveStructuredPlainTextForSelection(
      {
        prosemirrorView: {
          state: { selection, doc },
        },
        getSelectionCutBlocks: () => ({
          blocks: [
            {
              id: "block-1",
              type: "paragraph",
              props: {},
              content: [
                { type: "text", text: "lpha", styles: { bold: true } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "B", styles: { italic: true } },
              ],
              children: [],
            },
          ],
          blockCutAtStart: "block-1",
          blockCutAtEnd: "block-1",
        }),
        getSelection: () => ({
          blocks: [
            {
              id: "block-1",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Alpha Beta", styles: {} }],
              children: [],
            },
          ],
        }),
      },
      "fallback-inline",
    );

    expect(value).toBe("**lpha** *B*");
  });

  test("resolveStructuredPlainTextForSelection preserves child indentation for cross-block text selection", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    const doc = schema.node("doc", undefined, [
      schema.node("paragraph", undefined, schema.text("alpha")),
      schema.node("paragraph", undefined, schema.text("omega")),
    ]);
    const selection = TextSelection.create(doc, 2, 10);

    const child = {
      id: "child-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "222", styles: {} }],
      children: [],
    };
    const parent = {
      id: "parent-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "111", styles: {} }],
      children: [child],
    };
    const sibling = {
      id: "sibling-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "333", styles: {} }],
      children: [],
    };

    const value = resolveStructuredPlainTextForSelection(
      {
        prosemirrorView: { state: { selection } },
        getSelectionCutBlocks: () => ({
          blocks: [parent, sibling],
          blockCutAtStart: "parent-1",
          blockCutAtEnd: "sibling-1",
        }),
        getParentBlock: (id) => (id === child.id ? parent : undefined),
      },
      "fallback",
    );

    expect(value).toBe("111\n\t222\n333");
  });

  test("resolveStructuredPlainTextForSelection uses the structured serializer for partial inline code-block selection", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    const code = "line-1\nline-2\n\nline-4";
    const fullText = `${code}x`;
    const doc = schema.node("doc", undefined, [
      schema.node("paragraph", undefined, schema.text(fullText)),
    ]);
    const selection = TextSelection.create(doc, 1, 1 + code.length);

    const value = resolveStructuredPlainTextForSelection(
      {
        prosemirrorView: { state: { selection, doc } },
        getSelectionCutBlocks: () => ({
          blocks: [
            {
              id: "code-1",
              type: "codeBlock",
              props: {},
              content: [{ type: "text", text: code, styles: {} }],
              children: [],
            },
          ],
          blockCutAtStart: "code-1",
          blockCutAtEnd: "code-1",
        }),
      },
      "fallback",
    );

    expect(value).toBe("```\nline-1\nline-2\n\nline-4\n```");
  });

  test("resolveStructuredPlainTextForSelection falls back to external HTML parse when selection snapshot serialization throws", () => {
    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => ({
          blocks: [
            {
              id: "unknown",
              type: "unsupported-block-type",
              props: {},
              content: [],
              children: [],
            },
          ],
        }),
        tryParseHTMLToBlocks: () => [
          {
            id: "block-html",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "from-html", styles: {} }],
            children: [],
          },
        ],
      },
      "fallback",
      "<p>from-html</p>",
    );

    expect(value).toBe("from-html");
  });

  test("resolveStructuredPlainTextForSelection prefers richer clipboard-html structure over flattened selection/external-html", () => {
    const parent = {
      id: "block2",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "block2", styles: {} }],
      children: [],
    };
    const child1 = {
      id: "child2-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child2-1", styles: {} }],
      children: [],
    };
    const child2 = {
      id: "child2-2",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child2-2", styles: {} }],
      children: [],
    };

    const value = resolveStructuredPlainTextForSelection(
      {
        getSelectionCutBlocks: () => ({
          blocks: [parent, child1, child2],
          blockCutAtStart: "block2",
          blockCutAtEnd: "child2-2",
        }),
        tryParseHTMLToBlocks: (html) => {
          if (html === "clipboard-html") {
            return [
              {
                id: "block2",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "block2", styles: {} }],
                children: [
                  {
                    id: "child2-1",
                    type: "paragraph",
                    props: {},
                    content: [{ type: "text", text: "child2-1", styles: {} }],
                    children: [],
                  },
                  {
                    id: "child2-2",
                    type: "paragraph",
                    props: {},
                    content: [{ type: "text", text: "child2-2", styles: {} }],
                    children: [],
                  },
                ],
              },
              {
                id: "empty-1",
                type: "paragraph",
                props: {},
                content: [],
                children: [],
              },
              {
                id: "block4",
                type: "paragraph",
                props: {},
                content: [{ type: "text", text: "block4", styles: {} }],
                children: [],
              },
            ];
          }

          return [
            {
              id: "block2",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "block2", styles: {} }],
              children: [],
            },
            {
              id: "child2-1",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "child2-1", styles: {} }],
              children: [],
            },
            {
              id: "child2-2",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "child2-2", styles: {} }],
              children: [],
            },
            {
              id: "block4",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "block4", styles: {} }],
              children: [],
            },
          ];
        },
      },
      "fallback",
      "external-html",
      "clipboard-html",
    );

    expect(value).toBe("block2\n\tchild2-1\n\tchild2-2\n\nblock4");
  });

  test("resolveStructuredPlainTextForSelection converts linebreaks and empty blocks to NFM-like plaintext", () => {
    const child21 = {
      id: "child2-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child2-1", styles: {} }],
      children: [],
    };
    const child22 = {
      id: "child2-2",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child2-2", styles: {} }],
      children: [],
    };
    const block1 = {
      id: "block1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "block1-text-line1\nblock1-text-line2", styles: {} }],
      children: [],
    };
    const block2 = {
      id: "block2",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "block2", styles: {} }],
      children: [child21, child22],
    };
    const block3 = {
      id: "block3",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "block3", styles: {} }],
      children: [],
    };
    const emptyBlock = {
      id: "empty-1",
      type: "paragraph",
      props: {},
      content: [],
      children: [],
    };
    const block4 = {
      id: "block4",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "block4", styles: {} }],
      children: [],
    };

    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => ({ blocks: [block1, block2, block3, emptyBlock, block4] }),
      },
      "fallback",
    );

    expect(value).toBe(
      "block1-text-line1\nblock1-text-line2\nblock2\n\tchild2-1\n\tchild2-2\nblock3\n\nblock4",
    );
  });

  test("resolveStructuredPlainTextForSelection keeps multiline text and special characters literal", () => {
    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => ({
          blocks: [
            {
              id: "special-1",
              type: "paragraph",
              props: {},
              content: [
                { type: "text", text: "alpha\nbeta * ` > [ ] \\", styles: {} },
              ],
              children: [],
            },
          ],
        }),
      },
      "fallback",
    );

    expect(value).toBe("alpha\nbeta * ` > [ ] \\");
  });

  test("resolveStructuredPlainTextForSelection preserves all inline markers", () => {
    const value = resolveStructuredPlainTextForSelection(
      {
        getSelection: () => ({
          blocks: [
            {
              id: "styled-1",
              type: "paragraph",
              props: {},
              content: [
                { type: "text", text: "bold", styles: { bold: true } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "italic", styles: { italic: true } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "strike", styles: { strike: true } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "under", styles: { underline: true } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "blue", styles: { textColor: "blue" } },
                { type: "text", text: " ", styles: {} },
                { type: "text", text: "code", styles: { code: true } },
                { type: "text", text: " ", styles: {} },
                {
                  type: "link",
                  href: "https://example.com/a?b=1",
                  content: [{ type: "text", text: "link", styles: { bold: true, italic: true } }],
                },
              ],
              children: [],
            },
          ],
        }),
      },
      "fallback",
    );

    expect(value).toBe("**bold** *italic* ~~strike~~ <span underline=\"true\">under</span> <span color=\"blue\">blue</span> `code` [***link***](https://example.com/a?b=1)");
  });

  test("resolveStructuredPlainTextForSelection rebuilds nested hierarchy from flattened selection snapshots", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    const doc = schema.node("doc", undefined, [
      schema.node("paragraph", undefined, schema.text("alpha")),
      schema.node("paragraph", undefined, schema.text("omega")),
    ]);
    const selection = TextSelection.create(doc, 2, 10);

    const parent = {
      id: "parent-flat",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "parent", styles: {} }],
      children: [],
    };
    const child1 = {
      id: "child-flat-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child-one", styles: {} }],
      children: [],
    };
    const child2 = {
      id: "child-flat-2",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "child-two", styles: {} }],
      children: [],
    };

    const value = resolveStructuredPlainTextForSelection(
      {
        prosemirrorView: { state: { selection } },
        getSelectionCutBlocks: () => ({
          blocks: [parent, child1, child2],
          blockCutAtStart: "parent-flat",
          blockCutAtEnd: "child-flat-2",
        }),
        getParentBlock: (id) => {
          if (id === child1.id || id === child2.id) return parent;
          return undefined;
        },
      },
      "fallback",
    );

    expect(value).toBe("parent\n\tchild-one\n\tchild-two");
  });

  test("createCopiedSelectionPayloadFromSelection unwraps only the partially selected first bullet across all payloads", () => {
    const first = {
      id: "l1",
      type: "bulletListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "asd", styles: {} }],
      children: [],
    };
    const second = {
      id: "l2",
      type: "bulletListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "lollo", styles: {} }],
      children: [],
    };

    const payload = createCopiedSelectionPayloadFromSelection(
      createSelectionEditorStub({
        blocks: [first, second],
        blockCutAtStart: "l1",
        blockCutAtEnd: "l2",
      }),
    );

    expect(payload.structuredText).toBe("asd\n- lollo");
    expect(payload.clipboardHTML).toBe("<full>asd\n- lollo</full>");
    expect(payload.externalHTML).toBe("<external>asd\n- lollo</external>");
  });

  test("createCopiedSelectionPayloadFromSelection preserves top-level to child to top-level partial selections", () => {
    const child1 = {
      id: "child-1",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "1234567", styles: {} }],
      children: [],
    };
    const child2 = {
      id: "child-2",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "1234567", styles: {} }],
      children: [],
    };
    const first = {
      id: "a",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "56", styles: {} }],
      children: [child1, child2],
    };
    const last = {
      id: "b",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "12345", styles: {} }],
      children: [],
    };

    const payload = createCopiedSelectionPayloadFromSelection(
      createSelectionEditorStub({
        blocks: [first, last],
        blockCutAtStart: "a",
        blockCutAtEnd: "b",
      }),
    );

    expect(payload.structuredText).toBe("56\n\t1234567\n\t1234567\n12345");
    expect(payload.clipboardHTML).toBe("<full>56\n\t1234567\n\t1234567\n12345</full>");
    expect(payload.externalHTML).toBe("<external>56\n\t1234567\n\t1234567\n12345</external>");
  });

  test("createCopiedSelectionPayloadFromSelection lifts partially selected child blocks without dropping the trailing top-level block", () => {
    const parent = {
      id: "parent",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "123456", styles: {} }],
      children: [],
    };
    const child1 = {
      id: "child-1",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "4567", styles: {} }],
      children: [],
    };
    const child2 = {
      id: "child-2",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "1234567", styles: {} }],
      children: [],
    };
    const trailing = {
      id: "trailing",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "12345", styles: {} }],
      children: [],
    };

    const payload = createCopiedSelectionPayloadFromSelection(
      createSelectionEditorStub(
        {
          blocks: [child1, child2, trailing],
          blockCutAtStart: "child-1",
          blockCutAtEnd: "trailing",
        },
        {
          "child-1": parent,
          "child-2": parent,
        },
      ),
    );

    expect(payload.structuredText).toBe("4567\n1234567\n12345");
    expect(payload.clipboardHTML).toBe("<full>4567\n1234567\n12345</full>");
    expect(payload.externalHTML).toBe("<external>4567\n1234567\n12345</external>");
  });

  test("createCopiedSelectionPayloadFromSelection works with method-style getParentBlock implementations", () => {
    const parent = {
      id: "parent",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "123456", styles: {} }],
      children: [],
    };
    const child1 = {
      id: "child-1",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "4567", styles: {} }],
      children: [],
    };
    const child2 = {
      id: "child-2",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "1234567", styles: {} }],
      children: [],
    };
    const trailing = {
      id: "trailing",
      type: "paragraph",
      props: { textAlignment: "left" },
      content: [{ type: "text", text: "12345", styles: {} }],
      children: [],
    };

    const editor = {
      parentById: {
        "child-1": parent,
        "child-2": parent,
      } satisfies Record<string, TestSelectionBlock | undefined>,
      getSelectionCutBlocks() {
        return {
          blocks: [child1, child2, trailing],
          blockCutAtStart: "child-1",
          blockCutAtEnd: "trailing",
        };
      },
      getParentBlock(this: { parentById: Record<string, TestSelectionBlock | undefined> }, id: string) {
        return this.parentById[id];
      },
      blocksToFullHTML(blocks: SelectionEditorLike extends never ? never : Parameters<NonNullable<SelectionEditorLike["blocksToFullHTML"]>>[0]) {
        return `<full>${renderVisibleSelectionText(blocks as TestSelectionBlock[])}</full>`;
      },
      blocksToHTMLLossy(blocks: SelectionEditorLike extends never ? never : Parameters<NonNullable<SelectionEditorLike["blocksToHTMLLossy"]>>[0]) {
        return `<external>${renderVisibleSelectionText(blocks as TestSelectionBlock[])}</external>`;
      },
    } satisfies SelectionEditorLike & {
      parentById: Record<string, TestSelectionBlock | undefined>;
    };

    const payload = createCopiedSelectionPayloadFromSelection(editor);

    expect(payload.structuredText).toBe("4567\n1234567\n12345");
    expect(payload.clipboardHTML).toBe("<full>4567\n1234567\n12345</full>");
    expect(payload.externalHTML).toBe("<external>4567\n1234567\n12345</external>");
  });

  test("createCopiedSelectionPayloadFromSelection unwraps a partially selected toggle block across all payloads", () => {
    const first = {
      id: "toggle-1",
      type: "toggleListItem",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "inside toggle", styles: {} }],
      children: [],
    };
    const second = {
      id: "after-toggle",
      type: "paragraph",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "after", styles: {} }],
      children: [],
    };

    const payload = createCopiedSelectionPayloadFromSelection(
      createSelectionEditorStub({
        blocks: [first, second],
        blockCutAtStart: "toggle-1",
        blockCutAtEnd: "after-toggle",
      }),
    );

    expect(payload.structuredText).toBe("inside toggle\nafter");
    expect(payload.clipboardHTML).toBe("<full>inside toggle\nafter</full>");
    expect(payload.externalHTML).toBe("<external>inside toggle\nafter</external>");
  });

  test("rewriteAssetSources replaces all nodex asset URLs", async () => {
    const source = "nodex://assets/a.png";
    const resolved = "/workspace/.nodex/assets/a.png";
    const input = `before ${source} middle ${source} after`;
    const output = await rewriteAssetSources(input, async () => resolved);

    expect(output).toBe(`before ${resolved} middle ${resolved} after`);
  });

  test("rewriteCopiedSelectionAssetSources only resolves unique URLs once", async () => {
    const a = "nodex://assets/a.png";
    const b = "nodex://assets/b.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${a}" /><img src="${b}" />`,
      externalHTML: `<img src="${a}" />`,
      structuredText: `![a](${a})\n![b](${b})\n![a](${a})`,
    };

    const calls: string[] = [];
    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async (source) => {
      calls.push(source);
      return `/workspace/.nodex/assets/${source.endsWith("a.png") ? "a.png" : "b.png"}`;
    });

    expect(calls.length).toBe(2);
    expect(calls.includes(a)).toBeTrue();
    expect(calls.includes(b)).toBeTrue();
    expect(rewritten.clipboardHTML).toBe(payload.clipboardHTML);
    expect(rewritten.externalHTML).toBe(payload.externalHTML);
    expect(rewritten.structuredText.includes("nodex://assets/")).toBeFalse();
  });

  test("rewriteCopiedSelectionAssetSourcesSync preserves rich clipboard payloads and rewrites plain text only", () => {
    const source = "nodex://assets/diagram.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `<image source="${source}">diagram</image>`,
    };

    const rewritten = rewriteCopiedSelectionAssetSourcesSync(payload, () => {
      return "/workspace/.nodex/assets/diagram.png";
    });

    expect(rewritten.clipboardHTML).toBe(payload.clipboardHTML);
    expect(rewritten.externalHTML).toBe(payload.externalHTML);
    expect(rewritten.structuredText).toBe("![diagram](/workspace/.nodex/assets/diagram.png)");
  });

  test("rewriteCopiedSelectionAssetSources converts NFM image lines to markdown image syntax", async () => {
    const source = "nodex://assets/image.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `<image source="${source}">diagram</image>`,
    };

    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async () => {
      return "/workspace/.nodex/assets/image.png";
    });

    expect(rewritten.clipboardHTML).toBe(payload.clipboardHTML);
    expect(rewritten.externalHTML).toBe(payload.externalHTML);
    expect(rewritten.structuredText).toBe("![diagram](/workspace/.nodex/assets/image.png)");
  });

  test("rewriteCopiedSelectionAssetSources preserves indentation and escapes markdown image destinations", async () => {
    const source = "nodex://assets/plan.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `\t<image source="${source}"></image>`,
    };

    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async () => {
      return "/workspace/my files/plan (v2).png";
    });

    expect(rewritten.structuredText).toBe("\t![image](</workspace/my files/plan (v2).png>)");
  });

  test("rewriteCopiedSelectionAssetSources supports space-indented NFM image lines", async () => {
    const source = "nodex://assets/diagram.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `    <image source="${source}">diagram</image>`,
    };

    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async () => {
      return "/workspace/.nodex/assets/diagram.png";
    });

    expect(rewritten.structuredText).toBe("    ![diagram](/workspace/.nodex/assets/diagram.png)");
  });

  test("rewriteCopiedSelectionAssetSources escapes markdown image alt text without generic NFM escaping", async () => {
    const source = "nodex://assets/diagram.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `<image source="${source}">a[b]*` + "`" + `</image>`,
    };

    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async () => {
      return "/workspace/.nodex/assets/diagram.png";
    });

    expect(rewritten.structuredText).toBe("![a\\[b\\]*`](/workspace/.nodex/assets/diagram.png)");
  });

  test("rewriteCopiedSelectionAssetSources keeps all inline markers in markdown image alt text", async () => {
    const source = "nodex://assets/diagram.png";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: `<img src="${source}" />`,
      externalHTML: `<img src="${source}" />`,
      structuredText: `<image source="${source}">**bold** *italic* ~~strike~~ <span underline="true">under</span> <span color="blue">blue</span> \`code\` [link](https://example.com)</image>`,
    };

    const rewritten = await rewriteCopiedSelectionAssetSources(payload, async () => {
      return "/workspace/.nodex/assets/diagram.png";
    });

    expect(rewritten.structuredText).toBe("![**bold** *italic* ~~strike~~ <span underline=\"true\">under</span> <span color=\"blue\">blue</span> `code` \\[link\\](https://example.com)](/workspace/.nodex/assets/diagram.png)");
  });

  test("writeCopiedSelectionToClipboard writes rich clipboard payload", async () => {
    let captured: FakeClipboardItem | null = null;
    const payload: CopiedSelectionPayload = {
      clipboardHTML: "<div>internal</div>",
      externalHTML: "<p>external</p>",
      structuredText: "plain",
    };

    await writeCopiedSelectionToClipboard(payload, {
      clipboard: {
        write: async (items) => {
          captured = items[0] as unknown as FakeClipboardItem;
        },
      },
      clipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(captured).not.toBeNull();
    expect(await captured!.data["blocknote/html"].text()).toBe(payload.clipboardHTML);
    expect(await captured!.data["text/html"].text()).toBe(payload.externalHTML);
    expect(await captured!.data["text/plain"].text()).toBe(payload.structuredText);
  });

  test("writeCopiedSelectionToClipboard falls back to writeText when rich copy fails", async () => {
    let writtenText = "";
    const payload: CopiedSelectionPayload = {
      clipboardHTML: "<div>internal</div>",
      externalHTML: "<p>external</p>",
      structuredText: "plain",
    };

    await writeCopiedSelectionToClipboard(payload, {
      clipboard: {
        write: async () => {
          throw new Error("write failed");
        },
        writeText: async (value) => {
          writtenText = value;
        },
      },
      clipboardItemCtor: FakeClipboardItem as unknown as typeof ClipboardItem,
    });

    expect(writtenText).toBe(payload.structuredText);
  });
});
