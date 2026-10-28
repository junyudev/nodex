import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createPageDocumentGenesis,
  materializePageDocument,
  type BlockTreeNode,
} from "./block-document-codec";
import {
  DocumentOperationEngineError,
  prepareDocumentOperationUpdate,
} from "./document-operation-engine";
const createGenesis = (
  documentId: string,
  title: string,
  markdown: string,
  ids: readonly string[],
) => {
  let index = 0;
  return createPageDocumentGenesis({
    documentId,
    title,
    markdown,
    allocateBlockId: () => {
      const id = ids[index];
      index += 1;
      if (id) return id;
      throw new Error(`Missing test Block ID at ${index}`);
    },
  });
};

const encodedState = (document: Y.Doc): string =>
  Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");

const captureEngineError = (operation: () => unknown): string => {
  try {
    operation();
    return "";
  } catch (error) {
    return error instanceof DocumentOperationEngineError ? error.code : "other";
  }
};

describe("Document operation engine", () => {
  test("persists formatting-only rich title changes as replayable authority", () => {
    const source = createGenesis("operation-rich-title", "Same words", "Body", ["body"]);
    const prepared = prepareDocumentOperationUpdate({
      document: source.document,
      operations: [
        {
          kind: "set_rich_title",
          richTitle: [
            { type: "text", text: "Same ", styles: {} },
            { type: "text", text: "words", styles: { bold: true } },
          ],
        },
      ],
    });

    expect(prepared.materialization.title).toBe("Same words");
    expect(prepared.materialization.richTitle).toEqual([
      { type: "text", text: "Same ", styles: {} },
      { type: "text", text: "words", styles: { bold: true } },
    ]);
    expect(prepared.titleWriteFenceRequired).toBe(true);

    const replica = new Y.Doc({ guid: source.document.guid });
    Y.applyUpdate(replica, source.update);
    Y.applyUpdate(replica, prepared.update);
    expect(materializePageDocument(replica).richTitle).toEqual(prepared.materialization.richTitle);
    replica.destroy();
    source.document.destroy();
  });

  test("applies one stable-ID batch on a detached clone and emits one replayable update", () => {
    const source = createGenesis("operation-source", "Before", "Alpha\n\nBeta\n\nGamma", [
      "alpha",
      "beta",
      "gamma",
    ]);
    const inserted = createGenesis(
      "operation-insert-template",
      "",
      ":::paragraph[Inserted]\n  Child\n:::",
      ["inserted", "inserted-child"],
    );
    const updated = createGenesis("operation-update-template", "", "Alpha updated", [
      "updated-template",
    ]);
    const sourceBefore = encodedState(source.document);
    const insertedRoot = inserted.materialization.blockTree[0] as BlockTreeNode;
    const updatedRoot = updated.materialization.blockTree[0] as BlockTreeNode;

    const prepared = prepareDocumentOperationUpdate({
      document: source.document,
      operations: [
        { kind: "set_title", title: "After" },
        {
          kind: "insert_block",
          block: insertedRoot,
          beforeBlockId: "beta",
        },
        {
          kind: "update_block",
          blockId: "alpha",
          patch: {
            type: updatedRoot.type,
            props: updatedRoot.props,
            ...(updatedRoot.content === undefined ? {} : { content: updatedRoot.content }),
          },
        },
        { kind: "move_block", blockId: "gamma", parentBlockId: "alpha" },
        { kind: "delete_block", blockId: "beta" },
      ],
    });

    expect(encodedState(source.document)).toBe(sourceBefore);
    expect(prepared.update.byteLength > 0).toBe(true);
    expect(prepared.materialization.title).toBe("After");
    expect(prepared.materialization.markdown).toBe(
      ":::paragraph[Alpha updated]\n  Gamma\n:::\n\n:::paragraph[Inserted]\n  Child\n:::",
    );
    expect(prepared.writeFenceBlockIds.join(",")).toBe("alpha,beta,gamma");
    expect(prepared.titleWriteFenceRequired).toBe(true);
    expect(
      prepared.materialization.blockTree
        .flatMap((block) => [block.id, ...block.children.map((child) => child.id)])
        .join(","),
    ).toBe("alpha,gamma,inserted,inserted-child");

    const replica = new Y.Doc({ guid: source.document.guid });
    Y.applyUpdate(replica, source.update);
    Y.applyUpdate(replica, prepared.update);
    expect(materializePageDocument(replica).markdown).toBe(prepared.materialization.markdown);
    const afterFirstApply = encodedState(replica);
    Y.applyUpdate(replica, prepared.update);
    expect(encodedState(replica)).toBe(afterFirstApply);

    replica.destroy();
    source.document.destroy();
    inserted.document.destroy();
    updated.document.destroy();
  });

  test("retains a title fence when a batch rewrites back to its original value", () => {
    const source = createGenesis("operation-net-zero-title", "Original", "Body", ["body"]);
    const inserted = createGenesis("operation-net-zero-insert", "", "Inserted", ["inserted"]);
    try {
      const prepared = prepareDocumentOperationUpdate({
        document: source.document,
        operations: [
          { kind: "set_title", title: "Transient" },
          { kind: "set_title", title: "Original" },
          {
            kind: "insert_block",
            block: inserted.materialization.blockTree[0] as BlockTreeNode,
          },
        ],
      });
      expect(prepared.materialization.title).toBe("Original");
      expect(prepared.titleWriteFenceRequired).toBe(true);
      expect(prepared.writeFenceBlockIds.length).toBe(0);
    } finally {
      source.document.destroy();
      inserted.document.destroy();
    }
  });

  test("rejects deleting the final editable Block", () => {
    const source = createGenesis("operation-final-root", "Title only", "", ["empty-root"]);

    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [{ kind: "delete_block", blockId: "empty-root" }],
        }),
      ),
    ).toBe("invalid_operation");
    expect(materializePageDocument(source.document).blockTree).toMatchObject([
      { id: "empty-root", type: "paragraph" },
    ]);

    source.document.destroy();
  });

  test("marks every descendant whose Yjs structs are invalidated by a move", () => {
    const source = createGenesis(
      "operation-fence-descendants",
      "Fence",
      ":::paragraph[Parent]\n  Child\n:::\n\nSibling",
      ["parent", "child", "sibling"],
    );
    const prepared = prepareDocumentOperationUpdate({
      document: source.document,
      operations: [{ kind: "move_block", blockId: "parent" }],
    });
    expect(prepared.writeFenceBlockIds.join(",")).toBe("child,parent");
    source.document.destroy();
  });

  test("rejects duplicate IDs, ancestor cycles, and missing anchors without mutating the source", () => {
    const source = createGenesis(
      "operation-failures",
      "Guarded",
      ":::paragraph[Parent]\n  Child\n:::\n\nSibling",
      ["parent", "child", "sibling"],
    );
    const duplicate = createGenesis("operation-duplicate-template", "", "Duplicate", ["sibling"]);
    const before = encodedState(source.document);

    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [
            {
              kind: "insert_block",
              block: duplicate.materialization.blockTree[0] as BlockTreeNode,
            },
          ],
        }),
      ),
    ).toBe("duplicate_block_id");
    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [{ kind: "move_block", blockId: "parent", parentBlockId: "child" }],
        }),
      ),
    ).toBe("ancestor_cycle");
    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [
            {
              kind: "move_block",
              blockId: "sibling",
              beforeBlockId: "missing",
            },
          ],
        }),
      ),
    ).toBe("invalid_anchor");
    expect(encodedState(source.document)).toBe(before);

    duplicate.document.destroy();
    source.document.destroy();
  });

  test("rejects a fully normalized no-op instead of manufacturing Yjs structs", () => {
    const source = createGenesis("operation-noop", "Same title", "Same body", ["same"]);
    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [
            { kind: "set_title", title: "Same title" },
            {
              kind: "update_block",
              blockId: "same",
              patch: {
                props: source.materialization.blockTree[0]?.props ?? {},
              },
            },
            { kind: "move_block", blockId: "same" },
          ],
        }),
      ),
    ).toBe("no_change");
    const insertTemplate = createGenesis("operation-noop-insert", "", "Transient", ["transient"]);
    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [
            {
              kind: "insert_block",
              block: insertTemplate.materialization.blockTree[0] as BlockTreeNode,
            },
            { kind: "delete_block", blockId: "transient" },
          ],
        }),
      ),
    ).toBe("no_change");
    insertTemplate.document.destroy();
    source.document.destroy();
  });

  test("rejects Block props that the canonical codec would silently discard", () => {
    const source = createGenesis("operation-invalid-props", "Schema", "Existing", ["existing"]);
    expect(
      captureEngineError(() =>
        prepareDocumentOperationUpdate({
          document: source.document,
          operations: [
            {
              kind: "insert_block",
              block: {
                id: "invalid-props",
                type: "paragraph",
                props: { unsupportedProp: "must-not-disappear" },
                content: [],
                children: [],
              },
            },
          ],
        }),
      ),
    ).toBe("invalid_block");
    source.document.destroy();
  });
});
