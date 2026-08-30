import { describe, expect, test } from "vite-plus/test";
import type { NfmBlock } from "./types";
import { serializeClipboardText } from "./clipboard-text-serializer";
import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";

describe("NFM code fences", () => {
  test("round-trips block and inline equations without storing rendered output", () => {
    const input = ["Energy is $E = mc^2$ today", "$$", "\\frac{a}{b}", "$$"].join("\n");

    const blocks = parseNfm(input);

    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Energy is ", styles: {} },
          { type: "math", source: "E = mc^2" },
          { type: "text", text: " today", styles: {} },
        ],
        children: [],
      },
      { type: "mathBlock", source: "\\frac{a}{b}", children: [] },
    ]);
    expect(serializeNfm(blocks)).toBe(input);
  });

  test("uses collision-safe equation fences and protected inline source", () => {
    const blocks = [
      {
        type: "paragraph",
        content: [
          { type: "math", source: "price = $5 and `raw`" },
          { type: "text", text: " after", styles: {} },
        ],
        children: [],
      },
      { type: "mathBlock", source: "x = 1\n$$\ny = 2", children: [] },
    ] satisfies NfmBlock[];

    const serialized = serializeNfm(blocks);

    expect(serialized).toBe("$`` price = $5 and `raw` ``$ after\n$$$\nx = 1\n$$\ny = 2\n$$$");
    expect(parseNfm(serialized)).toEqual(blocks);
  });

  test("keeps escaped dollars and unclosed equation fences as literal text", () => {
    const blocks = parseNfm("Cost is \\$5 and $$not closed");

    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Cost is $5 and $$not closed", styles: {} }],
        children: [],
      },
    ]);
  });

  test("round-trips inline equations next to sentence punctuation", () => {
    const input = "Energy is $E = mc^2$. See ($x + 1$).";

    const blocks = parseNfm(input);

    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Energy is ", styles: {} },
          { type: "math", source: "E = mc^2" },
          { type: "text", text: ". See (", styles: {} },
          { type: "math", source: "x + 1" },
          { type: "text", text: ").", styles: {} },
        ],
        children: [],
      },
    ]);
    expect(serializeNfm(blocks)).toBe(input);
  });

  test("Canvas owner shells require and preserve an exact uuid", () => {
    const nfm = '<canvas uuid="canvas-1" />';
    const blocks = parseNfm(nfm);

    expect(blocks).toEqual([
      {
        type: "canvas",
        uuid: "canvas-1",
        children: [],
      },
    ]);
    expect(serializeNfm(blocks)).toBe(nfm);
    expect(() => parseNfm("<canvas />")).toThrow(
      "Canonical Canvas NFM requires an exact non-empty uuid",
    );
    expect(() => parseNfm('<canvas uuid=" canvas-1" />')).toThrow(
      "Canonical Canvas NFM requires an exact non-empty uuid",
    );
  });

  test("keeps Card identity and mention URL tags in clipboard text", () => {
    const nfm = ['<page uuid="019f-card" />', '<page-ref url="nodex://pages/019f-target" />'].join(
      "\n",
    );

    expect(serializeClipboardText(parseNfm(nfm))).toBe(nfm);
  });

  test("GFM tables parse and serialize with alignment", () => {
    const input =
      "| Name | Status | Score |\n| :--- | :---: | ---: |\n| Alpha | **Ready** | 10 |\n| Beta | Blocked | 2 |";
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("table");
    if (blocks[0]?.type !== "table") return;

    expect(blocks[0].headerRow).toBe(true);
    expect(blocks[0].columns.length).toBe(3);
    expect(blocks[0].columns[0]?.align).toBe("left");
    expect(blocks[0].columns[1]?.align).toBe("center");
    expect(blocks[0].columns[2]?.align).toBe("right");
    expect(blocks[0].rows.length).toBe(3);
    expect(blocks[0].rows[1]?.cells[1]?.content[0]?.type).toBe("text");
    if (blocks[0].rows[1]?.cells[1]?.content[0]?.type !== "text") return;
    expect(blocks[0].rows[1].cells[1].content[0].styles.bold).toBe(true);
    expect(serializeNfm(blocks)).toBe(input);
    expect(serializeClipboardText(blocks)).toBe(
      "Name\tStatus\tScore\nAlpha\tReady\t10\nBeta\tBlocked\t2",
    );
  });

  test("GFM tables preserve escaped pipes inside cells", () => {
    const input = "| Key | Value |\n| --- | --- |\n| literal | a \\| b |";
    const blocks = parseNfm(input);

    expect(blocks[0]?.type).toBe("table");
    if (blocks[0]?.type !== "table") return;
    expect(blocks[0].rows[1]?.cells[1]?.content[0]?.type).toBe("text");
    if (blocks[0].rows[1]?.cells[1]?.content[0]?.type !== "text") return;

    expect(blocks[0].rows[1].cells[1].content[0].text).toBe("a | b");
    expect(serializeNfm(blocks)).toBe(input);
  });

  test("GFM table delimiter mismatch falls back to paragraphs", () => {
    const input = "| A | B |\n| --- |\n| value | value |";
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(3);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[1]?.type).toBe("paragraph");
    expect(blocks[2]?.type).toBe("paragraph");
  });

  test("lossless NFM table syntax round-trips header column, width, and colors", () => {
    const input = `<table header-row="false" header-column="true" fit-page-width="true">
\t<colgroup>
\t\t<col width="180" color="blue_bg" align="right" />
\t\t<col />
\t</colgroup>
\t<tr color="gray_bg">
\t\t<td>Task</td>
\t\t<td color="green_bg">Done</td>
\t</tr>
</table>`;
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("table");
    if (blocks[0]?.type !== "table") return;

    expect(blocks[0].headerRow).toBe(undefined);
    expect(blocks[0].headerColumn).toBe(true);
    expect(blocks[0].fitPageWidth).toBe(true);
    expect(blocks[0].columns[0]?.width).toBe(180);
    expect(blocks[0].columns[0]?.color).toBe("blue_bg");
    expect(blocks[0].columns[0]?.align).toBe("right");
    expect(blocks[0].rows[0]?.color).toBe("gray_bg");
    expect(blocks[0].rows[0]?.cells[1]?.color).toBe("green_bg");
    expect(serializeNfm(blocks)).toBe(input);
  });

  test("serializeNfm uses a longer fence when code contains triple backticks", () => {
    const blocks = [
      {
        type: "codeBlock",
        language: "ts",
        code: "const a = 1;\n```\nconst b = 2;",
        children: [],
      },
    ] satisfies NfmBlock[];

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe("````ts\nconst a = 1;\n```\nconst b = 2;\n````");

    const reparsed = parseNfm(serialized);
    expect(reparsed.length).toBe(1);
    expect(reparsed[0]?.type).toBe("codeBlock");
    if (reparsed[0]?.type !== "codeBlock") return;

    expect(reparsed[0].language).toBe("ts");
    expect(reparsed[0].code).toBe("const a = 1;\n```\nconst b = 2;");
    expect(reparsed[0].children.length).toBe(0);
  });

  test("parseNfm accepts tilde fences and ignores shorter interior runs", () => {
    const input = "~~~~js\nconst a = 1;\n~~~\nconst b = 2;\n~~~~";

    const parsed = parseNfm(input);

    expect(parsed.length).toBe(1);
    expect(parsed[0]?.type).toBe("codeBlock");
    if (parsed[0]?.type !== "codeBlock") return;

    expect(parsed[0].language).toBe("js");
    expect(parsed[0].code).toBe("const a = 1;\n~~~\nconst b = 2;");
  });

  test("parseNfm accepts a longer closing fence than the opener", () => {
    const input = "````\nvalue\n`````";

    const parsed = parseNfm(input);

    expect(parsed.length).toBe(1);
    expect(parsed[0]?.type).toBe("codeBlock");
    if (parsed[0]?.type !== "codeBlock") return;

    expect(parsed[0].language).toBe("");
    expect(parsed[0].code).toBe("value");
  });

  test("attachments round-trip inline while legacy resource tags fall back to plain text", () => {
    const attachmentNfm =
      'before <attachment kind="file" mode="link" source="/tmp/report.txt" name="report.txt" /> after';
    const attachmentBlocks = parseNfm(attachmentNfm);

    expect(attachmentBlocks[0]?.type).toBe("paragraph");
    expect(serializeNfm(attachmentBlocks)).toBe(attachmentNfm);
    expect(serializeClipboardText(attachmentBlocks)).toBe("before [Attachment: report.txt] after");

    const legacyBlocks = parseNfm(
      '<resource kind="file" mode="link" source="/tmp/report.txt" name="report.txt" />',
    );
    expect(legacyBlocks[0]?.type).toBe("paragraph");
    expect(serializeNfm(legacyBlocks)).toBe(
      '\\<resource kind="file" mode="link" source="/tmp/report.txt" name="report.txt" /\\>',
    );
  });

  test("agent config round-trips inline", () => {
    const nfm =
      'before <agent-config mode="plan" provider="openai" model="gpt-5.5" reasoning="high" speed="fast" permission="auto" /> after';
    const blocks = parseNfm(nfm);

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;
    expect(blocks[0].content[1]?.type).toBe("agentConfig");
    if (blocks[0].content[1]?.type !== "agentConfig") return;
    expect(blocks[0].content[1].mode).toBe("plan");
    expect(blocks[0].content[1].provider).toBe("openai");
    expect(blocks[0].content[1].model).toBe("gpt-5.5");
    expect(blocks[0].content[1].reasoning).toBe("high");
    expect(blocks[0].content[1].speed).toBe("fast");
    expect(blocks[0].content[1].permission).toBe("auto");
    expect(serializeNfm(blocks)).toBe(nfm);
    expect(serializeClipboardText(blocks)).toBe(nfm);
  });

  test("thread mentions round-trip inline and copy as readable placeholders", () => {
    const nfm =
      'before <mention-thread uuid="019abc" /> and <mention-thread uuid="thread &amp; value" /> after';
    const blocks = parseNfm(nfm);

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;

    expect(blocks[0].content[1]?.type).toBe("threadMention");
    if (blocks[0].content[1]?.type !== "threadMention") return;
    expect(blocks[0].content[1].uuid).toBe("019abc");

    expect(blocks[0].content[3]?.type).toBe("threadMention");
    if (blocks[0].content[3]?.type !== "threadMention") return;
    expect(blocks[0].content[3].uuid).toBe("thread & value");
    expect(serializeNfm(blocks)).toBe(nfm);
    expect(serializeClipboardText(blocks)).toBe(
      "before [Thread: 019abc] and [Thread: thread & value] after",
    );
  });

  test("missing or empty thread mention uuids remain plain text", () => {
    const blocks = parseNfm('<mention-thread /> <mention-thread uuid="" />');

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;
    expect(blocks[0].content.length).toBe(1);
    expect(blocks[0].content[0]?.type).toBe("text");
    expect(serializeNfm(blocks)).toBe('\\<mention-thread /\\> \\<mention-thread uuid="" /\\>');
  });

  test("Page mentions round-trip through canonical deeplinks", () => {
    const nfm = 'before <mention-page url="nodex://pages/page%2Falpha" /> after';
    const blocks = parseNfm(nfm);

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;
    expect(blocks[0].content[1]).toEqual({
      type: "pageMention",
      targetPageId: "page/alpha",
    });
    expect(serializeNfm(blocks)).toBe(nfm);
    expect(serializeClipboardText(blocks)).toBe("before [Page: page/alpha] after");
  });

  test("invalid Page mention tags remain plain text", () => {
    const blocks = parseNfm(
      [
        '<mention-page url="https://example.com/page" />',
        '<mention-page url="nodex://pages/page-1" title="stale" />',
        "<mention-page />",
      ].join(" "),
    );

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;
    expect(blocks[0].content).toHaveLength(1);
    expect(blocks[0].content[0]?.type).toBe("text");
  });

  test("date mentions round-trip inline and copy as deterministic labels", () => {
    const nfm =
      'before <mention-date start="2026-06-28" format="relative" /> and <mention-date start="2026-06-28T14:30:00+08:00" tz="Asia/Shanghai" format="relative" time-format="12h" reminder="minute:0" /> after';
    const blocks = parseNfm(nfm);

    expect(blocks[0]?.type).toBe("paragraph");
    if (blocks[0]?.type !== "paragraph") return;

    expect(blocks[0].content[1]?.type).toBe("dateMention");
    if (blocks[0].content[1]?.type !== "dateMention") return;
    expect(blocks[0].content[1].start).toBe("2026-06-28");
    expect(blocks[0].content[1].format).toBe("relative");

    expect(blocks[0].content[3]?.type).toBe("dateMention");
    if (blocks[0].content[3]?.type !== "dateMention") return;
    expect(blocks[0].content[3].start).toBe("2026-06-28T14:30:00+08:00");
    expect(blocks[0].content[3].tz).toBe("Asia/Shanghai");
    expect(blocks[0].content[3].reminder).toBe("minute:0");
    expect(serializeNfm(blocks)).toBe(nfm);
    expect(serializeClipboardText(blocks)).toBe(
      "before @Jun 28, 2026 and @Jun 28, 2026 2:30 PM after",
    );
  });

  test("date mention parser rejects invalid payloads and repairs reversed ranges", () => {
    const invalidBlocks = parseNfm(
      '<mention-date /> <mention-date start="2026-02-30" /> <mention-date type="date" start-date="2026-06-28" />',
    );

    expect(invalidBlocks[0]?.type).toBe("paragraph");
    if (invalidBlocks[0]?.type !== "paragraph") return;
    expect(invalidBlocks[0].content.length).toBe(1);
    expect(invalidBlocks[0].content[0]?.type).toBe("text");
    expect(serializeNfm(invalidBlocks)).toBe(
      '\\<mention-date /\\> \\<mention-date start="2026-02-30" /\\> \\<mention-date type="date" start-date="2026-06-28" /\\>',
    );

    const rangeBlocks = parseNfm(
      '<mention-date start="2026-06-30" end="2026-06-28" format="ll" />',
    );
    expect(serializeNfm(rangeBlocks)).toBe(
      '<mention-date start="2026-06-28" end="2026-06-30" format="ll" />',
    );
  });

  test("ordered list markers round-trip exactly and plain-text copy preserves numbering", () => {
    const input = "1. first\n2. second\n3. third";
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(3);
    expect(blocks[0]?.type).toBe("numberedListItem");
    expect(blocks[1]?.type).toBe("numberedListItem");
    expect(blocks[2]?.type).toBe("numberedListItem");

    if (blocks[0]?.type !== "numberedListItem") return;
    if (blocks[1]?.type !== "numberedListItem") return;
    if (blocks[2]?.type !== "numberedListItem") return;

    expect(blocks[0].start).toBe(1);
    expect(blocks[1].start).toBe(2);
    expect(blocks[2].start).toBe(3);
    expect(serializeNfm(blocks)).toBe(input);
    expect(serializeClipboardText(blocks)).toBe(input);
  });

  test("ordered list numbering restarts after a non-list block", () => {
    const input = "3. third\n4. fourth\nParagraph break\n1. reset";
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(4);
    expect(blocks[0]?.type).toBe("numberedListItem");
    expect(blocks[1]?.type).toBe("numberedListItem");
    expect(blocks[2]?.type).toBe("paragraph");
    expect(blocks[3]?.type).toBe("numberedListItem");

    if (blocks[0]?.type !== "numberedListItem") return;
    if (blocks[1]?.type !== "numberedListItem") return;
    if (blocks[3]?.type !== "numberedListItem") return;

    expect(blocks[0].start).toBe(3);
    expect(blocks[1].start).toBe(4);
    expect(blocks[3].start).toBe(1);
    expect(serializeNfm(blocks)).toBe(input);
    expect(serializeClipboardText(blocks)).toBe(input);
  });

  test("nested ordered list numbering stays independent per sibling run", () => {
    const input = "1. parent\n\t3. child three\n\t4. child four\n2. parent two";
    const blocks = parseNfm(input);

    expect(blocks.length).toBe(2);
    expect(blocks[0]?.type).toBe("numberedListItem");
    expect(blocks[1]?.type).toBe("numberedListItem");
    if (blocks[0]?.type !== "numberedListItem") return;
    if (blocks[1]?.type !== "numberedListItem") return;

    expect(blocks[0].start).toBe(1);
    expect(blocks[1].start).toBe(2);
    expect(blocks[0].children.length).toBe(2);
    expect(blocks[0].children[0]?.type).toBe("numberedListItem");
    expect(blocks[0].children[1]?.type).toBe("numberedListItem");
    if (blocks[0].children[0]?.type !== "numberedListItem") return;
    if (blocks[0].children[1]?.type !== "numberedListItem") return;

    expect(blocks[0].children[0].start).toBe(3);
    expect(blocks[0].children[1].start).toBe(4);
    expect(serializeNfm(blocks)).toBe(input);
    expect(serializeClipboardText(blocks)).toBe(input);
  });
});
