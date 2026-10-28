import { describe, expect, test } from "vite-plus/test";
import {
  canonicalizeDocumentOperationBatch,
  canonicalizeDocumentOperationIntent,
  canonicalizeReplaceDocumentFromMarkdown,
  canonicalizeReplaceDocumentFromMarkdownIntent,
  DocumentOperationContractError,
  parseDocumentOperationBatch,
  parseDocumentOperationCommandResult,
  parseReplaceDocumentFromMarkdown,
} from "./document-operations";
import { committedLocalCommit } from "../testing/local-commit";

const BASE = {
  mutationId: "operation-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  clientSessionId: "session-1",
  actor: { kind: "agent", id: "agent-1" },
  documentId: "document-1",
  generation: 1,
  expectedHeadSeq: 4,
} as const;

const rejectsContract = (value: unknown, kind: "batch" | "markdown"): boolean => {
  try {
    if (kind === "batch") {
      parseDocumentOperationBatch(value);
    } else {
      parseReplaceDocumentFromMarkdown(value);
    }
    return false;
  } catch (error) {
    return error instanceof DocumentOperationContractError;
  }
};

describe("Document operation contract", () => {
  test("parses every stable-ID operation without transport-specific fields", () => {
    const parsed = parseDocumentOperationBatch({
      ...BASE,
      operations: [
        { kind: "set_title", title: "Updated" },
        {
          kind: "set_rich_title",
          richTitle: [
            { type: "text", text: "Rich", styles: { bold: true } },
            { type: "linebreak" },
            { type: "link", text: "title", href: "https://nodex.local", styles: {} },
          ],
        },
        {
          kind: "insert_block",
          parentBlockId: "parent",
          beforeBlockId: "anchor",
          block: {
            id: "inserted",
            type: "paragraph",
            props: { textAlignment: "left" },
            content: [{ type: "text", text: "Hello", styles: {} }],
            children: [
              {
                id: "inserted-child",
                type: "paragraph",
                props: {},
                content: [],
                children: [],
              },
            ],
          },
        },
        {
          kind: "update_block",
          blockId: "existing",
          patch: { props: { checked: true }, content: [] },
        },
        { kind: "move_block", blockId: "moving", beforeBlockId: "anchor" },
        { kind: "delete_block", blockId: "deleted" },
      ],
    });

    expect(parsed.operations.length).toBe(6);
    expect(parsed.operations[2]?.kind).toBe("insert_block");
    expect(
      parsed.operations[2]?.kind === "insert_block"
        ? parsed.operations[2].block.children[0]?.id
        : "",
    ).toBe("inserted-child");
  });

  test("rejects non-canonical or unsafe rich title payloads at the boundary", () => {
    expect(
      rejectsContract(
        {
          ...BASE,
          operations: [
            {
              kind: "set_rich_title",
              richTitle: [{ type: "attachment", name: "not-title-safe" }],
            },
          ],
        },
        "batch",
      ),
    ).toBe(true);
  });

  test("canonicalizes portable object key order but preserves operation order", () => {
    const first = {
      ...BASE,
      operations: [
        {
          kind: "update_block",
          blockId: "existing",
          patch: { props: { beta: 2, alpha: 1 } },
        },
        { kind: "set_title", title: "After" },
      ],
    };
    const reorderedKeys = {
      expectedHeadSeq: 4,
      generation: 1,
      documentId: "document-1",
      storeEpoch: "epoch-1",
      projectId: "project-1",
      mutationId: "operation-1",
      clientSessionId: "session-1",
      actor: { id: "agent-1", kind: "agent" },
      operations: [
        {
          blockId: "existing",
          patch: { props: { alpha: 1, beta: 2 } },
          kind: "update_block",
        },
        { title: "After", kind: "set_title" },
      ],
    };
    const reorderedOperations = {
      ...BASE,
      operations: [...first.operations].reverse(),
    };

    expect(canonicalizeDocumentOperationBatch(first)).toBe(
      canonicalizeDocumentOperationBatch(reorderedKeys),
    );
    expect(
      canonicalizeDocumentOperationBatch(first) ===
        canonicalizeDocumentOperationBatch(reorderedOperations),
    ).toBe(false);
  });

  test("keeps durable command intent stable across trusted transport identities", () => {
    const operation = {
      ...BASE,
      operations: [{ kind: "set_title" as const, title: "After" }],
    };
    const retriedOperation = {
      ...operation,
      clientSessionId: "replacement-window",
      actor: { kind: "http", id: "same-local-user" },
    };
    expect(canonicalizeDocumentOperationIntent(operation)).toBe(
      canonicalizeDocumentOperationIntent(retriedOperation),
    );
    expect(
      canonicalizeDocumentOperationBatch(operation) ===
        canonicalizeDocumentOperationBatch(retriedOperation),
    ).toBe(false);

    const replacement = { ...BASE, markdown: "Body" };
    expect(canonicalizeReplaceDocumentFromMarkdownIntent(replacement)).toBe(
      canonicalizeReplaceDocumentFromMarkdownIntent({
        ...replacement,
        clientSessionId: "browser-retry",
        actor: { kind: "ipc", id: "same-local-user" },
      }),
    );
  });

  test("rejects unknown fields, duplicate subtree IDs, invalid values, and self targets", () => {
    expect(
      rejectsContract(
        {
          ...BASE,
          unsupported: true,
          operations: [{ kind: "set_title", title: "No" }],
        },
        "batch",
      ),
    ).toBe(true);
    expect(
      rejectsContract(
        {
          ...BASE,
          operations: [
            {
              kind: "insert_block",
              block: {
                id: "same",
                type: "paragraph",
                props: {},
                children: [
                  {
                    id: "same",
                    type: "paragraph",
                    props: {},
                    children: [],
                  },
                ],
              },
            },
          ],
        },
        "batch",
      ),
    ).toBe(true);
    expect(
      rejectsContract(
        {
          ...BASE,
          operations: [
            {
              kind: "update_block",
              blockId: "existing",
              patch: { props: { bad: Number.NaN } },
            },
          ],
        },
        "batch",
      ),
    ).toBe(true);
    expect(
      rejectsContract(
        {
          ...BASE,
          operations: [
            {
              kind: "move_block",
              blockId: "same",
              parentBlockId: "same",
            },
          ],
        },
        "batch",
      ),
    ).toBe(true);
  });

  test("keeps explicit Markdown replacement separate and CAS-bound", () => {
    const replacement = parseReplaceDocumentFromMarkdown({
      ...BASE,
      markdown: "First\n\nSecond",
    });
    expect(replacement.markdown).toBe("First\n\nSecond");
    expect(canonicalizeReplaceDocumentFromMarkdown(replacement)).toBe(
      canonicalizeReplaceDocumentFromMarkdown({
        markdown: "First\n\nSecond",
        ...BASE,
      }),
    );
    expect(rejectsContract({ ...BASE, markdown: "Body", operations: [] }, "markdown")).toBe(true);
  });

  test("strictly parses transport-neutral success and conflict results", () => {
    const success = parseDocumentOperationCommandResult({
      ok: true,
      localCommit: committedLocalCommit("epoch-1", 7),
      value: {
        mutationKind: "document_operation_batch",
        mutationId: "operation-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        documentId: "document-1",
        generation: 1,
        baseHeadSeq: 4,
        headSeq: 5,
        touchedBlockIds: ["block-1"],
        createdBlockIds: [],
        deletedBlockIds: [],
        updatedBlockIds: ["block-1"],
        movedBlockIds: [],
        writeFenceBlockIds: ["block-1"],
        titleChanged: false,
        coordination: "write_fence",
        commitSeq: 7,
        committedAt: "2026-07-11T00:00:00.000Z",
        duplicate: false,
      },
    });
    expect(success.ok).toBe(true);
    expect(success.ok ? success.value.headSeq : -1).toBe(5);

    const conflict = parseDocumentOperationCommandResult({
      ok: false,
      error: {
        code: "document_head_conflict",
        message: "Document head changed",
        retryable: false,
        mutationId: "operation-1",
        expectedHeadSeq: 4,
        actualHeadSeq: 5,
      },
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok ? -1 : conflict.error.actualHeadSeq).toBe(5);

    let rejected = false;
    try {
      parseDocumentOperationCommandResult({
        ok: false,
        error: {
          code: "document_head_conflict",
          message: "Missing evidence",
          retryable: false,
          expectedHeadSeq: 4,
        },
      });
    } catch (error) {
      rejected = error instanceof DocumentOperationContractError;
    }
    expect(rejected).toBe(true);
  });
});
