import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { createPageDocumentGenesis, materializePageDocument } from "./block-document-codec";
import {
  BlockSubtreeOperationError,
  captureBlockSubtreeForest,
  indexBlockDocumentTree,
  locateBlockContainer,
  relocateBlockSubtrees,
  type BlockSubtreeOperationErrorCode,
} from "./block-subtree-relocation";

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

const readOperationErrorCode = (operation: () => unknown): BlockSubtreeOperationErrorCode | "" => {
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
    const document = createDocument("relocation-same-document", "Destination\n\nFirst\n\nSecond", [
      "destination",
      "first",
      "second",
    ]);

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
