import { describe, expect, test } from "vite-plus/test";

import { blockNoteToNfm, nfmToBlockNote } from "./blocknote-adapter";
import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";

function asDoc(blocks: any[]) {
  return blocks as unknown[];
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const value = (item as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
}

describe("blocknote adapter", () => {
  test("nfmToBlockNote maps GFM tables to BlockNote table content", () => {
    const blocks = nfmToBlockNote(parseNfm("| A | B |\n| --- | ---: |\n| one | two |"));

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("table");
    const content = blocks[0].content as {
      columnWidths?: unknown[];
      headerRows?: number;
      rows?: Array<{ cells?: Array<{ content?: unknown[]; props?: Record<string, unknown> }> }>;
    };

    expect(content.headerRows).toBe(1);
    expect(content.columnWidths?.length).toBe(2);
    expect(content.rows?.length).toBe(2);
    expect(content.rows?.[0]?.cells?.[1]?.props?.textAlignment).toBe("right");
    expect(extractText(content.rows?.[1]?.cells?.[0]?.content)).toBe("one");
  });

  test("blockNoteToNfm preserves table widths, headers, alignment, and cell content", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "table",
          props: {},
          content: {
            type: "tableContent",
            columnWidths: [180, undefined],
            headerRows: 1,
            headerCols: 1,
            rows: [
              {
                cells: [
                  {
                    type: "tableCell",
                    props: {
                      backgroundColor: "gray",
                      textColor: "default",
                      textAlignment: "center",
                    },
                    content: [{ type: "text", text: "Name", styles: {} }],
                  },
                  {
                    type: "tableCell",
                    props: {
                      backgroundColor: "default",
                      textColor: "default",
                      textAlignment: "right",
                    },
                    content: [{ type: "text", text: "Score", styles: { bold: true } }],
                  },
                ],
              },
            ],
          },
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("table");
    if (blocks[0]?.type !== "table") return;

    expect(blocks[0].headerRow).toBe(true);
    expect(blocks[0].headerColumn).toBe(true);
    expect(blocks[0].columns[0]?.width).toBe(180);
    expect(blocks[0].columns[0]?.align).toBe("center");
    expect(blocks[0].rows[0]?.cells[0]?.color).toBe("gray_bg");
    expect(blocks[0].rows[0]?.cells[1]?.content[0]?.type).toBe("text");
    if (blocks[0].rows[0]?.cells[1]?.content[0]?.type !== "text") return;
    expect(blocks[0].rows[0].cells[1].content[0].styles.bold).toBe(true);
    expect(serializeNfm(blocks))
      .toBe(`<table header-row="true" header-column="true" fit-page-width="false">
\t<colgroup>
\t\t<col width="180" align="center" />
\t\t<col align="right" />
\t</colgroup>
\t<tr>
\t\t<td color="gray_bg">Name</td>
\t\t<td>**Score**</td>
\t</tr>
</table>`);
  });

  test("blockNoteToNfm converts empty paragraph to emptyBlock", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: {},
          content: [],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("emptyBlock");
  });

  test("round-trip preserves a single empty line across restart", () => {
    const initialDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Before", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        props: {},
        content: [],
        children: [],
      },
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "After", styles: {} }],
        children: [],
      },
    ]);

    const nfm = serializeNfm(blockNoteToNfm(initialDoc));
    const reloadedDoc = nfmToBlockNote(parseNfm(nfm));

    expect(nfm).toBe("Before\n<empty-block/>\nAfter");
    expect(reloadedDoc.length).toBe(3);
    expect(reloadedDoc[1].type).toBe("paragraph");
    expect(Array.isArray(reloadedDoc[1].content)).toBe(true);
    expect((reloadedDoc[1].content as unknown[]).length).toBe(0);
  });

  test("round-trip preserves consecutive empty lines", () => {
    const initialDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Top", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        props: {},
        content: [],
        children: [],
      },
      {
        type: "paragraph",
        props: {},
        content: [],
        children: [],
      },
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Bottom", styles: {} }],
        children: [],
      },
    ]);

    const nfm = serializeNfm(blockNoteToNfm(initialDoc));
    const reloadedDoc = nfmToBlockNote(parseNfm(nfm));

    expect(nfm).toBe("Top\n<empty-block/>\n<empty-block/>\nBottom");
    expect(reloadedDoc.length).toBe(4);
    expect(reloadedDoc[1].type).toBe("paragraph");
    expect(reloadedDoc[2].type).toBe("paragraph");
    expect((reloadedDoc[1].content as unknown[]).length).toBe(0);
    expect((reloadedDoc[2].content as unknown[]).length).toBe(0);
  });

  test("empty paragraph with color stays paragraph", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: { textColor: "blue" },
          content: [],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    expect("color" in blocks[0]).toBe(true);
    expect(blocks[0].color).toBe("blue");
  });

  test("inline background color NFM → BN uses BlockNote background token", () => {
    const bnBlocks = nfmToBlockNote(parseNfm('<span color="purple_bg">bg</span>'));
    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("paragraph");
    const first = (bnBlocks[0].content as Array<{ styles?: Record<string, unknown> }>)[0];
    expect(first.styles?.backgroundColor).toBe("purple");
  });

  test("inline background color BN → NFM maps to _bg suffix", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "bg", styles: { backgroundColor: "green" } }],
          children: [],
        },
      ]),
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    if (blocks[0].type !== "paragraph") return;
    expect(blocks[0].content[0]?.type).toBe("text");
    if (blocks[0].content[0]?.type !== "text") return;
    expect(blocks[0].content[0].styles.color).toBe("green_bg");
  });

  test("inline arbitrary CSS text color BN → NFM is dropped", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "plain", styles: { textColor: "rgb(240, 239, 237)" } }],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    if (blocks[0].type !== "paragraph") return;
    expect(blocks[0].content[0]?.type).toBe("text");
    if (blocks[0].content[0]?.type !== "text") return;
    expect(blocks[0].content[0].styles.color).toBe(undefined);
  });

  test("date mention inline content round-trips between NFM and BlockNote", () => {
    const nfm =
      '<mention-date start="2026-06-28T09:30:00+08:00" end="2026-06-29T10:45:00+08:00" tz="Asia/Shanghai" format="relative" time-format="24h" reminder="hour:1" />';
    const blockNoteBlocks = nfmToBlockNote(parseNfm(nfm));

    expect(blockNoteBlocks.length).toBe(1);
    expect(blockNoteBlocks[0].type).toBe("paragraph");
    const content = blockNoteBlocks[0].content as Array<{
      type?: string;
      props?: Record<string, unknown>;
    }>;
    expect(content[0]?.type).toBe("dateMention");
    expect(content[0]?.props?.start).toBe("2026-06-28T09:30:00+08:00");
    expect(content[0]?.props?.end).toBe("2026-06-29T10:45:00+08:00");
    expect(content[0]?.props?.tz).toBe("Asia/Shanghai");
    expect(content[0]?.props?.timeFormat).toBe("24h");
    expect(content[0]?.props?.reminder).toBe("hour:1");

    const roundTrip = serializeNfm(blockNoteToNfm(asDoc(blockNoteBlocks)));
    expect(roundTrip).toBe(nfm);
  });

  test("block background color BN → NFM maps to _bg suffix", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: { backgroundColor: "yellow" },
          content: [{ type: "text", text: "value", styles: {} }],
          children: [],
        },
      ]),
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].color).toBe("yellow_bg");
  });

  test("block background color NFM → BN uses BlockNote background token", () => {
    const bnBlocks = nfmToBlockNote(parseNfm('value {color="red_bg"}'));
    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("paragraph");
    expect(bnBlocks[0].props.backgroundColor).toBe("red");
  });

  test("block arbitrary CSS text color BN → NFM is dropped", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "paragraph",
          props: { textColor: "rgb(240, 239, 237)" },
          content: [{ type: "text", text: "value", styles: {} }],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].color).toBe(undefined);
  });

  test("blockNoteToNfm strips the default text code-block language", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "codeBlock",
          props: { language: "text" },
          content: [{ type: "text", text: "plain text", styles: {} }],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("codeBlock");
    if (blocks[0].type !== "codeBlock") return;

    expect(blocks[0].language).toBe("");
    expect(serializeNfm(blocks)).toBe("```\nplain text\n```");
  });

  test("numbered list starts round-trip between NFM and BlockNote", () => {
    const nfm = "3. third\n4. fourth";
    const blocks = parseNfm(nfm);
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(2);
    expect(bnBlocks[0]?.type).toBe("numberedListItem");
    expect(bnBlocks[1]?.type).toBe("numberedListItem");
    expect(bnBlocks[0]?.props.start).toBe(3);
    expect(bnBlocks[1]?.props.start).toBe(4);

    const roundTripped = blockNoteToNfm(asDoc(bnBlocks));
    expect(serializeNfm(roundTripped)).toBe(nfm);
  });

  test("implicit BlockNote numbered lists stay implicit in NFM and serialize sequentially", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "numberedListItem",
          props: {},
          content: [{ type: "text", text: "first", styles: {} }],
          children: [],
        },
        {
          type: "numberedListItem",
          props: {},
          content: [{ type: "text", text: "second", styles: {} }],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(2);
    expect(blocks[0]?.type).toBe("numberedListItem");
    expect(blocks[1]?.type).toBe("numberedListItem");
    if (blocks[0]?.type !== "numberedListItem") return;
    if (blocks[1]?.type !== "numberedListItem") return;

    expect(blocks[0].start).toBe(undefined);
    expect(blocks[1].start).toBe(undefined);
    expect(serializeNfm(blocks)).toBe("1. first\n2. second");
  });

  test("parse toggle heading level 1", () => {
    const blocks = parseNfm("▶# Toggle Heading 1");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("heading");
    const heading = blocks[0] as { type: "heading"; level: number; isToggleable?: boolean };
    expect(heading.level).toBe(1);
    expect(heading.isToggleable).toBe(true);
  });

  test("parse toggle heading level 3 with color", () => {
    const blocks = parseNfm('▶### Colored Toggle {color="blue"}');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("heading");
    const heading = blocks[0] as {
      type: "heading";
      level: number;
      isToggleable?: boolean;
      color?: string;
    };
    expect(heading.level).toBe(3);
    expect(heading.isToggleable).toBe(true);
    expect(heading.color).toBe("blue");
  });

  test("parse toggle heading with children", () => {
    const blocks = parseNfm("▶## Toggle H2\n\tChild content");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].children.length).toBe(1);
    expect(blocks[0].children[0].type).toBe("paragraph");
  });

  test("regular heading is not toggleable", () => {
    const blocks = parseNfm("# Regular Heading");
    expect(blocks.length).toBe(1);
    const heading = blocks[0] as { type: "heading"; isToggleable?: boolean };
    expect(heading.isToggleable).toBe(undefined);
  });

  test("attachment inline content parses and serializes with escaped paths", () => {
    const nfm =
      'before <attachment kind="file" mode="link" source="/tmp/My &amp; Stuff/report.txt" name="report &amp; notes.txt" mime="text/plain" bytes="42" origin="/tmp/My &amp; Stuff/report.txt" /> after';
    const blocks = parseNfm(nfm);

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("paragraph");
    if (!blocks[0] || blocks[0].type !== "paragraph") return;

    expect(blocks[0].content[1]?.type).toBe("attachment");
    if (blocks[0].content[1]?.type !== "attachment") return;

    expect(blocks[0].content[1].source).toBe("/tmp/My & Stuff/report.txt");
    expect(blocks[0].content[1].name).toBe("report & notes.txt");
    expect(blocks[0].content[1].mimeType).toBe("text/plain");
    expect(blocks[0].content[1].bytes).toBe(42);
    expect(serializeNfm(blocks)).toBe(nfm);
  });

  test("attachment inline content round-trips between BlockNote and NFM", () => {
    const attachmentDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "See ", styles: {} },
          {
            type: "attachment",
            props: {
              kind: "text",
              mode: "materialized",
              source: "nodex://assets/demo.txt",
              name: "demo.txt",
              mimeType: "text/plain",
              bytes: 12,
              origin: "/tmp/demo.txt",
            },
          },
        ],
        children: [],
      },
    ]);

    const nfmBlocks = blockNoteToNfm(attachmentDoc);
    expect(nfmBlocks.length).toBe(1);
    expect(nfmBlocks[0]?.type).toBe("paragraph");
    if (nfmBlocks[0]?.type !== "paragraph") return;
    expect(nfmBlocks[0].content[1]?.type).toBe("attachment");
    const reloaded = nfmToBlockNote(nfmBlocks);
    expect(reloaded.length).toBe(1);
    expect(reloaded[0]?.type).toBe("paragraph");
    const attachment = Array.isArray(reloaded[0]?.content) ? reloaded[0]?.content[1] : undefined;
    expect(attachment?.type).toBe("attachment");
    expect(attachment?.props.source).toBe("nodex://assets/demo.txt");
    expect(attachment?.props.origin).toBe("/tmp/demo.txt");
  });

  test("agent config inline content round-trips between BlockNote and NFM", () => {
    const agentConfigDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "Use ", styles: {} },
          {
            type: "agentConfig",
            props: {
              mode: "plan",
              provider: "openai",
              model: "gpt-5.5",
              reasoning: "high",
              speed: "fast",
              permission: "auto",
              unknownAttributes: "",
              rawAttributes: "",
            },
          },
        ],
        children: [],
      },
    ]);

    const nfmBlocks = blockNoteToNfm(agentConfigDoc);
    expect(nfmBlocks[0]?.type).toBe("paragraph");
    if (nfmBlocks[0]?.type !== "paragraph") return;
    expect(nfmBlocks[0].content[1]?.type).toBe("agentConfig");
    expect(serializeNfm(nfmBlocks)).toBe(
      'Use <agent-config mode="plan" provider="openai" model="gpt-5.5" reasoning="high" speed="fast" permission="auto" />',
    );

    const reloaded = nfmToBlockNote(nfmBlocks);
    const agentConfig = Array.isArray(reloaded[0]?.content) ? reloaded[0]?.content[1] : undefined;
    expect(agentConfig?.type).toBe("agentConfig");
    expect(agentConfig?.props.mode).toBe("plan");
    expect(agentConfig?.props.provider).toBe("openai");
    expect(agentConfig?.props.model).toBe("gpt-5.5");
    expect(agentConfig?.props.reasoning).toBe("high");
    expect(agentConfig?.props.speed).toBe("fast");
    expect(agentConfig?.props.permission).toBe("auto");
  });

  test("thread mention inline content round-trips between BlockNote and NFM", () => {
    const threadMentionDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "See ", styles: {} },
          {
            type: "threadMention",
            props: {
              uuid: "019-thread",
            },
          },
          { type: "text", text: " next", styles: {} },
        ],
        children: [],
      },
    ]);

    const nfmBlocks = blockNoteToNfm(threadMentionDoc);
    expect(nfmBlocks[0]?.type).toBe("paragraph");
    if (nfmBlocks[0]?.type !== "paragraph") return;
    expect(nfmBlocks[0].content[1]?.type).toBe("threadMention");
    expect(serializeNfm(nfmBlocks)).toBe('See <mention-thread uuid="019-thread" /> next');

    const reloaded = nfmToBlockNote(nfmBlocks);
    const mention = Array.isArray(reloaded[0]?.content) ? reloaded[0]?.content[1] : undefined;
    expect(mention?.type).toBe("threadMention");
    expect(mention?.props.uuid).toBe("019-thread");
  });

  test("Page mention inline content round-trips between BlockNote and NFM", () => {
    const pageMentionDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "See ", styles: {} },
          {
            type: "pageMention",
            props: {
              targetPageId: "page/alpha",
            },
          },
          { type: "text", text: " next", styles: {} },
        ],
        children: [],
      },
    ]);

    const nfmBlocks = blockNoteToNfm(pageMentionDoc);
    expect(nfmBlocks[0]?.type).toBe("paragraph");
    if (nfmBlocks[0]?.type !== "paragraph") return;
    expect(nfmBlocks[0].content[1]).toEqual({
      type: "pageMention",
      targetPageId: "page/alpha",
    });
    expect(serializeNfm(nfmBlocks)).toBe(
      'See <mention-page url="nodex://pages/page%2Falpha" /> next',
    );

    const reloaded = nfmToBlockNote(nfmBlocks);
    const mention = Array.isArray(reloaded[0]?.content) ? reloaded[0]?.content[1] : undefined;
    expect(mention?.type).toBe("pageMention");
    expect(mention?.props.targetPageId).toBe("page/alpha");
  });

  test("empty agent config props serialize as omitted attributes", () => {
    const agentConfigDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "Use ", styles: {} },
          {
            type: "agentConfig",
            props: {
              mode: "",
              model: "",
              reasoning: "",
              unknownAttributes: "",
              rawAttributes: "",
            },
          },
        ],
        children: [],
      },
    ]);

    expect(serializeNfm(blockNoteToNfm(agentConfigDoc))).toBe("Use <agent-config />");
  });

  test("folder attachments do not persist bytes through BlockNote round-trip", () => {
    const attachmentDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [
          {
            type: "attachment",
            props: {
              kind: "folder",
              mode: "link",
              source: "/tmp/Designs",
              name: "Designs",
              bytes: 4096,
            },
          },
        ],
        children: [],
      },
    ]);

    const nfmBlocks = blockNoteToNfm(attachmentDoc);
    expect(nfmBlocks[0]?.type).toBe("paragraph");
    if (nfmBlocks[0]?.type !== "paragraph") return;

    const attachment = nfmBlocks[0].content[0];
    expect(attachment?.type).toBe("attachment");
    if (attachment?.type !== "attachment") return;
    expect(attachment.bytes).toBe(undefined);

    const serialized = serializeNfm(nfmBlocks);
    expect(serialized.includes("bytes=")).toBe(false);
  });

  test("serialize toggle heading round-trip", () => {
    const nfm = "▶# Toggle Heading 1";
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("serialize toggle heading with color round-trip", () => {
    const nfm = '▶### Colored Toggle {color="blue"}';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("toggle heading NFM → BN sets isToggleable prop", () => {
    const blocks = parseNfm("▶## Toggle H2");
    const bnBlocks = nfmToBlockNote(blocks);
    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("heading");
    expect(bnBlocks[0].props.level).toBe(2);
    expect(bnBlocks[0].props.isToggleable).toBe(true);
  });

  test("regular heading NFM → BN does not set isToggleable", () => {
    const blocks = parseNfm("## Regular H2");
    const bnBlocks = nfmToBlockNote(blocks);
    expect(bnBlocks[0].props.isToggleable).toBe(undefined);
  });

  test("toggle heading BN → NFM preserves isToggleable", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "heading",
          props: { level: 1, isToggleable: true },
          content: [{ type: "text", text: "Toggle H1", styles: {} }],
          children: [],
        },
      ]),
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("heading");
    const heading = blocks[0] as { type: "heading"; isToggleable?: boolean };
    expect(heading.isToggleable).toBe(true);
  });

  test("toggle heading full round-trip through adapter", () => {
    const initialDoc = asDoc([
      {
        type: "heading",
        props: { level: 2, isToggleable: true },
        content: [{ type: "text", text: "My Toggle Heading", styles: {} }],
        children: [
          {
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "Child text", styles: {} }],
            children: [],
          },
        ],
      },
    ]);

    const nfm = serializeNfm(blockNoteToNfm(initialDoc));
    expect(nfm).toBe("▶## My Toggle Heading\n\tChild text");

    const reloadedDoc = nfmToBlockNote(parseNfm(nfm));
    expect(reloadedDoc.length).toBe(1);
    expect(reloadedDoc[0].type).toBe("heading");
    expect(reloadedDoc[0].props.level).toBe(2);
    expect(reloadedDoc[0].props.isToggleable).toBe(true);
    expect(extractText(reloadedDoc[0].content)).toBe("My Toggle Heading");
    expect(reloadedDoc[0].children.length).toBe(1);
  });

  test("serialize and parse image block round-trip", () => {
    const nfm =
      '<image source="nodex://assets/a.png" preview-width="480" source-width="1920" source-height="1080">Hello **world**</image>';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("image NFM → BN maps source, caption, preview width, and source geometry", () => {
    const blocks = parseNfm(
      '<image source="nodex://assets/a.png" preview-width="420" source-width="1600" source-height="900">caption</image>',
    );
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("image");
    expect(bnBlocks[0].props.url).toBe("nodex://assets/a.png");
    expect(bnBlocks[0].props.caption).toBe("caption");
    expect(bnBlocks[0].props.previewWidth).toBe(420);
    expect(bnBlocks[0].props.sourceWidth).toBe(1600);
    expect(bnBlocks[0].props.sourceHeight).toBe(900);
  });

  test("image BN → NFM maps url and caption", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "image",
          props: {
            url: "nodex://assets/a.png",
            caption: "my caption",
            previewWidth: 360,
            sourceWidth: 1200,
            sourceHeight: 800,
          },
          content: [],
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("image");
    const image = blocks[0] as {
      type: "image";
      source: string;
      caption: { type: string; text?: string }[];
      previewWidth?: number;
      sourceWidth?: number;
      sourceHeight?: number;
    };
    expect(image.source).toBe("nodex://assets/a.png");
    expect(image.previewWidth).toBe(360);
    expect(image.sourceWidth).toBe(1200);
    expect(image.sourceHeight).toBe(800);
    expect(image.caption.length).toBe(1);
    expect(image.caption[0].type).toBe("text");
    expect(image.caption[0].text).toBe("my caption");
  });

  test("unresolved image placeholder round-trips while upload is pending", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "image",
          props: {
            url: "",
            caption: "uploading...",
          },
          content: [],
          children: [],
        },
      ]),
    );

    expect(blocks).toMatchObject([
      {
        type: "image",
        source: "",
        caption: [{ type: "text", text: "uploading..." }],
      },
    ]);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe('<image source="">uploading...</image>');
    expect(parseNfm(serialized)).toMatchObject(blocks);
  });

  test("expanded toggle (▼) round-trips through parser/serializer", () => {
    const nfm = "▼ Open toggle\n\tChild paragraph";
    const blocks = parseNfm(nfm);
    expect(blocks[0].type).toBe("toggle");
    expect((blocks[0] as { isOpen?: boolean }).isOpen).toBe(true);

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("collapsed toggle (▶) round-trips without isOpen", () => {
    const nfm = "▶ Closed toggle\n\tChild paragraph";
    const blocks = parseNfm(nfm);
    expect(blocks[0].type).toBe("toggle");
    expect((blocks[0] as { isOpen?: boolean }).isOpen).toBe(undefined);

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("expanded toggle heading (▼#) round-trips", () => {
    const nfm = "▼## Open Heading";
    const blocks = parseNfm(nfm);
    expect(blocks[0].type).toBe("heading");
    const heading = blocks[0] as { isToggleable?: boolean; isOpen?: boolean };
    expect(heading.isToggleable).toBe(true);
    expect(heading.isOpen).toBe(true);

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("collapsed toggle heading (▶#) round-trips without isOpen", () => {
    const nfm = "▶## Closed Heading";
    const blocks = parseNfm(nfm);
    const heading = blocks[0] as { isToggleable?: boolean; isOpen?: boolean };
    expect(heading.isToggleable).toBe(true);
    expect(heading.isOpen).toBe(undefined);

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("nfmToBlockNote with toggleStates collects open state", () => {
    const nfm = "▼ Open\n\tChild\n▶ Closed";
    const blocks = parseNfm(nfm);
    const toggleStates = new Map<string, boolean>();
    const bnBlocks = nfmToBlockNote(blocks, toggleStates);

    expect(toggleStates.size).toBe(2);
    // First block should be open
    expect(toggleStates.get(bnBlocks[0].id)).toBe(true);
    // Second block should be closed
    expect(toggleStates.get(bnBlocks[1].id)).toBe(false);
  });

  test("nfmToBlockNote with toggleStates assigns IDs to toggle blocks", () => {
    const blocks = parseNfm("▶ Toggle\n# Regular heading");
    const toggleStates = new Map<string, boolean>();
    const bnBlocks = nfmToBlockNote(blocks, toggleStates);

    // Toggle block should have an assigned ID
    expect(typeof bnBlocks[0].id).toBe("string");
    // Regular heading should not have an assigned ID
    expect(bnBlocks[1].id).toBe(undefined);
  });

  test("nfmToBlockNote without toggleStates does not assign IDs", () => {
    const blocks = parseNfm("▶ Toggle");
    const bnBlocks = nfmToBlockNote(blocks);

    // Should not have an assigned ID when no toggleStates map provided
    expect(bnBlocks[0].id).toBe(undefined);
  });

  test("page-ref BN → NFM emits only the canonical Page target", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "pageRef",
          props: {
            targetBlockId: "abc1234",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("pageRef");
    if (blocks[0].type !== "pageRef") return;
    expect(blocks[0].targetBlockId).toBe("abc1234");
  });

  test("page-ref with an empty target remains explicit and invalidatable", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "pageRef",
          props: {
            targetBlockId: "",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("pageRef");
    if (blocks[0].type !== "pageRef") return;
    expect(blocks[0].targetBlockId).toBe("");
  });

  test("serialize and parse thread-section round-trip", () => {
    const nfm = '<thread-section label="Investigate parser" thread="thr_123" />';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("thread-section NFM → BN maps custom props", () => {
    const blocks = parseNfm('<thread-section label="Investigate parser" thread="thr_123" />');
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("threadSection");
    expect(bnBlocks[0].props.label).toBe("Investigate parser");
    expect(bnBlocks[0].props.threadId).toBe("thr_123");
  });

  test("thread-section BN → NFM maps custom props", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "threadSection",
          props: {
            label: "Investigate parser",
            threadId: "thr_123",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("threadSection");
    if (blocks[0].type !== "threadSection") return;
    expect(blocks[0].label).toBe("Investigate parser");
    expect(blocks[0].threadId).toBe("thr_123");
  });

  test("thread-section NFM → BN hoists nested children", () => {
    const blocks = parseNfm(`<thread-section label="Investigate parser" thread="thr_123" />
\tChild note`);
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(2);
    expect(bnBlocks[0].type).toBe("threadSection");
    expect(bnBlocks[0].children.length).toBe(0);
    expect(extractText(bnBlocks[1]?.content)).toBe("Child note");
  });

  test("thread-section BN → NFM hoists nested children", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "threadSection",
          props: {
            label: "Investigate parser",
            threadId: "thr_123",
          },
          content: undefined,
          children: [
            {
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Child note", styles: {} }],
              children: [],
            },
          ],
        },
      ]),
    );

    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe("threadSection");
    if (blocks[0].type !== "threadSection") return;
    expect(blocks[0].children.length).toBe(0);
    expect(serializeNfm(blocks)).toBe(
      `<thread-section label="Investigate parser" thread="thr_123" />\nChild note`,
    );
  });

  test("inline hard line breaks still round-trip", () => {
    const initialDoc = asDoc([
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "alpha\nbeta", styles: {} }],
        children: [],
      },
    ]);

    const nfm = serializeNfm(blockNoteToNfm(initialDoc));
    const reloadedDoc = nfmToBlockNote(parseNfm(nfm));

    expect(nfm).toBe("alpha<br>beta");
    expect(reloadedDoc.length).toBe(1);
    expect(reloadedDoc[0].type).toBe("paragraph");
    expect(extractText(reloadedDoc[0].content)).toBe("alpha\nbeta");
  });
});
