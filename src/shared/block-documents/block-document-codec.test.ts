import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createBlockDocumentMarkdownContentParitySignature,
  createPageDocumentGenesis,
  createDetachedPageDocumentFromBlockTree,
  materializePageDocument,
  materializeBlockFields,
} from "./block-document-codec";

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
