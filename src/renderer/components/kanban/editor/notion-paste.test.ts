import { describe, expect, test } from "bun:test";
import type { NfmBlock, NfmInlineContent } from "../../../lib/nfm";
import {
  CHROMIUM_WEB_CUSTOM_DATA_MIME,
  NOTION_BLOCKS_MIME,
  NOTION_MULTI_TEXT_MIME,
  decodeChromiumWebCustomData,
  extractNotionNfmBlocksFromClipboardData,
  extractNotionNfmBlocksFromPayload,
  insertNfmBlocksFromPaste,
} from "./notion-paste";

type StyledInline = Extract<NfmInlineContent, { type: "text" | "link" }>;

describe("notion paste", () => {
  test("extracts toggle hierarchy from direct Notion MIME payload", () => {
    const clipboardData = createClipboardData({
      [NOTION_BLOCKS_MIME]: JSON.stringify(createSampleNotionPayload()),
    });

    const blocks = extractNotionNfmBlocksFromClipboardData(clipboardData);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(3);

    const toggle = blocks?.[1];
    expect(toggle?.type).toBe("toggle");
    if (!toggle || toggle.type !== "toggle") return;

    expect(inlineToText(toggle.content)).toBe("example");
    expect(toggle.children.length).toBe(1);
    expect(toggle.children[0]?.type).toBe("paragraph");
    if (toggle.children[0]?.type !== "paragraph") return;
    expect(inlineToText(toggle.children[0].content)).toBe("bb");
  });

  test("extracts Notion payload from Chromium web-custom-data", () => {
    const notionPayload = createSampleNotionPayload();
    const binaryCustomData = encodeChromiumWebCustomData([
      [NOTION_BLOCKS_MIME, JSON.stringify(notionPayload)],
      ["text/_notion-page-source-production", JSON.stringify({ id: "page-1" })],
    ]);

    const clipboardData = createClipboardData({
      [CHROMIUM_WEB_CUSTOM_DATA_MIME]: binaryCustomData,
    });

    const blocks = extractNotionNfmBlocksFromClipboardData(clipboardData);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(3);
    expect(blocks?.[1]?.type).toBe("toggle");
  });

  test("extracts payload from Notion multi-text MIME", () => {
    const multiTextPayload = {
      blockSelection: createSampleNotionPayload(),
      action: "copy",
    };
    const clipboardData = createClipboardData({
      [NOTION_MULTI_TEXT_MIME]: JSON.stringify(multiTextPayload),
    });

    const blocks = extractNotionNfmBlocksFromClipboardData(clipboardData);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(3);
    expect(blocks?.[0]?.type).toBe("paragraph");
  });

  test("decodes Chromium web-custom-data key/value pairs", () => {
    const binaryCustomData = encodeChromiumWebCustomData([
      ["text/example", '{"x":1}'],
      ["text/second", "value"],
    ]);
    const bytes = new Uint8Array(
      Array.from(binaryCustomData).map((char) => char.charCodeAt(0)),
    );

    const decoded = decodeChromiumWebCustomData(bytes);
    expect(decoded.get("text/example")).toBe('{"x":1}');
    expect(decoded.get("text/second")).toBe("value");
  });

  test("maps sub_header with children to toggle heading", () => {
    const payload = {
      format: "notion_web_custom_data_pairs",
      source: {
        id: "25ac6ded-9b4a-8062-905e-f5a03e6ba6cd",
        table: "block",
        spaceId: "3607f6d1-2a9a-4d43-8e23-51f1496e5fdb",
      },
      selection: {
        action: "copy",
        wasContiguousSelection: true,
        roots: [
          {
            id: "301c6ded-9b4a-80c2-878d-d15100af38ec",
            type: "sub_header",
            title: "a heading with children",
            children: [
              {
                id: "301c6ded-9b4a-80f7-918b-f3cc8fc52d3d",
                type: "text",
                text: "children-1",
              },
              {
                id: "301c6ded-9b4a-8040-bf39-d3e5369073c6",
                type: "text",
                text: "children-2",
              },
            ],
          },
        ],
      },
    };

    const blocks = extractNotionNfmBlocksFromPayload(payload);
    expect(blocks).not.toBeNull();
    if (!blocks) return;

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("heading");
    if (!blocks[0] || blocks[0].type !== "heading") return;

    expect(blocks[0].level).toBe(2);
    expect(blocks[0].isToggleable).toBeTrue();
    expect(inlineToText(blocks[0].content)).toBe("a heading with children");
    expect(blocks[0].children.length).toBe(2);
    expect(blocks[0].children[0]?.type).toBe("paragraph");
    expect(blocks[0].children[1]?.type).toBe("paragraph");
  });

  test("preserves bold/italic/strikethrough/code/underline from Notion title segments", () => {
    const payload = {
      blocks: [
        {
          blockId: "rich-1",
          blockSubtree: {
            block: {
              "rich-1": {
                value: {
                  type: "text",
                  properties: {
                    title: [
                      ["This is "],
                      ["bold text", [["b"]]],
                      [", "],
                      ["italic text", [["i"]]],
                      [", "],
                      ["strikethrough text", [["s"]]],
                      [", and "],
                      ["inline code", [["c"]]],
                      ["."],
                    ],
                  },
                },
              },
            },
          },
        },
        {
          blockId: "rich-2",
          blockSubtree: {
            block: {
              "rich-2": {
                value: {
                  type: "text",
                  properties: {
                    title: [
                      ["This has "],
                      ["underlined text", [["_"]]],
                      [" using the underline span."],
                    ],
                  },
                },
              },
            },
          },
        },
        {
          blockId: "rich-3",
          blockSubtree: {
            block: {
              "rich-3": {
                value: {
                  type: "text",
                  properties: {
                    title: [
                      ["You can combine them: "],
                      ["bold italic", [["b"], ["i"]]],
                      [", "],
                      ["bold strikethrough", [["b"], ["s"]]],
                      [", "],
                      ["italic strikethrough", [["i"], ["s"]]],
                      ["."],
                    ],
                  },
                },
              },
            },
          },
        },
      ],
      action: "copy",
      wasContiguousSelection: true,
    };

    const blocks = extractNotionNfmBlocksFromPayload(payload);
    expect(blocks).not.toBeNull();
    if (!blocks) return;

    expect(blocks.length).toBe(3);
    if (blocks[0]?.type !== "paragraph") return;
    if (blocks[1]?.type !== "paragraph") return;
    if (blocks[2]?.type !== "paragraph") return;

    const bold = findInlineSpan(blocks[0].content, "bold text");
    expect(bold?.type).toBe("text");
    expect(bold?.styles.bold).toBeTrue();

    const italic = findInlineSpan(blocks[0].content, "italic text");
    expect(italic?.type).toBe("text");
    expect(italic?.styles.italic).toBeTrue();

    const strike = findInlineSpan(blocks[0].content, "strikethrough text");
    expect(strike?.type).toBe("text");
    expect(strike?.styles.strikethrough).toBeTrue();

    const inlineCode = findInlineSpan(blocks[0].content, "inline code");
    expect(inlineCode?.type).toBe("text");
    expect(inlineCode?.styles.code).toBeTrue();

    const underline = findInlineSpan(blocks[1].content, "underlined text");
    expect(underline?.type).toBe("text");
    expect(underline?.styles.underline).toBeTrue();

    const boldItalic = findInlineSpan(blocks[2].content, "bold italic");
    expect(boldItalic?.styles.bold).toBeTrue();
    expect(boldItalic?.styles.italic).toBeTrue();

    const boldStrike = findInlineSpan(blocks[2].content, "bold strikethrough");
    expect(boldStrike?.styles.bold).toBeTrue();
    expect(boldStrike?.styles.strikethrough).toBeTrue();

    const italicStrike = findInlineSpan(blocks[2].content, "italic strikethrough");
    expect(italicStrike?.styles.italic).toBeTrue();
    expect(italicStrike?.styles.strikethrough).toBeTrue();
  });

  test("maps Notion text/background colors from h annotation", () => {
    const payload = {
      blocks: [
        {
          blockId: "colors",
          blockSubtree: {
            block: {
              colors: {
                value: {
                  type: "text",
                  properties: {
                    title: [
                      ["Gray text", [["h", "gray"]]],
                      [", "],
                      ["Green text", [["h", "teal"]]],
                      [", "],
                      ["Purple background", [["h", "purple_background"]]],
                      [", "],
                      ["Green background", [["h", "teal_background"]]],
                    ],
                  },
                },
              },
            },
          },
        },
      ],
      action: "copy",
      wasContiguousSelection: true,
    };

    const blocks = extractNotionNfmBlocksFromPayload(payload);
    expect(blocks).not.toBeNull();
    if (!blocks || blocks[0]?.type !== "paragraph") return;

    const grayText = findInlineSpan(blocks[0].content, "Gray text");
    expect(grayText?.styles.color).toBe("gray");

    const greenText = findInlineSpan(blocks[0].content, "Green text");
    expect(greenText?.styles.color).toBe("green");

    const purpleBg = findInlineSpan(blocks[0].content, "Purple background");
    expect(purpleBg?.styles.color).toBe("purple_bg");

    const greenBg = findInlineSpan(blocks[0].content, "Green background");
    expect(greenBg?.styles.color).toBe("green_bg");
  });

  test("replace selected blocks when inserting parsed Notion blocks", () => {
    const notionBlocks = extractNotionNfmBlocksFromPayload(createSampleNotionPayload());
    expect(notionBlocks).not.toBeNull();
    if (!notionBlocks) return;

    const replaceCalls: Array<{ remove: string[]; insertCount: number }> = [];
    let insertCalls = 0;

    const handled = insertNfmBlocksFromPaste(
      {
        getSelection: () => ({
          blocks: [
            { id: "selected-1", type: "paragraph" },
            { id: "selected-2", type: "paragraph" },
          ],
        }),
        getTextCursorPosition: () => ({
          block: { id: "cursor", type: "paragraph" },
        }),
        replaceBlocks: (remove, insert) => {
          replaceCalls.push({ remove, insertCount: insert.length });
        },
        insertBlocks: () => {
          insertCalls += 1;
        },
      },
      notionBlocks,
    );

    expect(handled).toBeTrue();
    expect(replaceCalls.length).toBe(1);
    expect(JSON.stringify(replaceCalls[0]?.remove)).toBe(JSON.stringify(["selected-1", "selected-2"]));
    expect(replaceCalls[0]?.insertCount).toBe(3);
    expect(insertCalls).toBe(0);
  });

  test("replace current empty paragraph block when no selection exists", () => {
    const notionBlocks = extractNotionNfmBlocksFromPayload(createSampleNotionPayload());
    expect(notionBlocks).not.toBeNull();
    if (!notionBlocks) return;

    const replaceCalls: Array<{ remove: string[]; insertCount: number }> = [];
    let insertCalls = 0;

    const handled = insertNfmBlocksFromPaste(
      {
        getSelection: () => undefined,
        getTextCursorPosition: () => ({
          block: { id: "cursor-empty", type: "paragraph", content: [] },
        }),
        replaceBlocks: (remove, insert) => {
          replaceCalls.push({ remove, insertCount: insert.length });
        },
        insertBlocks: () => {
          insertCalls += 1;
        },
      },
      notionBlocks,
    );

    expect(handled).toBeTrue();
    expect(replaceCalls.length).toBe(1);
    expect(JSON.stringify(replaceCalls[0]?.remove)).toBe(JSON.stringify(["cursor-empty"]));
    expect(insertCalls).toBe(0);
  });

  test("insert after current non-empty block when no selection exists", () => {
    const notionBlocks = extractNotionNfmBlocksFromPayload(createSampleNotionPayload());
    expect(notionBlocks).not.toBeNull();
    if (!notionBlocks) return;

    let replaceCalls = 0;
    const insertCalls: Array<{ ref: string; placement: "before" | "after"; insertCount: number }> = [];

    const handled = insertNfmBlocksFromPaste(
      {
        getSelection: () => undefined,
        getTextCursorPosition: () => ({
          block: {
            id: "cursor-non-empty",
            type: "paragraph",
            content: [{ type: "text", text: "existing", styles: {} }],
          },
        }),
        replaceBlocks: () => {
          replaceCalls += 1;
        },
        insertBlocks: (insert, ref, placement) => {
          insertCalls.push({ ref, placement, insertCount: insert.length });
        },
      },
      notionBlocks,
    );

    expect(handled).toBeTrue();
    expect(replaceCalls).toBe(0);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]?.ref).toBe("cursor-non-empty");
    expect(insertCalls[0]?.placement).toBe("after");
    expect(insertCalls[0]?.insertCount).toBe(3);
  });
});

function inlineToText(content: NfmInlineContent[]): string {
  return content
    .map((item) => {
      if (item.type === "linebreak") return "\n";
      if (item.type === "attachment") return item.name;
      return item.text;
    })
    .join("");
}

function findInlineSpan(content: NfmInlineContent[], text: string): StyledInline | undefined {
  return content.find((item): item is StyledInline => {
    if (item.type === "linebreak" || item.type === "attachment") return false;
    return item.text === text;
  });
}

function createClipboardData(data: Record<string, string>) {
  const map = new Map(Object.entries(data));
  return {
    types: Array.from(map.keys()),
    getData: (format: string) => map.get(format) ?? "",
  };
}

function createSampleNotionPayload() {
  return {
    action: "copy",
    wasContiguousSelection: true,
    blocks: [
      {
        blockId: "block-aa",
        blockSubtree: {
          block: {
            "block-aa": {
              value: {
                type: "text",
                properties: { title: [["aa"]] },
              },
            },
          },
        },
      },
      {
        blockId: "block-toggle",
        blockSubtree: {
          block: {
            "block-toggle": {
              value: {
                type: "toggle",
                properties: { title: [["example"]] },
                content: ["block-bb"],
              },
            },
            "block-bb": {
              value: {
                type: "text",
                properties: { title: [["bb"]] },
              },
            },
          },
        },
      },
      {
        blockId: "block-cc",
        blockSubtree: {
          block: {
            "block-cc": {
              value: {
                type: "text",
                properties: { title: [["cc"]] },
              },
            },
          },
        },
      },
    ],
  };
}

function encodeChromiumWebCustomData(pairs: [string, string][]): string {
  const payload: number[] = [];
  pushU32LE(payload, pairs.length);

  for (const [key, value] of pairs) {
    pushU16String(payload, key);
    pushU16String(payload, value);
  }

  const bytes: number[] = [];
  pushU32LE(bytes, payload.length);
  bytes.push(...payload);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

function pushU16String(target: number[], value: string): void {
  pushU32LE(target, value.length);

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    target.push(code & 0xff, (code >> 8) & 0xff);
  }

  if (value.length % 2 !== 0) {
    target.push(0, 0);
  }
}

function pushU32LE(target: number[], value: number): void {
  target.push(
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  );
}

function asParagraph(block: NfmBlock): string {
  if (block.type !== "paragraph") return "";
  return inlineToText(block.content);
}

// Keep one direct top-level assertion for readability in failures.
test("sample payload sanity", () => {
  const blocks = extractNotionNfmBlocksFromPayload(createSampleNotionPayload());
  expect(blocks).not.toBeNull();
  if (!blocks) return;
  expect(asParagraph(blocks[0])).toBe("aa");
  expect(asParagraph(blocks[2])).toBe("cc");
});
