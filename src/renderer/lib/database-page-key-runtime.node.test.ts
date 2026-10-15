import { describe, expect, test } from "vite-plus/test";

import { parseDatabaseId } from "../../shared/database-identities";
import type { DatabasePageKeyRuntimeDependencies } from "./database-page-key-runtime";
import {
  DatabasePageKeyRuntimeError,
  previewDatabasePageKeyPrefix,
  readDatabasePageKeyNamespace,
  renameDatabasePageKeyPrefix,
} from "./database-page-key-runtime";

const dependencies = (
  applyProject?: DatabasePageKeyRuntimeDependencies["applyProject"],
): DatabasePageKeyRuntimeDependencies => ({
  readProject: async (projectId, request) => ({
    ok: true,
    value: {
      projectId,
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      commitSeq: 7,
      value:
        request.read.mode === "page_key_namespace"
          ? {
              kind: "page_key_namespace",
              value: {
                databaseId: parseDatabaseId("database:test"),
                currentPrefix: "LAB",
                nextNumber: 14,
                assignedPageCount: 13,
                revision: 3,
                retiredPrefixes: [{ prefix: "OLD", lastNumber: 9 }],
              },
            }
          : {
              kind: "page_key_prefix_preview",
              value: {
                prefix: "LAB",
                availability: "current",
                alternativePrefix: null,
                nextNumber: 14,
                exampleKeys: ["LAB-14", "LAB-15"],
              },
            },
    },
  }),
  readLibrary: async (request) => {
    if (request.read.mode !== "page_key_prefix_preview") {
      throw new Error("Expected a Page-key prefix preview");
    }
    return {
      ok: true,
      value: {
        routingContext: { kind: "library" },
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 7,
        value: {
          kind: "page_key_prefix_preview",
          value: {
            prefix: request.read.requestedPrefix ?? "LAB",
            availability: "available",
            alternativePrefix: null,
            nextNumber: 1,
            exampleKeys: ["LAB-1", "LAB-2"],
          },
        },
      },
    };
  },
  applyProject:
    applyProject ??
    (async () => ({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Namespace changed",
        retryable: false,
      },
    })),
});

describe("Database Page-key runtime", () => {
  test("uses Library preview for create and Project-scoped Database reads for edit", async () => {
    const runtime = dependencies();
    const preview = await previewDatabasePageKeyPrefix(
      {
        nameHint: "Lab",
      },
      runtime,
    );
    const authority = await readDatabasePageKeyNamespace(
      {
        projectId: "project:test",
        databaseId: "database:test",
      },
      runtime,
    );

    expect(preview.exampleKeys).toEqual(["LAB-1", "LAB-2"]);
    expect(authority).toMatchObject({
      storeEpoch: "epoch:test",
      namespace: { currentPrefix: "LAB", revision: 3 },
    });
  });

  test("sends a Database CAS command and preserves typed failure", async () => {
    let requestKind: string | undefined;
    const runtime = dependencies(async (_projectId, request) => {
      requestKind = request.operations[0]?.kind;
      return {
        ok: false,
        error: {
          code: "revision_conflict",
          message: "Namespace changed",
          retryable: false,
        },
      };
    });

    await expect(
      renameDatabasePageKeyPrefix(
        {
          projectId: "project:test",
          databaseId: "database:test",
          storeEpoch: "epoch:test",
          expectedRevision: 3,
          prefix: "RND",
          operationId: "operation:test",
        },
        runtime,
      ),
    ).rejects.toMatchObject({
      name: "DatabasePageKeyRuntimeError",
      code: "revision_conflict",
    } satisfies Partial<DatabasePageKeyRuntimeError>);
    expect(requestKind).toBe("rename_page_key_prefix");
  });
});
