import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedDocumentVersionCheckpoint,
  DocumentHistoryContractError,
  parseCreateDocumentVersionCheckpoint,
  parseDocumentVersionSummary,
  parseListDocumentVersions,
} from "./document-history-transport";
import {
  canonicalizeDocumentVersionRestoreIntent,
  parseDocumentVersionRestore,
} from "./document-operations";

const restoreRequest = {
  mutationId: "restore:version-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  documentId: "document-1",
  versionId: `document-version:${"a".repeat(64)}`,
  generation: 3,
  expectedHeadSeq: 17,
  clientSessionId: "untrusted-window",
  actor: { kind: "untrusted" },
} as const;

describe("Document history transport contracts", () => {
  test("parses restore as a bounded stable checkpoint identity", () => {
    const parsed = parseDocumentVersionRestore(restoreRequest);
    expect(parsed.versionId).toBe(restoreRequest.versionId);
    expect(parsed.expectedHeadSeq).toBe(17);
  });

  test("keeps host audit identity outside exact restore semantics", () => {
    const first = canonicalizeDocumentVersionRestoreIntent(restoreRequest);
    const retried = canonicalizeDocumentVersionRestoreIntent({
      ...restoreRequest,
      clientSessionId: "replacement-window",
      actor: { kind: "trusted", retry: true },
    });
    expect(first).toBe(retried);
  });

  test("binds checkpoint actor at the trusted transport boundary", () => {
    const bound = bindTrustedDocumentVersionCheckpoint(
      {
        operationId: "checkpoint:one",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        documentId: "document-1",
        expectedGeneration: 2,
        expectedHeadSeq: 9,
        cause: "manual",
        actor: { kind: "spoofed" },
      },
      "project-1",
      "document-1",
      { kind: "electron_renderer", clientId: "window-1" },
    );
    expect(bound.actor.kind).toBe("electron_renderer");
    expect(bound.actor.clientId).toBe("window-1");
    expect(bound.operationId).toBe("checkpoint:one");
    const { operationId: _operationId, ...withoutIdentity } = bound;
    expect(() => parseCreateDocumentVersionCheckpoint(withoutIdentity)).toThrow(
      DocumentHistoryContractError,
    );
  });

  test("rejects partial pagination cursors and cross-scope checkpoints", () => {
    let cursorError: unknown;
    let scopeError: unknown;
    try {
      parseListDocumentVersions({
        projectId: "project-1",
        documentId: "document-1",
        before: { baseHeadSeq: 4 },
      });
    } catch (error) {
      cursorError = error;
    }
    try {
      bindTrustedDocumentVersionCheckpoint(
        {
          operationId: "checkpoint:cross-scope",
          projectId: "project-2",
          storeEpoch: "epoch-1",
          documentId: "document-1",
          expectedGeneration: 2,
          expectedHeadSeq: 9,
          cause: "manual",
          actor: {},
        },
        "project-1",
        "document-1",
        {},
      );
    } catch (error) {
      scopeError = error;
    }
    expect(cursorError instanceof DocumentHistoryContractError).toBe(true);
    expect(scopeError instanceof DocumentHistoryContractError).toBe(true);
  });

  test("rejects inconsistent checkpoint evidence and summary metadata", () => {
    expect(() =>
      bindTrustedDocumentVersionCheckpoint(
        {
          operationId: "checkpoint:inconsistent-evidence",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          documentId: "document-1",
          expectedGeneration: 2,
          expectedHeadSeq: 9,
          cause: "manual",
          actor: {},
          revisionKind: "manual",
          sourceMutationId: "mutation-1",
        },
        "project-1",
        "document-1",
        {},
      ),
    ).toThrow(DocumentHistoryContractError);
    expect(() =>
      parseDocumentVersionSummary({
        versionId: `document-version:${"a".repeat(64)}`,
        documentId: "document-1",
        projectId: "project-1",
        generation: 1,
        baseHeadSeq: 1,
        schemaKey: "nodex.canvas",
        schemaVersion: 1,
        cause: "manual",
        label: null,
        actor: {},
        revisionKind: "manual",
        sourceMutationId: null,
        sourceChangeSeq: null,
        pinned: true,
        checkpointHash: "b".repeat(64),
        materializationHash: "c".repeat(64),
        byteLength: 16,
        materializationKind: "canvas_scene",
        title: null,
        preview: "Canvas",
        blockCount: 1,
        createdAt: "2026-07-19T21:20:00.000Z",
        fileSnapshotStatus: "exact",
        checkpointMetadata: { format: "block_tree_snapshot_v2" },
      }),
    ).toThrow(DocumentHistoryContractError);
  });

  test.each(["block_tree_snapshot_v2", "block_tree_snapshot_v3"])(
    "accepts an empty Page checkpoint in %s",
    (format) => {
      expect(
        parseDocumentVersionSummary({
          versionId: `document-version:${"d".repeat(64)}`,
          documentId: "document-1",
          projectId: "project-1",
          generation: 1,
          baseHeadSeq: 0,
          schemaKey: "nodex.page",
          schemaVersion: 3,
          cause: "manual",
          label: null,
          actor: {},
          revisionKind: "manual",
          sourceMutationId: null,
          sourceChangeSeq: null,
          pinned: true,
          checkpointHash: "e".repeat(64),
          materializationHash: "f".repeat(64),
          byteLength: 16,
          materializationKind: "page",
          title: "",
          preview: "",
          blockCount: 0,
          createdAt: "2026-07-19T21:30:00.000Z",
          fileSnapshotStatus: "exact",
          checkpointMetadata: { format },
        }),
      ).toMatchObject({ title: "", preview: "", blockCount: 0 });
    },
  );
});
