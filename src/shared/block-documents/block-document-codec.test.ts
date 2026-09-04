import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createBlockDocumentNfmContentParitySignature,
  createPageDocumentGenesis,
  createDetachedPageDocumentFromBlockTree,
  materializePageDocument,
  materializeBlockFields,
} from "./block-document-codec";

const FULL_NFM_FIXTURE = [
  "# Heading",
  'Paragraph **bold** with <agent-config mode="plan" model="gpt-5.5" reasoning="high" /> and <mention-thread uuid="thread-1" /> and <mention-date start="2026-07-11" format="relative" />.',
  "- List",
  '\tNested <attachment kind="file" mode="materialized" source="nodex://assets/demo.txt" name="demo.txt" mime="text/plain" bytes="12" />',
  "3. Ordered",
  "- [x] Checked",
  "▶ Collapsed toggle",
  "\tToggle child",
  "> Quoted",
  "---",
  '<callout icon="💡">Callout</callout>',
  '<image source="nodex://assets/image.png">Image caption</image>',
  '<thread-section label="Investigate" thread="thread-2" />',
  '<page-ref url="nodex://pages/card-target" />',
  '<page-ref url="nodex://pages/card-canonical" />',
  '<database-view-ref database-view="view-canonical" display-hint="Planning" />',
  "```ts",
  "const value = 1;",
  "```",
  "| Name | Score |",
  "| --- | ---: |",
  "| Nodex | 10 |",
].join("\n");

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
      nfm: FULL_NFM_FIXTURE,
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
    const nfm = [
      "▼ Expanded toggle",
      "\tExpanded child",
      "▼# Expanded heading",
      "\tHeading child",
    ].join("\n");

    const genesis = createPageDocumentGenesis({
      documentId: "document-codec-local-toggle-state",
      title: "Local disclosure",
      nfm,
    });

    expect(createBlockDocumentNfmContentParitySignature(nfm)).toBe(
      ["▶ Expanded toggle", "\tExpanded child", "▶# Expanded heading", "\tHeading child"].join(
        "\n",
      ),
    );
    expect(genesis.materialization.nfm).toBe(createBlockDocumentNfmContentParitySignature(nfm));
  });

  test("requires current Page identities while keeping parity allocation deterministic", () => {
    expect(() => createBlockDocumentNfmContentParitySignature("<page />")).toThrow(
      "Canonical Page NFM requires an exact non-empty uuid",
    );
    expect(createBlockDocumentNfmContentParitySignature('<page uuid="exported-card" />')).toBe(
      '<page uuid="nfm-parity-1" />',
    );
    expect(
      createBlockDocumentNfmContentParitySignature('<page-ref url="nodex://pages/target-card" />'),
    ).toBe('<page-ref url="nodex://pages/target-card" />');
  });

  test("headlessly imports and materializes every supported custom shape", () => {
    let nextId = 0;
    const genesis = createPageDocumentGenesis({
      documentId: "document-codec-all-shapes",
      title: "Shared title",
      nfm: FULL_NFM_FIXTURE,
      allocateBlockId: () => `block-${++nextId}`,
    });

    expect(genesis.materialization.title).toBe("Shared title");
    const replay = createPageDocumentGenesis({
      documentId: "document-codec-all-shapes-replay",
      title: "Shared title",
      nfm: genesis.materialization.nfm,
    });
    expect(replay.materialization.nfm).toBe(genesis.materialization.nfm);
    expect(flattenIds(genesis.materialization.blockTree).length).toBe(nextId);
    expect(new Set(flattenIds(genesis.materialization.blockTree)).size).toBe(nextId);
    expect(genesis.materialization.references.length).toBe(4);
    expect(genesis.materialization.references.map((reference) => reference.kind).join(",")).toBe(
      "thread,page,page,database_view",
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
      nfm: "Root\n\t- Child\nSibling",
      allocateBlockId: () => `stable-${++nextId}`,
    });
    const originalIds = flattenIds(genesis.materialization.blockTree).join(",");
    const reloaded = new Y.Doc({ guid: "document-codec-source" });
    Y.applyUpdate(reloaded, genesis.update);

    const materialized = materializePageDocument(reloaded);

    expect(flattenIds(materialized.blockTree).join(",")).toBe(originalIds);
    expect(materialized.nfm).toBe(genesis.materialization.nfm);
  });

  test("materializes without mutating the authoritative Y.Doc", () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document-codec-pure-read",
      title: "Pure read",
      nfm: "Parent\n\tChild",
    });
    const stateBefore = Array.from(Y.encodeStateAsUpdate(genesis.document)).join(",");

    materializePageDocument(genesis.document);

    expect(Array.from(Y.encodeStateAsUpdate(genesis.document)).join(",")).toBe(stateBefore);
  });

  test("creates one authority-owned editable paragraph for blank NFM", () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document-codec-empty",
      title: "Empty",
      nfm: "",
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
    expect(genesis.materialization.nfm).toBe("");
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
});
