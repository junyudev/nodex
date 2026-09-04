import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  type LibraryCanvasSummary,
  type LibraryModuleApplyRequest,
  type LibraryModuleApplyResult,
} from "../../shared/library-module";
import { bindLibraryModuleApply } from "../../shared/library-module-transport";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import {
  projectContentAccess,
  type ContentAccessContext,
} from "../../shared/content-access-context";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import { applyLibraryModule, readLibraryModule } from "./api";
import {
  applyLibraryRequestWithExactRetry,
  createCanvasInHostPage,
  createCanvasPageDestination,
  deleteCanvasOwner,
  duplicateCanvasInHostPage,
  moveCanvasOwnerBetweenHostPages,
  prepareCanvasHost,
  registerCanvasHostDocumentRuntime,
  resolveCanvasDropInsertion,
  resolveCanvasHostDocumentRuntime,
  resolveCanvasInsertionAfterBlock,
  type CanvasHostDocumentRuntime,
} from "./canvas-host-operations";

vi.mock("./api", () => ({
  applyLibraryModule: vi.fn(),
  readLibraryModule: vi.fn(),
}));

const uuidV7 = (sequence: number): string => createUuidV7FromTimestamp(1_785_491_085_000, sequence);
const accessContext = projectContentAccess("project-1");

function makeRuntime(
  input: {
    readonly storeEpoch?: string;
    readonly generation?: number;
    readonly headSeq?: number;
    readonly documentId?: string;
    readonly ownerBlockId?: string;
  } = {},
): CanvasHostDocumentRuntime {
  const storeEpoch = input.storeEpoch ?? "epoch-1";
  const documentId = input.documentId ?? "document-1";
  const ownerBlockId = input.ownerBlockId ?? uuidV7(1);
  const generation = input.generation ?? 2;
  const headSeq = input.headSeq ?? 7;
  let flushed = false;
  const getStatus = () =>
    ({
      phase: "ready",
      ready: true,
      reloadRequired: false,
      structuralWaitStartedAt: null,
      writeFrozen: false,
      descriptor: {
        libraryId: "library-1",
        accessContext,
        documentId,
        authorization: null,
        ownerBlockId,
        ownerType: "page",
        ownerLifecycle: "active",
        schemaKey: "nodex.page",
        schemaVersion: 1,
        storeEpoch,
        generation,
        headSeq: flushed ? headSeq + 1 : headSeq,
        readiness: "ready",
        sync: { kind: "yjs", stateVector: new Uint8Array() },
      },
      provider: {
        phase: "synced",
        documentId,
        clientSessionId: "client-1",
        connected: true,
        storeEpoch,
        generation,
        headSeq: flushed ? headSeq + 1 : headSeq,
        pendingUpdateCount: 0,
        checkpoint: { phase: "ready", failureCount: 0 },
      },
    }) as ReturnType<CanvasHostDocumentRuntime["getStatus"]>;
  return {
    getStatus,
    flushAndFence: async () => {
      flushed = true;
      return {
        documentId,
        storeEpoch,
        generation,
        expectedHeadSeq: headSeq + 1,
      };
    },
  };
}

const canvasSummary = (canvasId: string): LibraryCanvasSummary => ({
  canvasId,
  title: "Canvas",
  lifecycle: "active",
  isPrimary: false,
  location: { kind: "page", pageId: uuidV7(1), documentId: "document-1" },
  locationRevision: 3,
  metadataRevision: 5,
  documentGeneration: 9,
  documentHeadSeq: 99,
  updatedAt: "2026-07-30T00:00:00.000Z",
});

const receiptFor = (
  request: LibraryModuleApplyRequest,
): Extract<LibraryModuleApplyResult, { readonly ok: true }> => ({
  ok: true,
  localCommit: noOpLocalCommit(request.storeEpoch),
  value: {
    operationId: request.operationId,
    profileId: "profile-1",
    storeEpoch: request.storeEpoch,
    libraryId: "library-1",
    operationKind: request.operation.kind,
    duplicate: false,
    didMutate: true,
    createdTarget: null,
    canvasMutation: null,
    structuralEdit: null,
    affectedParentKeys: [],
    affectedPageIds: [],
    affectedDatabaseIds: [],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 10,
    committedAt: "2026-07-30T00:00:00.000Z",
  },
});

describe("Canvas host operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readLibraryModule).mockImplementation(async (receivedAccessContext, request) => {
      expect(receivedAccessContext).toEqual(accessContext);
      return {
        ok: true,
        value: {
          profileId: "profile-1",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          commitSeq: 9,
          authorization: null,
          value: {
            kind: "canvas_target",
            value: {
              status: "available",
              summary: canvasSummary(
                request.read.mode === "canvas_target" ? request.read.canvasId : uuidV7(90),
              ),
            },
          },
        },
      };
    });
    vi.mocked(applyLibraryModule).mockImplementation(async (receivedAccessContext, request) => {
      expect(receivedAccessContext).toEqual(accessContext);
      bindLibraryModuleApply(request);
      return receiptFor(request);
    });
  });

  test("captures the persisted host head, not the pre-flush head", async () => {
    await expect(prepareCanvasHost(makeRuntime())).resolves.toEqual({
      storeEpoch: "epoch-1",
      documentId: "document-1",
      ownerBlockId: uuidV7(1),
      documentRevision: {
        expectedDocumentGeneration: 2,
        expectedDocumentHeadSeq: 8,
      },
    });
  });

  test("builds a Page destination from only the Document revision", () => {
    expect(
      createCanvasPageDestination({
        pageId: uuidV7(1),
        documentRevision: {
          expectedDocumentGeneration: 2,
          expectedDocumentHeadSeq: 8,
        },
        insertion: {
          kind: "before",
          anchorBlockId: uuidV7(2),
        },
      }),
    ).toEqual({
      kind: "page",
      pageId: uuidV7(1),
      expectedDocumentGeneration: 2,
      expectedDocumentHeadSeq: 8,
      insertion: {
        kind: "before",
        anchorBlockId: uuidV7(2),
      },
    });
  });

  test("creates, duplicates, and moves with exact transport destinations", async () => {
    const pageId = uuidV7(1);
    const replacementBlockId = uuidV7(2);
    const canvasId = uuidV7(3);
    const canvasDocumentId = uuidV7(4);
    const duplicateCanvasId = uuidV7(5);
    const duplicateDocumentId = uuidV7(6);
    const runtime = makeRuntime({ ownerBlockId: pageId });

    await createCanvasInHostPage({
      accessContext,
      hostPageId: pageId,
      replacementBlockId,
      runtime,
      identities: {
        operationId: uuidV7(7),
        canvasId,
        documentId: canvasDocumentId,
      },
    });
    await duplicateCanvasInHostPage({
      accessContext,
      sourceCanvasBlockId: canvasId,
      hostPageId: pageId,
      insertion: { kind: "append" },
      runtime,
      identities: {
        operationId: uuidV7(8),
        canvasId: duplicateCanvasId,
        documentId: duplicateDocumentId,
      },
    });
    await moveCanvasOwnerBetweenHostPages({
      accessContext,
      canvasBlockId: canvasId,
      targetPageId: pageId,
      insertion: {
        kind: "before",
        anchorBlockId: replacementBlockId,
      },
      sourceRuntime: runtime,
      targetRuntime: runtime,
      operationId: uuidV7(9),
    });

    expect(applyLibraryModule).toHaveBeenCalledTimes(3);
    for (const [receivedAccessContext, request] of vi.mocked(applyLibraryModule).mock.calls) {
      expect(receivedAccessContext).toEqual(accessContext);
      const operation = request.operation;
      if (
        operation.kind !== "create_canvas" &&
        operation.kind !== "duplicate_canvas" &&
        operation.kind !== "move_canvas"
      ) {
        throw new Error(`Unexpected operation ${operation.kind}`);
      }
      expect(operation.destination.kind).toBe("page");
      expect(Object.keys(operation.destination).sort()).toEqual([
        "expectedDocumentGeneration",
        "expectedDocumentHeadSeq",
        "insertion",
        "kind",
        "pageId",
      ]);
    }
  });

  test("uses the target Page Document revision for a cross-Page move", async () => {
    const canvasId = uuidV7(1);
    const targetPageId = uuidV7(2);

    await moveCanvasOwnerBetweenHostPages({
      accessContext,
      canvasBlockId: canvasId,
      targetPageId,
      insertion: { kind: "append" },
      sourceRuntime: makeRuntime({
        generation: 2,
        headSeq: 7,
        ownerBlockId: uuidV7(1),
      }),
      targetRuntime: makeRuntime({
        generation: 4,
        headSeq: 20,
        ownerBlockId: targetPageId,
      }),
      operationId: uuidV7(3),
    });

    const request = vi.mocked(applyLibraryModule).mock.calls[0]?.[1];
    expect(request?.operation).toMatchObject({
      kind: "move_canvas",
      canvasId,
      destination: {
        kind: "page",
        pageId: targetPageId,
        expectedDocumentGeneration: 4,
        expectedDocumentHeadSeq: 21,
        insertion: { kind: "append" },
      },
    });
  });

  test("rejects mixed Store coordinates before applying a move", async () => {
    const canvasId = uuidV7(1);
    vi.mocked(readLibraryModule).mockResolvedValueOnce({
      ok: true,
      value: {
        profileId: "profile-1",
        libraryId: "library-1",
        storeEpoch: "epoch-2",
        commitSeq: 9,
        authorization: null,
        value: {
          kind: "canvas_target",
          value: {
            status: "available",
            summary: canvasSummary(canvasId),
          },
        },
      },
    });

    await expect(
      moveCanvasOwnerBetweenHostPages({
        accessContext,
        canvasBlockId: canvasId,
        targetPageId: uuidV7(2),
        insertion: { kind: "append" },
        sourceRuntime: makeRuntime(),
        targetRuntime: makeRuntime({ ownerBlockId: uuidV7(2) }),
        operationId: uuidV7(3),
      }),
    ).rejects.toThrow("Store changed while preparing Canvas");
    expect(applyLibraryModule).not.toHaveBeenCalled();
  });

  test("retries transport ambiguity with the exact same operation request", async () => {
    const request = {
      operationId: "operation-1",
      storeEpoch: "epoch-1",
      operation: {
        kind: "create_canvas",
        canvasId: "canvas-1",
        documentId: "document-2",
        displayName: "Canvas",
        destination: {
          kind: "page",
          pageId: "page-1",
          expectedDocumentGeneration: 2,
          expectedDocumentHeadSeq: 8,
          insertion: {
            kind: "replace_empty_paragraph",
            blockId: "paragraph-1",
          },
        },
      },
    } satisfies LibraryModuleApplyRequest;
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({
        ok: true,
        value: {
          operationId: "operation-1",
          storeEpoch: "epoch-1",
          libraryId: "library-1",
          operationKind: "create_canvas",
          duplicate: true,
          didMutate: true,
          createdTarget: { kind: "canvas", canvasId: "canvas-1" },
          canvasMutation: null,
          affectedParentKeys: ["page:page-1"],
          affectedPageIds: ["page-1"],
          affectedDatabaseIds: [],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: 9,
          committedAt: "2026-07-30T00:00:00.000Z",
        },
      });

    await applyLibraryRequestWithExactRetry(accessContext, request, apply);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]).toEqual([accessContext, request]);
    expect(apply.mock.calls[1]).toEqual([accessContext, request]);
  });

  test("deletes a nested Canvas with the mounted host Document barrier", async () => {
    const apply = vi.fn(
      async (
        receivedAccessContext: ContentAccessContext,
        request: LibraryModuleApplyRequest,
      ): Promise<LibraryModuleApplyResult> => {
        expect(receivedAccessContext).toEqual(accessContext);
        return {
          ok: true,
          localCommit: noOpLocalCommit(request.storeEpoch),
          value: {
            operationId: request.operationId,
            profileId: "profile-1",
            storeEpoch: request.storeEpoch,
            libraryId: "library-1",
            operationKind: "delete_canvas",
            duplicate: false,
            didMutate: true,
            createdTarget: null,
            canvasMutation: null,
            structuralEdit: null,
            affectedParentKeys: ["page:page-1"],
            affectedPageIds: ["page-1"],
            affectedDatabaseIds: [],
            affectedViewIds: [],
            committedRevisions: {},
            commitSeq: 10,
            committedAt: "2026-07-30T00:00:00.000Z",
          },
        };
      },
    );
    const retireOwner = vi.fn(async () => {
      throw new Error("Canvas scene provider is already closed");
    });

    await deleteCanvasOwner(
      {
        accessContext,
        canvasBlockId: "canvas-1",
        runtime: makeRuntime({ ownerBlockId: "page-1" }),
        operationId: "delete-1",
      },
      {
        readTarget: async (receivedAccessContext) => {
          expect(receivedAccessContext).toEqual(accessContext);
          return {
            libraryId: "library-1",
            storeEpoch: "epoch-1",
            summary: {
              canvasId: "canvas-1",
              title: "Canvas",
              lifecycle: "active",
              isPrimary: false,
              location: {
                kind: "page",
                pageId: "page-1",
                documentId: "document-1",
              },
              locationRevision: 3,
              metadataRevision: 5,
              documentGeneration: 9,
              documentHeadSeq: 99,
              updatedAt: "2026-07-30T00:00:00.000Z",
            },
          } as const;
        },
        apply,
        retireOwner,
      },
    );

    expect(apply).toHaveBeenCalledWith(accessContext, {
      operationId: "delete-1",
      storeEpoch: "epoch-1",
      operation: {
        kind: "delete_canvas",
        canvasId: "canvas-1",
        expectedLocationRevision: 3,
        expectedMetadataRevision: 5,
        containingDocumentHead: {
          documentId: "document-1",
          generation: 2,
          expectedHeadSeq: 8,
        },
      },
    });
    expect(retireOwner).toHaveBeenCalledWith(
      {
        libraryId: "library-1",
        accessContext,
      },
      "canvas-1",
    );
  });

  test("resolves after-position as before-next or append at the same nesting level", () => {
    expect(
      resolveCanvasInsertionAfterBlock({
        blockId: "canvas-1",
        siblingBlockIds: ["canvas-1", "paragraph-2"],
      }),
    ).toEqual({
      kind: "before",
      anchorBlockId: "paragraph-2",
    });
    expect(
      resolveCanvasInsertionAfterBlock({
        blockId: "canvas-1",
        parentBlockId: "toggle-1",
        siblingBlockIds: ["paragraph-1", "canvas-1"],
      }),
    ).toEqual({
      kind: "append",
      parentBlockId: "toggle-1",
    });
  });

  test("resolves drop coordinates to a typed Page insertion", () => {
    expect(
      resolveCanvasDropInsertion({
        parentBlockId: "toggle-1",
        beforeBlockId: "paragraph-2",
      }),
    ).toEqual({
      kind: "before",
      parentBlockId: "toggle-1",
      anchorBlockId: "paragraph-2",
    });
    expect(
      resolveCanvasDropInsertion({
        parentBlockId: "toggle-1",
      }),
    ).toEqual({
      kind: "append",
      parentBlockId: "toggle-1",
    });
  });

  test("keeps the newest runtime when an older surface unmounts", () => {
    const first = makeRuntime();
    const second = makeRuntime({ headSeq: 11 });
    const unregisterFirst = registerCanvasHostDocumentRuntime("surface-1", first);
    const unregisterSecond = registerCanvasHostDocumentRuntime("surface-1", second);

    expect(resolveCanvasHostDocumentRuntime("surface-1")).toBe(second);
    unregisterFirst();
    expect(resolveCanvasHostDocumentRuntime("surface-1")).toBe(second);
    unregisterSecond();
    expect(resolveCanvasHostDocumentRuntime("surface-1")).toBeNull();
  });
});
