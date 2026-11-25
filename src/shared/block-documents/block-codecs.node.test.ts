import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createBlockDocumentMarkdownContentParitySignature,
  createPageDocumentGenesis,
  createDetachedPageDocumentFromBlockTree,
  materializePageDocument,
  materializeBlockFields,
  BlockDocumentCodecError,
} from "./block-document-codec";
import {
  MAX_PORTABLE_RICH_TEXT_SEGMENTS,
  canonicalizePortableRichText,
  plainTextToPortableRichText,
  portableRichTextFromYTextDelta,
  portableRichTextPlainText,
  portableRichTextSemanticSource,
  readPortableRichTextFromYText,
  replaceYTextWithPortableRichText,
  type PortableRichText,
} from "./portable-rich-text";
import { readMarkdown, writeMarkdown } from "../nodex-markdown";

describe("block document codec", () => {
  const FULL_MARKDOWN_FIXTURE =
    '# Heading\n\nParagraph **bold** with :agent-config{mode="plan" model="gpt-5.5" reasoning="high"} and <nodex://sessions/thread-1> and :date{start="2026-07-11" format="relative"}&#46;\n\n- List\n\n  Nested :attachment{kind="file" source="nodex://assets/demo.txt" name="demo.txt" mime="text/plain" bytes="12"}\n\n3. Ordered\n- [x] Checked\n\n:::toggle[Collapsed toggle]\n  Toggle child\n:::\n\n> Quoted\n\n---\n\n> [!TIP]\n>\n> ![Image caption](nodex://assets/image.png)\n>\n> ::page-ref{page="card-target"}\n>\n> ::page-ref{page="card-canonical"}\n>\n> ::database-view-ref{view="view-canonical" hint="Planning"}\n>\n> ```typescript\n> const value = 1;\n> ```\n>\n> | Name | Score |\n> | --- | ---: |\n> | Nodex | 10 |';

  const flattenIds = (
    blocks: readonly { readonly id: string; readonly children: readonly unknown[] }[],
  ): string[] =>
    blocks.flatMap((block) => [
      block.id,
      ...flattenIds(
        block.children as readonly {
          readonly id: string;
          readonly children: readonly unknown[];
        }[],
      ),
    ]);

  describe("PageDocumentCodec", () => {
    test("incremental history fields agree with full materialization for rich text, custom blocks, and tables", () => {
      const { document, materialization } = createPageDocumentGenesis({
        documentId: "history-fields-all-shapes",
        markdown: FULL_MARKDOWN_FIXTURE,
      });
      const expected = new Map<string, unknown>();
      const collect = (blocks: typeof materialization.blockTree): void => {
        for (const block of blocks) {
          expected.set(block.id, { ...block, children: [] });
          collect(block.children);
        }
      };
      collect(materialization.blockTree);
      try {
        for (const node of document
          .getXmlFragment("body")
          .createTreeWalker((node) => node instanceof Y.XmlElement)) {
          if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer") continue;
          const fields = materializeBlockFields(node);
          expect(fields).toEqual(expected.get(fields.id));
          expected.delete(fields.id);
        }
        expect(expected.size).toBe(0);
      } finally {
        document.destroy();
      }
    });

    test("excludes imported toggle disclosure state from durable content", () => {
      const markdown =
        ':::toggle[Expanded toggle]\n  Expanded child\n:::\n\n:::toggle[Expanded heading]{heading="1"}\n  Heading child\n:::';

      const genesis = createPageDocumentGenesis({
        documentId: "document-codec-local-toggle-state",
        title: "Local disclosure",
        markdown,
      });

      expect(createBlockDocumentMarkdownContentParitySignature(markdown)).toBe(
        ':::toggle[Expanded toggle]\n  Expanded child\n:::\n\n:::toggle[Expanded heading]{heading="1"}\n  Heading child\n:::',
      );
      expect(genesis.materialization.markdown).toBe(
        createBlockDocumentMarkdownContentParitySignature(markdown),
      );
    });

    test("requires current Page identities while keeping parity allocation deterministic", () => {
      expect(() => createBlockDocumentMarkdownContentParitySignature("::page{}")).toThrow("id");
      expect(createBlockDocumentMarkdownContentParitySignature('::page{id="exported-card"}')).toBe(
        '::page{id="exported-card"}',
      );
      expect(
        createBlockDocumentMarkdownContentParitySignature('::page-ref{page="target-card"}'),
      ).toBe('::page-ref{page="target-card"}');
    });

    test("headlessly imports and materializes every supported custom shape", () => {
      let nextId = 0;
      const genesis = createPageDocumentGenesis({
        documentId: "document-codec-all-shapes",
        title: "Shared title",
        markdown: FULL_MARKDOWN_FIXTURE,
        allocateBlockId: () => `block-${++nextId}`,
      });

      expect(genesis.materialization.title).toBe("Shared title");
      const replay = createPageDocumentGenesis({
        documentId: "document-codec-all-shapes-replay",
        title: "Shared title",
        markdown: genesis.materialization.markdown,
      });
      expect(replay.materialization.markdown).toBe(genesis.materialization.markdown);
      expect(flattenIds(genesis.materialization.blockTree).length).toBe(nextId);
      expect(new Set(flattenIds(genesis.materialization.blockTree)).size).toBe(nextId);
      expect(genesis.materialization.references.length).toBe(4);
      expect(genesis.materialization.references.map((reference) => reference.kind).join(",")).toBe(
        "session,page,page,database_view",
      );
      expect(genesis.materialization.assetRefs.length).toBe(2);
      expect(genesis.materialization.assetRefs[0]?.managedFileName).toBe("demo.txt");
      expect(genesis.materialization.assetRefs[1]?.managedFileName).toBe("image.png");
      expect(genesis.materialization.plainText.includes("demo.txt")).toBe(true);
      expect(genesis.materialization.plainText.includes("gpt-5.5")).toBe(true);
    });

    test("preserves application identities through encoded reload", () => {
      let nextId = 0;
      const genesis = createPageDocumentGenesis({
        documentId: "document-codec-source",
        title: "Reload",
        markdown: ":::paragraph[Root]\n  - Child\n:::\n\nSibling",
        allocateBlockId: () => `stable-${++nextId}`,
      });
      expect(genesis.materialization.blockTree).toMatchObject([
        { type: "paragraph", children: [{ type: "bulletListItem" }] },
        { type: "paragraph", children: [] },
      ]);
      const originalIds = flattenIds(genesis.materialization.blockTree).join(",");
      const reloaded = new Y.Doc({ guid: "document-codec-source" });
      Y.applyUpdate(reloaded, genesis.update);

      const materialized = materializePageDocument(reloaded);

      expect(flattenIds(materialized.blockTree).join(",")).toBe(originalIds);
      expect(materialized.markdown).toBe(genesis.materialization.markdown);
    });

    test("materializes without mutating the authoritative Y.Doc", () => {
      const genesis = createPageDocumentGenesis({
        documentId: "document-codec-pure-read",
        title: "Pure read",
        markdown: ":::paragraph[Parent]\n  Child\n:::",
      });
      const stateBefore = Array.from(Y.encodeStateAsUpdate(genesis.document)).join(",");

      materializePageDocument(genesis.document);

      expect(Array.from(Y.encodeStateAsUpdate(genesis.document)).join(",")).toBe(stateBefore);
    });

    test("creates one authority-owned editable paragraph for blank Markdown", () => {
      const genesis = createPageDocumentGenesis({
        documentId: "document-codec-empty",
        title: "Empty",
        markdown: "",
        allocateBlockId: () => "block-empty-root",
      });

      expect(genesis.document.getXmlFragment("body").length).toBe(1);
      expect(genesis.materialization.blockTree).toMatchObject([
        {
          id: "block-empty-root",
          type: "paragraph",
          content: [],
          children: [],
        },
      ]);
      expect(genesis.materialization.markdown).toBe("");
      expect(genesis.materialization.plainText).toBe("");
    });

    test("keeps a pending image Block without projecting a nonexistent asset", () => {
      const pending = createDetachedPageDocumentFromBlockTree({
        documentId: "document-codec-pending-image",
        title: "Pending image",
        blockTree: [
          {
            id: "pending-image",
            type: "image",
            props: {
              backgroundColor: "default",
              caption: "",
              name: "pasted.png",
              showPreview: true,
              textAlignment: "left",
              url: "",
            },
            children: [],
          },
        ],
      });

      expect(pending.materialization.blockTree[0]).toMatchObject({
        id: "pending-image",
        type: "image",
        props: { name: "pasted.png", url: "" },
      });
      expect(pending.materialization.assetRefs).toEqual([]);
      pending.document.destroy();
    });
    test("keeps an empty paragraph's authored color in the exact text", () => {
      const page = createPageDocumentGenesis({
        documentId: "colored-empty",
        markdown: '{background="gray"}',
      });
      try {
        expect(page.materialization.markdown).toBe('{background="gray"}');
        expect(page.materialization.plainText).toBe("");
      } finally {
        page.document.destroy();
      }
    });
  });
});

describe("portable rich text", () => {
  const richTitle: PortableRichText = [
    { type: "text", text: "Build ", styles: { bold: true } },
    {
      type: "link",
      text: "Nodex",
      href: "https://nodex.local/spec",
      styles: { italic: true, color: "blue" },
    },
    { type: "linebreak" },
    { type: "threadMention", uuid: "thread-123" },
    { type: "text", text: " by ", styles: {} },
    { type: "pageMention", targetPageId: "page-123" },
    { type: "text", text: " on ", styles: {} },
    { type: "dateMention", start: "2026-07-14", format: "ll" },
  ];

  describe("PortableRichText", () => {
    test("round-trips canonical rich title through Y.Text Delta", () => {
      const document = new Y.Doc();
      const title = document.getText("title");

      replaceYTextWithPortableRichText(title, richTitle, "test");

      expect(readPortableRichTextFromYText(title)).toEqual(richTitle);
      expect(portableRichTextPlainText(richTitle)).toBe(
        "Build Nodex\n@thread:thread-123 by @page:page-123 on @date:2026-07-14",
      );
    });

    test("normalizes newlines and adjacent equivalent spans", () => {
      expect(
        canonicalizePortableRichText([
          { type: "text", text: "Alpha", styles: { bold: true } },
          { type: "text", text: "\nBeta", styles: { bold: true } },
          { type: "text", text: " gamma", styles: { bold: true } },
        ]),
      ).toEqual([
        { type: "text", text: "Alpha", styles: { bold: true } },
        { type: "linebreak" },
        { type: "text", text: "Beta gamma", styles: { bold: true } },
      ]);
    });

    test("formatting-only changes have distinct semantic sources", () => {
      const plain = plainTextToPortableRichText("Same");
      const bold = canonicalizePortableRichText([
        { type: "text", text: "Same", styles: { bold: true } },
      ]);

      expect(portableRichTextPlainText(plain)).toBe(portableRichTextPlainText(bold));
      expect(portableRichTextSemanticSource(plain)).not.toBe(portableRichTextSemanticSource(bold));
    });

    test("converges after concurrent rich edits and duplicate update exchange", () => {
      const origin = new Y.Doc();
      replaceYTextWithPortableRichText(origin.getText("title"), richTitle);
      const base = Y.encodeStateAsUpdate(origin);
      const first = new Y.Doc();
      const second = new Y.Doc();
      Y.applyUpdate(first, base);
      Y.applyUpdate(second, base);

      first.getText("title").insert(0, "A ", { underline: true });
      second.getText("title").format(0, 5, { code: true });
      const firstUpdate = Y.encodeStateAsUpdate(first, Y.encodeStateVector(origin));
      const secondUpdate = Y.encodeStateAsUpdate(second, Y.encodeStateVector(origin));
      Y.applyUpdate(first, secondUpdate);
      Y.applyUpdate(first, secondUpdate);
      Y.applyUpdate(second, firstUpdate);

      expect(readPortableRichTextFromYText(first.getText("title"))).toEqual(
        readPortableRichTextFromYText(second.getText("title")),
      );
    });

    test("rejects unknown attributes, untyped atoms, and unsupported inline objects", () => {
      expect(() =>
        portableRichTextFromYTextDelta([{ insert: "unsafe", attributes: { mystery: true } }]),
      ).toThrow(/mystery/);
      expect(() => portableRichTextFromYTextDelta([{ insert: "\uFFFC" }])).toThrow(/untyped atom/);
      expect(() =>
        canonicalizePortableRichText([
          {
            type: "attachment",
            kind: "file",
            mode: "materialized",
            source: "nodex://assets/demo.txt",
            name: "demo.txt",
          },
        ]),
      ).toThrow(/not title-safe/);
    });

    test("enforces title length, segment, style, and date boundaries", () => {
      expect(plainTextToPortableRichText("x".repeat(2_000))).toHaveLength(1);
      expect(() => plainTextToPortableRichText("x".repeat(2_001))).toThrow(/exceeds 2000/);
      expect(() =>
        canonicalizePortableRichText(
          Array.from({ length: MAX_PORTABLE_RICH_TEXT_SEGMENTS + 1 }, () => ({
            type: "linebreak",
          })),
        ),
      ).toThrow(/too many segments/);
      expect(() =>
        canonicalizePortableRichText([{ type: "text", text: "bad", styles: { blinking: true } }]),
      ).toThrow(/blinking/);
      expect(() =>
        canonicalizePortableRichText([{ type: "dateMention", start: "not-a-date" }]),
      ).toThrow(/valid date mention/);
    });
  });
});

describe("reference codec", () => {
  const appendParagraphChild = (document: Y.Doc): void => {
    const root = document.getXmlFragment("body").get(0);
    if (!(root instanceof Y.XmlElement)) throw new Error("Missing body root");
    const reference = root.get(0);
    if (!(reference instanceof Y.XmlElement)) throw new Error("Missing reference");
    const childGroup = new Y.XmlElement("blockGroup");
    const childContainer = new Y.XmlElement("blockContainer");
    childContainer.setAttribute("id", "nested-under-reference");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.setAttribute("backgroundColor", "default");
    paragraph.setAttribute("textAlignment", "left");
    paragraph.setAttribute("textColor", "default");
    childContainer.insert(0, [paragraph]);
    childGroup.insert(0, [childContainer]);
    reference.insert(reference.length, [childGroup]);
  };

  describe("Block-first reference codec", () => {
    test("requires owning Page identity", () => {
      expect(() => readMarkdown("::page{}", "exact")).toThrow("id");
    });

    test("round-trips canonical references through the BlockNote adapter", () => {
      const source =
        '::page-ref{page="card-1"}\n\n::database-view-ref{view="view-1" hint="Roadmap"}\n\n::template-ref{source="template-1" hint="Incident & review"}';
      const blockNoteBlocks = readMarkdown(source, "exact");

      expect(blockNoteBlocks.every((block) => (block.children?.length ?? 0) === 0)).toBe(true);
      expect(writeMarkdown(blockNoteBlocks)).toBe(source);
    });

    test("hoists attempted children out of reference and resource Blocks", () => {
      const blocks = readMarkdown(
        '::page-ref{page="card-1"}\n\nPage child\n\n::database-view-ref{view="view-1"}\n\nView child\n\n::page{id="page-shell"}\n\nPage shell child',
      );

      expect(blocks.map((block) => block.type)).toEqual([
        "pageRef",
        "paragraph",
        "databaseViewRef",
        "paragraph",
        "page",
        "paragraph",
      ]);
    });

    test("rejects persisted children beneath canonical references", () => {
      const genesis = createPageDocumentGenesis({
        documentId: "reference-children",
        title: "References",
        markdown: '::page-ref{page="card-1"}',
      });
      appendParagraphChild(genesis.document);

      expect(() => materializePageDocument(genesis.document)).toThrow(BlockDocumentCodecError);
    });
  });
});
