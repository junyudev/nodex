import { describe, expect, test } from "bun:test";

import { blockNoteToNfm, nfmToBlockNote } from "./blocknote-adapter";
import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(Array.isArray(reloadedDoc[1].content)).toBeTrue();
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
    expect("color" in blocks[0]).toBeTrue();
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
    const heading = blocks[0] as { type: "heading"; level: number; isToggleable?: boolean; color?: string };
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
    const nfm = 'before <attachment kind="file" mode="link" source="/tmp/My &amp; Stuff/report.txt" name="report &amp; notes.txt" mime="text/plain" bytes="42" origin="/tmp/My &amp; Stuff/report.txt" /> after';
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
    expect(serialized.includes("bytes=")).toBeFalse();
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
    const nfm = '<image source="nodex://assets/a.png">Hello **world**</image>';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("image NFM → BN maps source, caption, and preview width", () => {
    const blocks = parseNfm(
      '<image source="nodex://assets/a.png" preview-width="420">caption</image>',
    );
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("image");
    expect(bnBlocks[0].props.url).toBe("nodex://assets/a.png");
    expect(bnBlocks[0].props.caption).toBe("caption");
    expect(bnBlocks[0].props.previewWidth).toBe(420);
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
    };
    expect(image.source).toBe("nodex://assets/a.png");
    expect(image.previewWidth).toBe(360);
    expect(image.caption.length).toBe(1);
    expect(image.caption[0].type).toBe("text");
    expect(image.caption[0].text).toBe("my caption");
  });

  test("serialize and parse toggle-list inline view round-trip", () => {
    const nfm = '<toggle-list-inline-view project="default" statuses="5-ready" priorities="p1-high,p2-medium" tags="frontend,ui" tag-mode="all" rank-primary="priority" rank-primary-direction="desc" rank-secondary="created" rank-secondary-direction="asc" property-order="status,priority,estimate,tags" hidden-properties="estimate,tags" include-host-card="true" show-empty-estimate="true" />';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(
      '<toggle-list-inline-view project="default" property-order="status,priority,estimate,tags" hidden-properties="estimate,tags" show-empty-estimate="true" />',
    );
  });

  test("toggle-list inline view NFM → BN ignores legacy filter and rank props", () => {
    const blocks = parseNfm(
      '<toggle-list-inline-view project="default" statuses="5-ready,6-in-progress" priorities="p0-critical" tags="frontend,ui" tag-mode="none" rank-primary="status" rank-primary-direction="asc" rank-secondary="title" rank-secondary-direction="desc" property-order="priority,status,estimate,tags" hidden-properties="estimate,tags" include-host-card="true" show-empty-estimate="true" />',
    );
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("toggleListInlineView");
    expect(bnBlocks[0].props.sourceProjectId).toBe("default");
    expect(bnBlocks[0].props.rulesV2B64).toBe("");
    expect(bnBlocks[0].props.propertyOrderCsv).toBe("priority,status,estimate,tags");
    expect(bnBlocks[0].props.hiddenPropertiesCsv).toBe("estimate,tags");
    expect(bnBlocks[0].props.showEmptyEstimate).toBe("true");
  });

  test("toggle-list inline view BN → NFM drops legacy inline props", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "toggleListInlineView",
          props: {
            sourceProjectId: "default",
            statusesCsv: "5-ready,6-in-progress",
            prioritiesCsv: "p0-critical,p1-high",
            tagsCsv: "frontend,ui",
            tagMode: "all",
            rankPrimary: "status",
            rankPrimaryDirection: "asc",
            rankSecondary: "created",
            rankSecondaryDirection: "desc",
            propertyOrderCsv: "priority,status,estimate,tags",
            hiddenPropertiesCsv: "estimate,tags",
            includeHostCard: "true",
            showEmptyEstimate: "true",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("toggleListInlineView");
    if (blocks[0].type !== "toggleListInlineView") return;
    expect(blocks[0].sourceProjectId).toBe("default");
    expect(blocks[0].rulesV2B64).toBe(undefined);
    expect(JSON.stringify(blocks[0].propertyOrder)).toBe(JSON.stringify(["priority", "status", "estimate", "tags"]));
    expect(JSON.stringify(blocks[0].hiddenProperties)).toBe(JSON.stringify(["estimate", "tags"]));
    expect(blocks[0].showEmptyEstimate).toBeTrue();
  });

  test("toggle-list inline view legacy rules-panel attr is not re-serialized", () => {
    const serialized = serializeNfm(
      parseNfm('<toggle-list-inline-view project="default" rules-panel-expanded="false" />'),
    );

    expect(serialized).toBe('<toggle-list-inline-view project="default" />');
  });

  test("toggle-list inline view preserves rules-v2 attribute", () => {
    const nfm = '<toggle-list-inline-view project="default" rules-v2="eyJtb2RlIjoiYWR2YW5jZWQifQ" />';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    const bnBlocks = nfmToBlockNote(blocks);

    expect(serialized).toBe(nfm);
    expect(bnBlocks[0]?.props.rulesV2B64).toBe("eyJtb2RlIjoiYWR2YW5jZWQifQ");
  });

  test("toggle-list inline view BN -> NFM serializes rules-v2 attribute", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "toggleListInlineView",
          props: {
            sourceProjectId: "default",
            rulesV2B64: "eyJ0ZXN0Ijp0cnVlfQ",
            statusesCsv: "",
            prioritiesCsv: "",
            includeHostCard: "false",
            rankPrimary: "board-order",
            rankPrimaryDirection: "asc",
            rankSecondary: "created",
            rankSecondaryDirection: "desc",
            propertyOrderCsv: "priority,estimate,status,tags",
            hiddenPropertiesCsv: "",
            showEmptyEstimate: "false",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    const serialized = serializeNfm(blocks);
    expect(serialized.includes('rules-v2="eyJ0ZXN0Ijp0cnVlfQ"')).toBeTrue();
  });

  test("unresolved image placeholder is dropped during BN → NFM conversion", () => {
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

    expect(blocks.length).toBe(0);
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

  test("serialize and parse card-ref round-trip", () => {
    const nfm = '<card-ref project="my-project" card="abc1234" />';
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("card-ref NFM → BN maps custom props", () => {
    const blocks = parseNfm(
      '<card-ref project="my-project" card="abc1234" />',
    );
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("cardRef");
    expect(bnBlocks[0].props.sourceProjectId).toBe("my-project");
    expect(bnBlocks[0].props.cardId).toBe("abc1234");
  });

  test("card-ref BN → NFM maps custom props", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "cardRef",
          props: {
            sourceProjectId: "my-project",
            cardId: "abc1234",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("cardRef");
    if (blocks[0].type !== "cardRef") return;
    expect(blocks[0].sourceProjectId).toBe("my-project");
    expect(blocks[0].cardId).toBe("abc1234");
  });

  test("card-ref with empty cardId survives BN → NFM round-trip", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "cardRef",
          props: {
            sourceProjectId: "default",
            cardId: "",
          },
          content: undefined,
          children: [],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("cardRef");
    if (blocks[0].type !== "cardRef") return;
    expect(blocks[0].cardId).toBe("");
  });

  test("card-ref with missing card attribute parses with empty cardId", () => {
    const blocks = parseNfm('<card-ref project="my-project" />');
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("cardRef");
    if (blocks[0].type !== "cardRef") return;
    expect(blocks[0].cardId).toBe("");
  });

  test("childless blocks are normalized by hoisting nested children", () => {
    const blocks = parseNfm(`<toggle-list-inline-view project="default" />
\tNested paragraph
<card-ref project="default" card="abc" />
\tNested card child`);

    expect(blocks.length).toBe(4);
    expect(blocks[0]?.type).toBe("toggleListInlineView");
    expect(blocks[1]?.type).toBe("paragraph");
    expect(blocks[2]?.type).toBe("cardRef");
    expect(blocks[3]?.type).toBe("paragraph");
    if (blocks[0]?.type === "toggleListInlineView") {
      expect(blocks[0].children.length).toBe(0);
    }
    if (blocks[2]?.type === "cardRef") {
      expect(blocks[2].children.length).toBe(0);
    }
  });

  test("childless block serialization drops nested children", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "toggleListInlineView",
          props: {
            sourceProjectId: "default",
            statusesCsv: "",
            prioritiesCsv: "",
            includeHostCard: "false",
            rankPrimary: "board-order",
            rankPrimaryDirection: "asc",
            rankSecondary: "created",
            rankSecondaryDirection: "desc",
            propertyOrderCsv: "priority,estimate,status,tags",
            hiddenPropertiesCsv: "",
            showEmptyEstimate: "false",
          },
          children: [
            {
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Should not persist", styles: {} }],
              children: [],
            },
          ],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0]?.type).toBe("toggleListInlineView");
    if (blocks[0]?.type !== "toggleListInlineView") return;
    expect(blocks[0].children.length).toBe(0);
    expect(serializeNfm(blocks).includes("Should not persist")).toBeFalse();
  });

  test("serialize and parse card-toggle round-trip", () => {
    const nfm = `<card-toggle card=\"abc123\" meta=\"[P1] [In Progress]\" snapshot=\"c25hcHNob3Q=\" project=\"default\" column=\"6-in-progress\" column-name=\"In Progress\">
\tDropped card
\tChild details
</card-toggle>`;
    const blocks = parseNfm(nfm);
    const serialized = serializeNfm(blocks);
    expect(serialized).toBe(nfm);
  });

  test("card-toggle NFM → BN maps props and children", () => {
    const blocks = parseNfm(`<card-toggle card=\"abc123\" meta=\"[P1]\" snapshot=\"c25hcA==\" project=\"default\" column=\"6-in-progress\" column-name=\"In Progress\">
\tDropped card
\tChild details
</card-toggle>`);
    const bnBlocks = nfmToBlockNote(blocks);

    expect(bnBlocks.length).toBe(1);
    expect(bnBlocks[0].type).toBe("cardToggle");
    expect(bnBlocks[0].props.cardId).toBe("abc123");
    expect(bnBlocks[0].props.meta).toBe("[P1]");
    expect(bnBlocks[0].props.snapshot).toBe("c25hcA==");
    expect(bnBlocks[0].props.sourceProjectId).toBe("default");
    expect(bnBlocks[0].props.sourceColumnId).toBe("6-in-progress");
    expect(bnBlocks[0].props.sourceColumnName).toBe("In Progress");
    expect(extractText(bnBlocks[0].content)).toBe("Dropped card");
    expect(bnBlocks[0].children.length).toBe(1);
  });

  test("card-toggle BN → NFM maps props and children", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "cardToggle",
          props: {
            cardId: "abc123",
            meta: "[P1]",
            snapshot: "c25hcA==",
            sourceProjectId: "default",
            sourceColumnId: "6-in-progress",
            sourceColumnName: "In Progress",
          },
          content: [{ type: "text", text: "Dropped card", styles: {} }],
          children: [
            {
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Child details", styles: {} }],
              children: [],
            },
          ],
        },
      ]),
    );

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("cardToggle");
    if (blocks[0].type !== "cardToggle") return;
    expect(blocks[0].cardId).toBe("abc123");
    expect(blocks[0].meta).toBe("[P1]");
    expect(blocks[0].snapshot).toBe("c25hcA==");
    expect(blocks[0].sourceProjectId).toBe("default");
    expect(blocks[0].sourceColumnId).toBe("6-in-progress");
    expect(blocks[0].sourceColumnName).toBe("In Progress");
    expect(blocks[0].children.length).toBe(1);
  });

  test("card-toggle with empty title preserves children across serialize+parse", () => {
    const blocks = blockNoteToNfm(
      asDoc([
        {
          type: "cardToggle",
          props: {
            cardId: "abc123",
            meta: "[P1]",
          },
          content: [],
          children: [
            {
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Child details", styles: {} }],
              children: [],
            },
          ],
        },
      ]),
    );

    const serialized = serializeNfm(blocks);
    const parsed = parseNfm(serialized);

    expect(serialized.includes("<card-toggle card=\"abc123\" meta=\"[P1]\">")).toBeTrue();
    expect(serialized.includes("\n\t\n\tChild details\n")).toBeTrue();
    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe("cardToggle");
    if (parsed[0].type !== "cardToggle") return;
    expect(parsed[0].content.length).toBe(0);
    expect(parsed[0].children.length).toBe(1);
    expect(parsed[0].children[0]?.type).toBe("paragraph");
  });

  test("card-toggle parser treats omitted title as children for block-like first line", () => {
    const parsed = parseNfm(`<card-toggle card=\"abc123\" meta=\"[P1]\">
\t- first child
</card-toggle>`);

    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe("cardToggle");
    if (parsed[0].type !== "cardToggle") return;
    expect(parsed[0].content.length).toBe(0);
    expect(parsed[0].children.length).toBe(1);
    expect(parsed[0].children[0]?.type).toBe("bulletListItem");
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
