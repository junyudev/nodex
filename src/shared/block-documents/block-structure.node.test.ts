import { describe, expect, test } from "vite-plus/test";
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
import * as Y from "yjs";
import {
  createPageDocumentGenesis,
  materializePageDocument,
  type BlockTreeNode,
} from "./block-document-codec";
import {
  BlockSubtreeOperationError,
  captureBlockSubtreeForest,
  indexBlockDocumentTree,
  locateBlockContainer,
  relocateBlockSubtrees,
  type BlockSubtreeOperationErrorCode,
} from "./block-subtree-relocation";
import { BLOCK_TO_PAGE_TYPE_CAPABILITIES } from "./block-semantic-content";
import { HEADLESS_BLOCK_DOCUMENT_BLOCK_TYPES } from "./headless-blocknote-schema";
import { planBlockToPageTransformation } from "./block-to-page-transformation";
import { deriveBlockDocumentRecords } from "./derived-records";

describe("block children policy", () => {
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
        "prompt",
        "pending",
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
      expect(acceptsBlockChildren(block("toggle", "heading", [], { isToggleable: true }))).toBe(
        true,
      );
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
        block("prompt", "prompt", [block("prompt-child", "paragraph")]),
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
});

describe("block subtree relocation", () => {
  const createDocument = (documentId: string, markdown: string, blockIds: readonly string[]) => {
    let index = 0;
    const genesis = createPageDocumentGenesis({
      documentId,
      title: documentId,
      markdown,
      allocateBlockId: () => {
        const blockId = blockIds[index];
        index += 1;
        if (blockId) return blockId;
        throw new Error(`Missing fixture Block identity at index ${index - 1}`);
      },
    });
    expect(index).toBe(blockIds.length);
    return genesis.document;
  };

  const readOperationErrorCode = (
    operation: () => unknown,
  ): BlockSubtreeOperationErrorCode | "" => {
    try {
      operation();
    } catch (error) {
      if (error instanceof BlockSubtreeOperationError) return error.code;
    }
    return "";
  };

  const encodedState = (document: Y.Doc): string =>
    Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");

  describe("Block subtree tree index", () => {
    test("locates canonical containers with path, parent, direct children, and descendants", () => {
      const document = createDocument(
        "tree-index",
        ":::paragraph[Parent]\n  :::paragraph[Child]\n    Grandchild\n  :::\n\n  Sibling\n:::\n\nTail",
        ["parent", "child", "grandchild", "sibling", "tail"],
      );

      const body = document.getXmlFragment("body");
      const index = indexBlockDocumentTree(body);
      const parent = locateBlockContainer(body, "parent");
      const child = index.blocks.get("child");

      expect(index.blockIdsInDocumentOrder.join(",")).toBe("parent,child,grandchild,sibling,tail");
      expect(index.rootBlockIds.join(",")).toBe("parent,tail");
      expect(parent.path.join(",")).toBe("0,0");
      expect(parent.directChildBlockIds.join(",")).toBe("child,sibling");
      expect(parent.descendantBlockIds.join(",")).toBe("child,grandchild,sibling");
      expect(child?.parentBlockId).toBe("parent");
      expect(child?.path.join(",")).toBe("0,0,1,0");
      document.destroy();
    });

    test("captures non-overlapping roots in source order, independent of request order", () => {
      const document = createDocument(
        "tree-capture",
        ":::paragraph[A]\n  A child\n:::\n\nB\n\n:::paragraph[C]\n  C child\n:::",
        ["a", "a-child", "b", "c", "c-child"],
      );

      const forest = captureBlockSubtreeForest(document.getXmlFragment("body"), ["c", "a"]);

      expect(forest.rootBlockIds.join(",")).toBe("a,c");
      expect(forest.blockIds.join(",")).toBe("a,a-child,c,c-child");
      expect(forest.roots[0]?.sourceParentBlockId).toBe(null);
      expect(forest.roots[0]?.sourcePath.join(",")).toBe("0,0");
      expect(forest.roots[0]?.xml.kind).toBe("element");
      document.destroy();
    });
  });

  describe("Block subtree relocation", () => {
    test("moves a stable ordered forest across Documents before a nested anchor", () => {
      const source = createDocument(
        "relocation-source",
        ":::paragraph[A **bold**]\n  A child\n:::\n\nB\n\n:::paragraph[C]\n  C child\n:::",
        ["a", "a-child", "b", "c", "c-child"],
      );
      const target = createDocument("relocation-target", ":::paragraph[Parent]\n  X\n\n  Y\n:::", [
        "parent",
        "x",
        "y",
      ]);
      const sourceInitialUpdate = Y.encodeStateAsUpdate(source);
      const targetInitialUpdate = Y.encodeStateAsUpdate(target);
      const sourceVector = Y.encodeStateVector(source);
      const targetVector = Y.encodeStateVector(target);

      const result = relocateBlockSubtrees({
        sourceDocument: source,
        targetDocument: target,
        rootBlockIds: ["c", "a"],
        target: { parentBlockId: "parent", beforeBlockId: "y" },
      });

      expect(result.sameDocument).toBe(false);
      expect(result.forest.rootBlockIds.join(",")).toBe("a,c");
      expect(result.sourceBlockIdsAfter.join(",")).toBe("b");
      expect(result.targetBlockIdsAfter.join(",")).toBe("parent,x,a,a-child,c,c-child,y");
      expect(
        indexBlockDocumentTree(target.getXmlFragment("body"))
          .blocks.get("parent")
          ?.directChildBlockIds.join(","),
      ).toBe("x,a,c,y");
      expect(materializePageDocument(source).markdown).toBe("B");
      expect(materializePageDocument(target).markdown).toBe(
        ":::paragraph[Parent]\n  X\n\n  :::paragraph[A **bold**]\n    A child\n  :::\n\n  :::paragraph[C]\n    C child\n  :::\n\n  Y\n:::",
      );

      const sourceReplica = new Y.Doc({ guid: source.guid });
      const targetReplica = new Y.Doc({ guid: target.guid });
      Y.applyUpdate(sourceReplica, sourceInitialUpdate);
      Y.applyUpdate(targetReplica, targetInitialUpdate);
      Y.applyUpdate(sourceReplica, Y.encodeStateAsUpdate(source, sourceVector));
      Y.applyUpdate(targetReplica, Y.encodeStateAsUpdate(target, targetVector));
      expect(materializePageDocument(sourceReplica).markdown).toBe("B");
      expect(materializePageDocument(targetReplica).markdown).toBe(
        materializePageDocument(target).markdown,
      );

      sourceReplica.destroy();
      targetReplica.destroy();
      source.destroy();
      target.destroy();
    });

    test("moves within one Document and creates a missing child group", () => {
      const document = createDocument(
        "relocation-same-document",
        "Destination\n\nFirst\n\nSecond",
        ["destination", "first", "second"],
      );

      const result = relocateBlockSubtrees({
        sourceDocument: document,
        targetDocument: document,
        rootBlockIds: ["second", "first"],
        target: { parentBlockId: "destination" },
      });

      expect(result.sameDocument).toBe(true);
      expect(result.sourceBlockIdsBefore.join(",")).toBe("destination,first,second");
      expect(result.sourceBlockIdsAfter.join(",")).toBe("destination,first,second");
      expect(materializePageDocument(document).markdown).toBe(
        ":::paragraph[Destination]\n  First\n\n  Second\n:::",
      );
      document.destroy();
    });

    test("rejects duplicate and overlapping roots before mutation", () => {
      const duplicateDocument = createDocument(
        "duplicate-roots",
        ":::paragraph[Parent]\n  Child\n:::",
        ["parent", "child"],
      );
      const duplicateBefore = encodedState(duplicateDocument);
      expect(
        readOperationErrorCode(() =>
          captureBlockSubtreeForest(duplicateDocument.getXmlFragment("body"), ["parent", "parent"]),
        ),
      ).toBe("duplicate_root");
      expect(encodedState(duplicateDocument)).toBe(duplicateBefore);
      expect(
        readOperationErrorCode(() =>
          captureBlockSubtreeForest(duplicateDocument.getXmlFragment("body"), ["child", "parent"]),
        ),
      ).toBe("overlapping_roots");
      expect(encodedState(duplicateDocument)).toBe(duplicateBefore);
      duplicateDocument.destroy();
    });

    test("rejects ancestor cycles and anchors inside the moved subtree", () => {
      const cycleDocument = createDocument(
        "cycle-relocation",
        ":::paragraph[Parent]\n  Child\n:::\n\nSibling",
        ["parent", "child", "sibling"],
      );
      const before = encodedState(cycleDocument);

      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: cycleDocument,
            targetDocument: cycleDocument,
            rootBlockIds: ["parent"],
            target: { parentBlockId: "child" },
          }),
        ),
      ).toBe("ancestor_cycle");
      expect(encodedState(cycleDocument)).toBe(before);
      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: cycleDocument,
            targetDocument: cycleDocument,
            rootBlockIds: ["parent"],
            target: { beforeBlockId: "parent" },
          }),
        ),
      ).toBe("target_anchor_in_moved_subtree");
      expect(encodedState(cycleDocument)).toBe(before);
      cycleDocument.destroy();
    });

    test("rejects missing or non-sibling target anchors before mutation", () => {
      const source = createDocument("anchor-source", "Move", ["move"]);
      const target = createDocument(
        "anchor-target",
        ":::paragraph[Parent]\n  Nested\n:::\n\nRoot anchor",
        ["parent", "nested", "root-anchor"],
      );
      const sourceBefore = encodedState(source);
      const targetBefore = encodedState(target);

      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: source,
            targetDocument: target,
            rootBlockIds: ["missing-source"],
            target: {},
          }),
        ),
      ).toBe("source_block_not_found");
      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: source,
            targetDocument: target,
            rootBlockIds: ["move"],
            target: { parentBlockId: "missing-parent" },
          }),
        ),
      ).toBe("target_parent_not_found");
      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: source,
            targetDocument: target,
            rootBlockIds: ["move"],
            target: { beforeBlockId: "missing" },
          }),
        ),
      ).toBe("target_anchor_not_found");
      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: source,
            targetDocument: target,
            rootBlockIds: ["move"],
            target: { beforeBlockId: "nested" },
          }),
        ),
      ).toBe("target_anchor_wrong_parent");
      expect(encodedState(source)).toBe(sourceBefore);
      expect(encodedState(target)).toBe(targetBefore);
      source.destroy();
      target.destroy();
    });

    test("rejects global identity collisions across Documents", () => {
      const source = createDocument("identity-source", "Move\n\nRemain", ["shared", "source-only"]);
      const target = createDocument("identity-target", "Existing", ["shared"]);
      const sourceBefore = encodedState(source);
      const targetBefore = encodedState(target);

      expect(
        readOperationErrorCode(() =>
          relocateBlockSubtrees({
            sourceDocument: source,
            targetDocument: target,
            rootBlockIds: ["source-only"],
            target: {},
          }),
        ),
      ).toBe("target_identity_conflict");
      expect(encodedState(source)).toBe(sourceBefore);
      expect(encodedState(target)).toBe(targetBefore);
      source.destroy();
      target.destroy();
    });

    test("preserves canonical Card and Database View references as childless Blocks", () => {
      const source = createDocument("childless-source", "Move", ["move"]);
      const target = createDocument(
        "childless-target",
        '::page-ref{page="target-card"}\n\n::database-view-ref{view="target-view"}',
        ["page-ref", "view-ref"],
      );
      const sourceBefore = encodedState(source);
      const targetBefore = encodedState(target);

      for (const parentBlockId of ["page-ref", "view-ref"]) {
        expect(
          readOperationErrorCode(() =>
            relocateBlockSubtrees({
              sourceDocument: source,
              targetDocument: target,
              rootBlockIds: ["move"],
              target: { parentBlockId },
            }),
          ),
        ).toBe("target_parent_rejects_children");
      }
      expect(encodedState(source)).toBe(sourceBefore);
      expect(encodedState(target)).toBe(targetBefore);
      expect(materializePageDocument(target).blockTree[0]?.children.length).toBe(0);
      expect(materializePageDocument(target).blockTree[1]?.children.length).toBe(0);
      source.destroy();
      target.destroy();
    });
  });
});

describe("block to page transformation", () => {
  const paragraph = (
    id: string,
    content: unknown,
    children: readonly BlockTreeNode[] = [],
  ): BlockTreeNode => ({
    id,
    type: "paragraph",
    props: {
      backgroundColor: "default",
      textColor: "default",
      textAlignment: "left",
    },
    content: content as BlockTreeNode["content"],
    children,
  });

  describe("BlockToPageTransformation", () => {
    test("keeps the registered Block schema capability matrix exhaustive", () => {
      expect(Object.keys(BLOCK_TO_PAGE_TYPE_CAPABILITIES).sort()).toEqual(
        [...HEADLESS_BLOCK_DOCUMENT_BLOCK_TYPES].sort(),
      );
    });

    test("consumes root primary rich content and lifts only existing children", () => {
      const child = paragraph("child-a", [{ type: "text", text: "Child", styles: {} }]);
      const root = paragraph(
        "root-a",
        [
          { type: "text", text: "Rich ", styles: { bold: true } },
          {
            type: "link",
            href: "https://nodex.local",
            content: [{ type: "text", text: "title", styles: { italic: true } }],
          },
          { type: "threadMention", props: { uuid: "thread-a" } },
        ],
        [child],
      );

      const plan = planBlockToPageTransformation({
        root,
        resultRootId: root.id,
        wrapperPageId: "wrapper-unused",
        allocateEmptyBodyBlockId: () => "empty-unused",
      });

      expect(plan).toMatchObject({
        kind: "promote",
        pageId: "root-a",
        richTitle: [
          { type: "text", text: "Rich ", styles: { bold: true } },
          {
            type: "link",
            text: "title",
            href: "https://nodex.local",
            styles: { italic: true },
          },
          { type: "threadMention", uuid: "thread-a" },
        ],
        bodyRoots: [child],
        placeholderBlockId: null,
      });
      if (plan.kind === "promote") {
        expect(plan.bodyRoots.some((block) => block.id === root.id)).toBe(false);
      }
    });

    test("gives a leaf Page one new canonical empty body Block", () => {
      const plan = planBlockToPageTransformation({
        root: paragraph("leaf", [{ type: "text", text: "Leaf", styles: {} }]),
        resultRootId: "leaf",
        wrapperPageId: "wrapper-unused",
        allocateEmptyBodyBlockId: () => "empty-body",
      });
      expect(plan).toMatchObject({
        kind: "promote",
        pageId: "leaf",
        bodyRoots: [{ id: "empty-body", type: "paragraph", content: [] }],
        placeholderBlockId: "empty-body",
      });
    });

    test("wraps unsupported inline atoms and stateful Block types without loss", () => {
      const attachmentRoot = paragraph("attachment-root", [
        {
          type: "attachment",
          props: {
            kind: "file",
            mode: "materialized",
            source: "nodex://assets/demo.txt",
            name: "demo.txt",
          },
        },
      ]);
      expect(
        planBlockToPageTransformation({
          root: attachmentRoot,
          resultRootId: attachmentRoot.id,
          wrapperPageId: "wrapper-attachment",
          allocateEmptyBodyBlockId: () => "unused",
        }),
      ).toMatchObject({
        kind: "wrap",
        pageId: "wrapper-attachment",
        wrappedRoot: attachmentRoot,
        reason: "unsupported_primary_content",
      });

      const checklist: BlockTreeNode = {
        ...paragraph("check", [{ type: "text", text: "Done", styles: {} }]),
        type: "checkListItem",
        props: { checked: true },
      };
      const checklistPlan = planBlockToPageTransformation({
        root: checklist,
        resultRootId: checklist.id,
        wrapperPageId: "wrapper-check",
        allocateEmptyBodyBlockId: () => "unused",
      });
      expect(checklistPlan).toMatchObject({
        kind: "wrap",
        pageId: "wrapper-check",
        wrappedRoot: checklist,
        reason: "type_requires_wrapper",
      });
      if (checklistPlan.kind !== "wrap") return;
      expect(checklistPlan.richTitle).toEqual([{ type: "text", text: "Done", styles: {} }]);
    });
  });
});

describe("Block references and asset occurrences", () => {
  test("materializing a qualified autolink retains its destination Space", () => {
    const page = createPageDocumentGenesis({
      documentId: "qualified-link",
      markdown: "See <nodex://pages/same-id?spaceId=another-space>",
    });
    try {
      expect(page.materialization.references).toEqual([]);
      expect(page.materialization.blockTree[0]?.content).toEqual([
        { type: "text", text: "See ", styles: {} },
        {
          type: "link",
          href: "nodex://pages/same-id?spaceId=another-space",
          content: [
            { type: "text", text: "nodex://pages/same-id?spaceId=another-space", styles: {} },
          ],
        },
      ]);
    } finally {
      page.document.destroy();
    }
  });
  test("keeps qualified Page links out of the local reference graph", () => {
    const records = deriveBlockDocumentRecords([
      {
        id: "paragraph",
        type: "paragraph",
        props: {},
        children: [],
        content: [
          { type: "link", href: "nodex://pages/same-id?spaceId=another-space", content: [] },
          { type: "link", href: "nodex://pages/same-id", content: [] },
        ],
      },
    ]);
    expect(records.references).toEqual([
      {
        kind: "page",
        sourceBlockId: "paragraph",
        targetPageId: "same-id",
        presentation: "link",
        occurrenceCount: 1,
      },
    ]);
  });
  test("aggregates Page mentions separately from links and reference Blocks", () => {
    const page = createPageDocumentGenesis({
      documentId: "references",
      markdown:
        'See <nodex://pages/page-1> and <nodex://pages/page-1> or [the Page](nodex://pages/page-1)\n\n::page-ref{page="page-1"}',
    });
    try {
      expect(
        page.materialization.references.map(
          ({ sourceBlockId: _sourceBlockId, ...reference }) => reference,
        ),
      ).toEqual([
        { kind: "page", targetPageId: "page-1", presentation: "mention", occurrenceCount: 2 },
        { kind: "page", targetPageId: "page-1", presentation: "link", occurrenceCount: 1 },
        {
          kind: "page",
          targetPageId: "page-1",
          presentation: "reference_block",
          occurrenceCount: 1,
        },
      ]);
    } finally {
      page.document.destroy();
    }
  });
  test("uses Session identity and finds linked inline images in table cells", () => {
    const records = deriveBlockDocumentRecords([
      {
        id: "table",
        type: "table",
        props: {},
        children: [],
        content: {
          type: "tableContent",
          rows: [
            {
              cells: [
                {
                  content: [
                    { type: "threadMention", props: { uuid: "session-1" } },
                    {
                      type: "link",
                      href: "https://example.com",
                      content: [
                        {
                          type: "inlineImage",
                          props: { url: "nodex://files/file-1", alt: "Diagram" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(records.references).toEqual([
      { kind: "session", sourceBlockId: "table", targetSessionId: "session-1" },
    ]);
    expect(records.assetRefs).toEqual([
      {
        sourceBlockId: "table",
        kind: "image",
        source: "nodex://files/file-1",
        managedFileName: null,
      },
    ]);
  });
});
