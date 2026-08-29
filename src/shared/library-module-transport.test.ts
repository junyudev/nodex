import { describe, expect, test } from "vite-plus/test";

import {
  bindLibraryModuleApply,
  bindLibraryModuleRead,
  parseLibraryModuleApplyResult,
  parseLibraryModuleReadResult,
} from "./library-module-transport";
import {
  primaryCanvasBlockId,
  primaryCanvasDocumentId,
} from "./block-documents/canvas-document-identity";
import { createUuidV7FromTimestamp } from "./uuid-v7";
import { committedLocalCommit } from "./testing/local-commit";

const uuidV7 = (sequence: number): string => createUuidV7FromTimestamp(1_785_491_085_000, sequence);

const primaryCanvasId = primaryCanvasBlockId("project:default");
const primaryDocumentId = primaryCanvasDocumentId("project:default");
const structuralDigest = "a".repeat(64);
const readResult = (value: unknown) => ({
  ok: true,
  value: {
    profileId: "profile-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 3,
    authorization: null,
    value,
  },
});

describe("Library Module transport", () => {
  test("binds canonical atomic Page mention creation and rejects widened destinations", () => {
    const existingDocumentId = `document:${uuidV7(5)}`;
    const request = {
      operationId: uuidV7(1),
      storeEpoch: "epoch-1",
      operation: {
        kind: "create_page_mention",
        pageId: uuidV7(2),
        documentId: uuidV7(3),
        title: "Plan",
        mentionHost: {
          pageId: uuidV7(4),
          documentId: existingDocumentId,
          expectedDocumentGeneration: 1,
          expectedDocumentHeadSeq: 7,
          blockId: uuidV7(6),
          expectedContent: [
            { type: "text", text: "+", styles: {} },
            { type: "text", text: "plan", styles: {} },
          ],
          replacementContent: [
            { type: "pageMention", targetPageId: uuidV7(2) },
            { type: "text", text: " ", styles: {} },
          ],
        },
        destination: {
          pageId: uuidV7(4),
          documentId: existingDocumentId,
          expectedDocumentGeneration: 1,
          expectedDocumentHeadSeq: 7,
          insertion: { kind: "append" },
        },
      },
    };

    expect(bindLibraryModuleApply(request)).toMatchObject({
      operation: {
        kind: "create_page_mention",
        mentionHost: {
          expectedContent: [{ type: "text", text: "+plan", styles: {} }],
        },
        destination: { insertion: { kind: "append" } },
      },
    });

    expect(() =>
      bindLibraryModuleApply({
        ...request,
        operation: {
          ...request.operation,
          destination: {
            ...request.operation.destination,
            insertion: { kind: "before", anchorBlockId: uuidV7(7) },
          },
        },
      }),
    ).toThrow("insertion.kind must be append");
    expect(() =>
      bindLibraryModuleApply({
        ...request,
        operation: {
          ...request.operation,
          mentionHost: { ...request.operation.mentionHost, forged: true },
        },
      }),
    ).toThrow("mentionHost.forged is not supported");
  });

  test("binds bounded navigation requests without caller Library identity", () => {
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "children",
          parent: { kind: "page", pageId: "page-1" },
          limit: 50,
        },
      }),
    ).toEqual({
      read: {
        mode: "children",
        parent: { kind: "page", pageId: "page-1" },
        limit: 50,
      },
    });
    expect(() =>
      bindLibraryModuleRead({
        libraryId: "forged-library",
        read: { mode: "metadata" },
      }),
    ).toThrow("libraryId is not supported");
  });

  test("binds and parses the narrow Page mention destination head", () => {
    const pageId = uuidV7(8);
    const documentId = `document:${uuidV7(9)}`;
    expect(
      bindLibraryModuleRead({
        read: { mode: "page_mention_destination", pageId },
      }),
    ).toEqual({
      read: { mode: "page_mention_destination", pageId },
    });
    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "page_mention_destination",
          value: {
            pageId,
            documentId,
            documentGeneration: 2,
            documentHeadSeq: 9,
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "page_mention_destination",
          value: {
            pageId,
            documentId,
            documentGeneration: 2,
            documentHeadSeq: 9,
          },
        },
      },
    });
  });

  test("binds contextual Page reference reads and preserves Core match provenance", () => {
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "page_reference_candidates",
          query: "projection",
          limit: 24,
          sourcePageId: "page:host",
        },
      }),
    ).toEqual({
      read: {
        mode: "page_reference_candidates",
        query: "projection",
        limit: 24,
        sourcePageId: "page:host",
      },
    });

    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "page_reference_candidates",
          items: [
            {
              pageId: "page:target",
              title: "Projection notes",
              pageKey: "NDX-42",
              status: "build",
              locationLabel: "Product / Editor",
              matchExcerpt: "The projection stays bounded.",
              matchSource: "content",
              titleParts: [
                { text: "Projection", highlighted: true },
                { text: " notes", highlighted: false },
              ],
              matchExcerptParts: [
                { text: "The ", highlighted: false },
                { text: "projection", highlighted: true },
                { text: " stays bounded.", highlighted: false },
              ],
              matches: [
                {
                  source: "title",
                  quality: "exact",
                  parts: [
                    { text: "Projection", highlighted: true },
                    { text: " notes", highlighted: false },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "page_reference_candidates",
          items: [
            {
              pageId: "page:target",
              matchSource: "content",
            },
          ],
        },
      },
    });
  });

  test("preserves a typed Page-search candidate-budget failure", () => {
    expect(
      parseLibraryModuleReadResult({
        ok: false,
        error: {
          code: "resource_exhausted",
          message: "Page search term matches too many body units",
          retryable: false,
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "resource_exhausted",
        message: "Page search term matches too many body units",
        retryable: false,
      },
    });
  });

  test("binds and parses the authoritative Project access matrix", () => {
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "resource_project_access",
          target: { kind: "page", pageId: "page-1" },
        },
      }),
    ).toEqual({
      read: {
        mode: "resource_project_access",
        target: { kind: "page", pageId: "page-1" },
      },
    });

    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "resource_project_access",
          value: {
            target: { kind: "page", pageId: "page-1" },
            projects: [
              {
                projectId: "project-1",
                projectName: "Product",
                appearance: {
                  color: "blue",
                  marker: { kind: "icon", icon: "folder" },
                },
                lifecycle: "active",
                directGrant: { access: "read_write", revision: 3 },
                inheritedSources: [
                  {
                    kind: "ancestor_page",
                    pageId: "page-parent",
                    pageTitle: "Strategy",
                    access: "read",
                  },
                ],
                effectiveAccess: "read_write",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "resource_project_access",
          value: {
            projects: [
              {
                projectId: "project-1",
                directGrant: { revision: 3 },
                inheritedSources: [{ kind: "ancestor_page" }],
              },
            ],
          },
        },
      },
    });
  });

  test("rejects unbounded and structurally ambiguous requests", () => {
    expect(() =>
      bindLibraryModuleRead({
        read: {
          mode: "children",
          parent: { kind: "library" },
          limit: 101,
        },
      }),
    ).toThrow("between 1 and 100");
    expect(() =>
      bindLibraryModuleRead({
        read: {
          mode: "catalog",
          kinds: ["page", "page"],
        },
      }),
    ).toThrow("unique kinds");
  });

  test("parses an authoritative children snapshot", () => {
    expect(
      parseLibraryModuleReadResult({
        ok: true,
        value: {
          profileId: "profile-1",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          commitSeq: 3,
          authorization: null,
          value: {
            kind: "children",
            parent: { kind: "library" },
            items: [
              {
                kind: "database",
                databaseId: "database-1",
                title: "Tasks",
                defaultViewId: "view-1",
                hasMultipleViews: false,
                metadataRevision: 1,
                locationRevision: 1,
                updatedAt: "2026-07-18T00:00:00.000Z",
              },
            ],
            nextCursor: null,
            hasMore: false,
            total: 1,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        profileId: "profile-1",
        value: { kind: "children", total: 1 },
      },
    });
  });

  test("binds and parses a move destination window", () => {
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "move_destinations",
          target: { kind: "page", pageId: "page-source" },
          scope: {
            kind: "children",
            parent: { kind: "page", pageId: "page-parent" },
          },
          limit: 50,
        },
      }),
    ).toEqual({
      read: {
        mode: "move_destinations",
        target: { kind: "page", pageId: "page-source" },
        scope: {
          kind: "children",
          parent: { kind: "page", pageId: "page-parent" },
        },
        limit: 50,
      },
    });

    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "move_destinations",
          target: { kind: "page", pageId: "page-source" },
          scope: { kind: "search", query: "roadmap" },
          items: [
            {
              pageId: "page-roadmap",
              title: "Roadmap",
              path: ["Pages", "Product"],
              hasChildren: true,
              isCurrent: false,
              documentGeneration: 2,
              documentHeadSeq: 7,
              updatedAt: "2026-08-11T00:00:00.000Z",
            },
          ],
          currentDestination: {
            pageId: "page-product",
            title: "Product",
            path: ["Pages"],
            hasChildren: true,
            isCurrent: true,
            documentGeneration: 1,
            documentHeadSeq: 12,
            updatedAt: "2026-08-10T00:00:00.000Z",
          },
          nextCursor: null,
          hasMore: false,
          total: 1,
          rootIsCurrent: false,
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "move_destinations",
          items: [
            {
              pageId: "page-roadmap",
              path: ["Pages", "Product"],
              documentGeneration: 2,
              documentHeadSeq: 7,
            },
          ],
          currentDestination: {
            pageId: "page-product",
            isCurrent: true,
          },
        },
      },
    });
  });

  test("binds and parses standalone roots while rejecting View entries", () => {
    const pageId = uuidV7(31);
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "standalone_roots",
          cursor: "cursor-1",
          limit: 10,
          forceIncludeTarget: { kind: "page", pageId },
        },
      }),
    ).toEqual({
      read: {
        mode: "standalone_roots",
        cursor: "cursor-1",
        limit: 10,
        forceIncludeTarget: { kind: "page", pageId },
      },
    });

    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "standalone_roots",
          items: [
            {
              kind: "page",
              pageId,
              title: "Prompts",
              hasChildren: false,
              parentRevision: 1,
              metadataRevision: 1,
              documentGeneration: 1,
              documentHeadSeq: 0,
              updatedAt: "2026-08-03T00:00:00.000Z",
            },
          ],
          nextCursor: null,
          hasMore: false,
          total: 1,
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "standalone_roots",
          items: [{ kind: "page", pageId }],
          total: 1,
        },
      },
    });

    expect(() =>
      parseLibraryModuleReadResult(
        readResult({
          kind: "standalone_roots",
          items: [
            {
              kind: "view",
              viewId: uuidV7(32),
              databaseId: uuidV7(33),
              dataSourceId: uuidV7(34),
              title: "Board",
              defaultLayout: "board",
              isDefault: true,
              revision: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
          total: 1,
        }),
      ),
    ).toThrow("cannot contain Views");
  });

  test("binds and parses the deterministic primary Canvas identity", () => {
    expect(
      bindLibraryModuleRead({
        read: {
          mode: "canvas_target",
          canvasId: primaryCanvasId,
        },
      }),
    ).toEqual({
      read: {
        mode: "canvas_target",
        canvasId: primaryCanvasId,
      },
    });

    expect(
      parseLibraryModuleReadResult({
        ok: true,
        value: {
          profileId: "profile-1",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          commitSeq: 3,
          authorization: null,
          value: {
            kind: "canvas_target",
            value: {
              status: "available",
              summary: {
                canvasId: primaryCanvasId,
                projectId: "project:default",
                title: "Canvas",
                lifecycle: "active",
                isPrimary: true,
                location: { kind: "library" },
                metadataRevision: 1,
                locationRevision: 1,
                documentGeneration: 1,
                documentHeadSeq: 0,
                updatedAt: "2026-07-31T00:00:00.000Z",
              },
            },
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "canvas_target",
          value: {
            status: "available",
            summary: {
              canvasId: primaryCanvasId,
              isPrimary: true,
            },
          },
        },
      },
    });

    expect(
      parseLibraryModuleReadResult({
        ok: true,
        value: {
          profileId: "profile-1",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
          commitSeq: 3,
          authorization: null,
          value: {
            kind: "children",
            parent: { kind: "library" },
            items: [
              {
                kind: "canvas",
                canvasId: primaryCanvasId,
                title: "Canvas",
                isPrimary: true,
                metadataRevision: 1,
                locationRevision: 1,
                documentGeneration: 1,
                documentHeadSeq: 0,
                updatedAt: "2026-07-31T00:00:00.000Z",
              },
            ],
            nextCursor: null,
            hasMore: false,
            total: 1,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          items: [{ canvasId: primaryCanvasId, isPrimary: true }],
        },
      },
    });
  });

  test("accepts primary identities only for existing Canvas coordinates", () => {
    const destination = { kind: "library" } as const;
    const base = {
      operationId: uuidV7(1),
      storeEpoch: "epoch-1",
    } as const;

    expect(
      bindLibraryModuleApply({
        ...base,
        operation: {
          kind: "rename_canvas",
          canvasId: primaryCanvasId,
          displayName: "Architecture",
          expectedMetadataRevision: 1,
        },
      }).operation,
    ).toMatchObject({ canvasId: primaryCanvasId });
    expect(
      bindLibraryModuleApply({
        ...base,
        operationId: uuidV7(2),
        operation: {
          kind: "move_canvas",
          canvasId: primaryCanvasId,
          expectedLocationRevision: 1,
          destination,
        },
      }).operation,
    ).toMatchObject({ canvasId: primaryCanvasId });
    expect(
      bindLibraryModuleApply({
        ...base,
        operationId: uuidV7(3),
        operation: {
          kind: "delete_canvas",
          canvasId: primaryCanvasId,
          expectedLocationRevision: 1,
          expectedMetadataRevision: 1,
        },
      }).operation,
    ).toMatchObject({ canvasId: primaryCanvasId });
    expect(
      bindLibraryModuleApply({
        ...base,
        operationId: uuidV7(4),
        operation: {
          kind: "duplicate_canvas",
          sourceCanvasId: primaryCanvasId,
          canvasId: uuidV7(5),
          documentId: uuidV7(6),
          expectedDocumentGeneration: 1,
          expectedDocumentHeadSeq: 0,
          destination,
        },
      }).operation,
    ).toMatchObject({ sourceCanvasId: primaryCanvasId });

    expect(() =>
      bindLibraryModuleApply({
        ...base,
        operationId: uuidV7(7),
        operation: {
          kind: "create_canvas",
          canvasId: primaryCanvasId,
          documentId: uuidV7(8),
          displayName: "Canvas",
          destination,
        },
      }),
    ).toThrow("expected canonical lowercase UUID-v7");
    expect(() =>
      bindLibraryModuleRead({
        read: {
          mode: "canvas_target",
          canvasId: "canvas:primary:",
        },
      }),
    ).toThrow("primary Canvas Block ID");
  });

  test("binds one revision-fenced Project access batch", () => {
    const operation = bindLibraryModuleApply({
      operationId: uuidV7(20),
      storeEpoch: "epoch-1",
      operation: {
        kind: "set_project_access",
        target: { kind: "page", pageId: "page-1" },
        changes: [
          { projectId: "project-1", access: null, expectedRevision: 4 },
          { projectId: "project-2", access: "read", expectedRevision: null },
        ],
      },
    }).operation;

    expect(operation).toEqual({
      kind: "set_project_access",
      target: { kind: "page", pageId: "page-1" },
      changes: [
        { projectId: "project-1", access: null, expectedRevision: 4 },
        { projectId: "project-2", access: "read", expectedRevision: null },
      ],
    });
  });

  test("binds one atomic Page metadata operation from owning-module payloads", () => {
    const operation = bindLibraryModuleApply({
      operationId: uuidV7(21),
      storeEpoch: "epoch-1",
      operation: {
        kind: "apply_page_metadata_properties",
        clientSessionId: "window-1",
        databaseOperations: [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: "page-1",
                dataSourceId: "source-1",
                propertyId: "priority",
                edit: {
                  kind: "replace",
                  expectedValueRevision: 3,
                  value: { kind: "select", optionId: "p1-high" },
                },
              },
            ],
          },
        ],
        intrinsicFields: [
          {
            scope: "intrinsic",
            blockId: "page-1",
            propertyKey: "schedule.isAllDay",
            operation: "set",
            expectedRevision: 2,
            value: true,
          },
        ],
      },
    }).operation;

    expect(operation).toMatchObject({
      kind: "apply_page_metadata_properties",
      clientSessionId: "window-1",
      databaseOperations: [{ kind: "edit_property_values" }],
      intrinsicFields: [
        {
          scope: "intrinsic",
          propertyKey: "schedule.isAllDay",
        },
      ],
    });
    expect(() =>
      bindLibraryModuleApply({
        operationId: uuidV7(22),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_page_metadata_properties",
          databaseOperations: [
            {
              kind: "delete_property",
              dataSourceId: "source-1",
              propertyId: "priority",
              expectedDataSourceRevision: 1,
              expectedPropertyRevision: 1,
            },
          ],
          intrinsicFields: [
            {
              scope: "intrinsic",
              blockId: "page-1",
              propertyKey: "schedule.isAllDay",
              operation: "set",
              expectedRevision: 2,
              value: true,
            },
          ],
        },
      }),
    ).toThrow("only supports Page Property value edits");
  });

  test("parses primary Canvas unavailable, path, and catalog targets", () => {
    for (const value of [
      {
        kind: "canvas_target",
        value: { status: "missing", canvasId: primaryCanvasId },
      },
      {
        kind: "canvas_target",
        value: {
          status: "deleted",
          canvasId: primaryCanvasId,
          libraryId: "library-1",
        },
      },
    ]) {
      expect(parseLibraryModuleReadResult(readResult(value))).toMatchObject({
        ok: true,
        value: {
          value: {
            kind: "canvas_target",
            value: { canvasId: primaryCanvasId },
          },
        },
      });
    }

    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "path",
          target: { kind: "canvas", canvasId: primaryCanvasId },
          nodes: [],
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          target: { kind: "canvas", canvasId: primaryCanvasId },
        },
      },
    });
    expect(
      parseLibraryModuleReadResult(
        readResult({
          kind: "catalog",
          items: [
            {
              target: { kind: "canvas", canvasId: primaryCanvasId },
              title: "Canvas",
              kind: "canvas",
              lifecycle: "active",
              locationLabel: "Library",
              updatedAt: "2026-07-31T00:00:00.000Z",
              locationRevision: 1,
              metadataRevision: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
          total: 1,
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          items: [
            {
              target: { kind: "canvas", canvasId: primaryCanvasId },
            },
          ],
        },
      },
    });
  });

  test("parses Page File body usage and rejects impossible placement counts", () => {
    const file = {
      fileId: "file-1",
      ownerPageId: "page-1",
      logicalPath: "images/diagram.png",
      mimeType: "image/png",
      byteLength: 12,
      version: 1,
      blobEtag: "etag-1",
      state: "live",
      createdByActorId: "actor-1",
      createdByTurnId: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      bodyUsage: { kind: "placed", placementCount: 2 },
    };
    const manifest = {
      kind: "page_files",
      value: {
        pageId: "page-1",
        revision: 3,
        bodyUsageRevision: 4,
        files: [file],
        nextCursor: null,
        hasMore: false,
        total: 1,
        liveTotal: 1,
        unplacedTotal: 0,
        placedTotal: 1,
        deletedTotal: 0,
      },
    };

    expect(parseLibraryModuleReadResult(readResult(manifest))).toMatchObject({
      value: {
        value: {
          value: {
            bodyUsageRevision: 4,
            files: [{ bodyUsage: { kind: "placed", placementCount: 2 } }],
          },
        },
      },
    });
    expect(() =>
      parseLibraryModuleReadResult(
        readResult({
          ...manifest,
          value: {
            ...manifest.value,
            files: [{ ...file, bodyUsage: { kind: "placed", placementCount: 0 } }],
          },
        }),
      ),
    ).toThrow("placementCount must be positive");
  });

  test("parses primary Canvas mutation receipts without weakening new IDs", () => {
    expect(
      parseLibraryModuleApplyResult({
        ok: true,
        localCommit: committedLocalCommit("epoch-1", 4),
        value: {
          operationId: uuidV7(1),
          profileId: "profile-1",
          storeEpoch: "epoch-1",
          libraryId: "library-1",
          operationKind: "rename_canvas",
          duplicate: false,
          didMutate: true,
          createdTarget: null,
          canvasMutation: {
            operationKind: "rename_canvas",
            canvasId: primaryCanvasId,
            documentId: primaryDocumentId,
            sourceCanvasId: null,
            locationRevision: 1,
            metadataRevision: 2,
            documentCommits: [],
          },
          structuralEdit: null,
          affectedParentKeys: ["library"],
          affectedPageIds: [],
          affectedDatabaseIds: [],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: 4,
          committedAt: "2026-07-31T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        canvasMutation: {
          canvasId: primaryCanvasId,
          documentId: primaryDocumentId,
        },
      },
    });
  });

  test("binds structural edit capabilities and parses reversible receipts", () => {
    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(2),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "delete_selection",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["block:one", "block:two"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            reason: {
              kind: "cut",
              bundle: {
                bundleId: "bundle:one",
                capability: structuralDigest,
                manifestHash: structuralDigest,
                storeEpoch: "epoch-1",
              },
            },
            direction: "backward",
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: {
          selection: { rootBlockIds: ["block:one", "block:two"] },
          reason: { kind: "cut", bundle: { bundleId: "bundle:one" } },
        },
      },
    });

    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(3),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "move_selection",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["block:one", "page:one"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            target: {
              targetDocumentId: "document:target",
              parentBlockId: null,
              beforeBlockId: null,
              targetHead: {
                documentId: "document:target",
                generation: 2,
                expectedHeadSeq: 9,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: {
          kind: "move_selection",
          selection: { rootBlockIds: ["block:one", "page:one"] },
          target: { targetDocumentId: "document:target" },
        },
      },
    });

    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(4),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "replace_selection",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["page:one"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            replacement: {
              kind: "blocks",
              blocks: [
                {
                  blockType: "paragraph",
                  props: {},
                  content: [{ type: "text", text: "replacement", styles: {} }],
                  children: [],
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: {
          kind: "replace_selection",
          replacement: { kind: "blocks", blocks: [{ blockType: "paragraph" }] },
        },
      },
    });

    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(5),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "turn_selection_into",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["block:one", "page:one"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            target: { kind: "heading", level: "two", toggleable: true },
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: {
          kind: "turn_selection_into",
          target: { kind: "heading", level: "two", toggleable: true },
        },
      },
    });

    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(9),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "merge_block_backward",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["block:source"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            targetBlockId: "block:target",
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: {
          kind: "merge_block_backward",
          selection: { rootBlockIds: ["block:source"] },
          targetBlockId: "block:target",
        },
      },
    });

    expect(() =>
      bindLibraryModuleApply({
        operationId: uuidV7(6),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "turn_selection_into",
            selection: {
              sourceDocumentId: "document:source",
              rootBlockIds: ["page:one"],
              sourceHead: {
                documentId: "document:source",
                generation: 1,
                expectedHeadSeq: 7,
              },
            },
            target: { kind: "heading", level: "four", toggleable: true },
          },
        },
      }),
    ).toThrow(/target\.level is unsupported/);

    expect(
      bindLibraryModuleApply({
        operationId: uuidV7(7),
        storeEpoch: "epoch-1",
        operation: {
          kind: "apply_structural_edit",
          command: {
            kind: "release_history",
            tokens: [
              {
                recipeOperationId: "recipe:one",
                recipeHash: structuralDigest,
                storeEpoch: "epoch-1",
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      operation: {
        command: { kind: "release_history", tokens: [{ recipeOperationId: "recipe:one" }] },
      },
    });

    expect(() =>
      bindLibraryModuleApply({
        operationId: uuidV7(8),
        storeEpoch: "epoch-1",
        operation: {
          kind: "reverse_structural_edit",
          token: {
            recipeOperationId: "recipe:one",
            recipeHash: "not-a-digest",
            storeEpoch: "epoch-1",
          },
        },
      }),
    ).toThrow("lowercase SHA-256 digest");

    expect(
      parseLibraryModuleApplyResult({
        ok: true,
        localCommit: committedLocalCommit("epoch-1", 5),
        value: {
          operationId: uuidV7(6),
          profileId: "profile-1",
          storeEpoch: "epoch-1",
          libraryId: "library-1",
          operationKind: "apply_structural_edit",
          duplicate: false,
          didMutate: true,
          createdTarget: null,
          canvasMutation: null,
          structuralEdit: {
            operationKind: "delete_selection",
            sourceRootBlockIds: ["block:one"],
            resultRootBlockIds: [],
            copiedBlockIds: {},
            copiedDocumentIds: {},
            documentCommits: [],
            affectedPageIds: ["page:one"],
            affectedDatabaseIds: [],
            fileOwnershipMoves: [],
            clipboard: null,
            history: {
              recipeOperationId: "recipe:one",
              recipeHash: structuralDigest,
              storeEpoch: "epoch-1",
            },
            supersededHistoryRecipeOperationIds: [],
            resume: {
              blockId: "block:previous",
              edge: "end",
              fallbackBeforeBlockId: null,
              fallbackAfterBlockId: "block:next",
            },
          },
          affectedParentKeys: [],
          affectedPageIds: ["page:one"],
          affectedDatabaseIds: [],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: 5,
          committedAt: "2026-08-21T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        structuralEdit: {
          history: { recipeOperationId: "recipe:one" },
          resume: { blockId: "block:previous", edge: "end" },
        },
      },
    });
  });
});
