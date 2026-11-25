import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedBlockPropertyMutationV2,
  bindTrustedLibraryBlockPropertyMutationV2,
  blockPropertyMutationHttpStatusV2,
  blockPropertyMutationTransportFailureV2,
} from "./block-property-mutation-v2-transport";
import {
  parseLibraryBlockPropertyMutationCommandResultV2,
  BlockPropertyMutationV2ContractError,
  canonicalizeBlockPropertyMutationRequestV2,
  makeBlockPropertyFieldPathV2,
  parseBlockPropertyMutationCommandErrorV2,
  parseBlockPropertyMutationCommandResultV2,
  parseBlockPropertyMutationRequestV2,
  parseBlockPropertyMutationResultV2,
} from "./block-property-mutations-v2";
import { committedLocalCommit } from "./testing/local-commit";
import {
  canonicalizeBlockPropertyMutationRequest,
  makeBlockPropertyFieldPath,
  parseBlockPropertyMutationCommandResult,
  parseBlockPropertyMutationRequest,
  parseBlockPropertyMutationResult,
} from "./block-property-mutations";
import {
  BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS,
  matchBuiltInDataSourceProperty,
} from "./data-source-built-ins";

describe("block property mutation v2 transport", () => {
  const request = {
    mutationId: "mutation-v2-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "spoofed-session",
    actor: { kind: "spoofed", userId: "admin" },
    fields: [
      {
        scope: "intrinsic",
        blockId: "page-1",
        propertyKey: "run.target",
        operation: "set",
        expectedRevision: 1,
        value: "cloud",
      },
    ],
  } as const;

  describe("Block property mutation v2 transport binding", () => {
    test("parses strict Library receipts without a Project coordinate", () => {
      const field = {
        path: "intrinsic/page-1/run.target",
        scope: "intrinsic" as const,
        blockId: "page-1",
        propertyKey: "run.target",
        operation: "set" as const,
        revision: 1,
        value: "cloud",
      };
      const exposed = parseLibraryBlockPropertyMutationCommandResultV2({
        ok: true,
        localCommit: {
          status: "no_op",
          observed: { store_epoch: "epoch-1", commit_head: 3 },
        },
        value: {
          mutationId: "mutation-v2-1",
          routingContext: { kind: "library" },
          storeEpoch: "epoch-1",
          duplicate: false,
          fields: [field],
          blockMetadataRevisions: { "page-1": 2 },
          commitSeq: 3,
          committedAt: "2026-07-18T00:00:00.000Z",
        },
      });
      expect(exposed).toMatchObject({
        ok: true,
        value: { routingContext: { kind: "library" } },
      });
      if (!exposed.ok) throw new Error(exposed.error.message);
      expect("projectId" in exposed.value).toBe(false);
      expect(parseLibraryBlockPropertyMutationCommandResultV2(exposed)).toEqual(exposed);
      expect(() =>
        parseLibraryBlockPropertyMutationCommandResultV2({
          ...exposed,
          value: { ...exposed.value, projectId: "forged" },
        }),
      ).toThrow("projectId");
    });

    test("binds Library mutations without accepting Project scope or attribution", () => {
      const libraryRequest = {
        mutationId: request.mutationId,
        storeEpoch: request.storeEpoch,
        clientSessionId: request.clientSessionId,
        fields: request.fields,
      };
      const result = bindTrustedLibraryBlockPropertyMutationV2(libraryRequest, {
        actor: { kind: "electron", clientId: "renderer-7" },
        clientSessionId: "renderer-7",
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          mutationId: "mutation-v2-1",
          clientSessionId: "renderer-7",
        },
        actor: { kind: "electron", clientId: "renderer-7" },
      });
      if (!result.ok) return;
      expect("projectId" in result.value).toBe(false);
      expect("actor" in result.value).toBe(false);

      expect(
        bindTrustedLibraryBlockPropertyMutationV2(request, {
          actor: { kind: "electron" },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_property_mutation_request" },
      });
    });

    test("binds Project scope and replaces caller-authored attribution", () => {
      const result = bindTrustedBlockPropertyMutationV2(request, "project-1", {
        actor: { kind: "electron", clientId: "renderer-7" },
        clientSessionId: "renderer-7",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        mutationId: "mutation-v2-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        clientSessionId: "renderer-7",
        actor: { kind: "electron", clientId: "renderer-7" },
        fields: [
          {
            scope: "intrinsic",
            blockId: "page-1",
            propertyKey: "run.target",
            operation: "set",
            expectedRevision: 1,
            value: "cloud",
          },
        ],
      });
      expect(result.value.actor.userId).toBeUndefined();
    });

    test("rejects malformed, cross-Project, and invalid host identity inputs", () => {
      const wrongProject = bindTrustedBlockPropertyMutationV2(request, "project-2", {
        actor: { kind: "http_loopback" },
      });
      expect(wrongProject).toMatchObject({
        ok: false,
        error: {
          code: "invalid_property_mutation_request",
          mutationId: "mutation-v2-1",
        },
      });

      const malformed = bindTrustedBlockPropertyMutationV2(
        { ...request, unsupported: true },
        "project-1",
        { actor: { kind: "http_loopback" } },
      );
      expect(malformed).toMatchObject({
        ok: false,
        error: {
          code: "invalid_property_mutation_request",
          mutationId: "mutation-v2-1",
        },
      });

      const invalidHost = bindTrustedBlockPropertyMutationV2(request, "project-1", {
        actor: { kind: undefined } as never,
        clientSessionId: "renderer-7",
      });
      expect(invalidHost).toMatchObject({
        ok: false,
        error: {
          code: "invalid_property_mutation_request",
          mutationId: "mutation-v2-1",
        },
      });
    });

    test("preserves v2 HTTP and writer-failure semantics", () => {
      expect(
        blockPropertyMutationHttpStatusV2({
          code: "block_not_found",
          message: "missing",
          retryable: false,
        }),
      ).toBe(404);
      expect(
        blockPropertyMutationHttpStatusV2({
          code: "property_conflict",
          message: "stale",
          retryable: false,
        }),
      ).toBe(409);
      expect(
        blockPropertyMutationHttpStatusV2({
          code: "property_type_mismatch",
          message: "wrong type",
          retryable: false,
        }),
      ).toBe(400);

      const bound = bindTrustedBlockPropertyMutationV2(request, "project-1", {
        actor: { kind: "http_loopback" },
      });
      if (!bound.ok) throw new Error(bound.error.message);
      expect(
        blockPropertyMutationTransportFailureV2(bound.value, new Error("writer unavailable")),
      ).toEqual({
        ok: false,
        error: {
          code: "unknown",
          message: "writer unavailable",
          retryable: true,
          mutationId: "mutation-v2-1",
        },
      });
    });
  });
});

describe("block property mutations v2", () => {
  const baseRequest = {
    mutationId: "mutation-v2",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "session-1",
    actor: { type: "agent", nested: { b: 2, a: 1 } },
  };

  const intrinsicField = {
    scope: "intrinsic" as const,
    blockId: "page / one",
    propertyKey: "run.baseBranch",
    operation: "set" as const,
    expectedRevision: 4,
    value: { b: true, a: [1, 2] },
  };

  describe("Block Property mutation v2 contract", () => {
    test("is additive and leaves the executable v1 version unchanged", () => {});

    test("canonicalizes intrinsic fields deterministically", () => {
      const secondField = {
        ...intrinsicField,
        propertyKey: "run.target",
        value: "cloud",
      };
      const left = {
        ...baseRequest,
        fields: [secondField, intrinsicField],
      };
      const right = {
        ...baseRequest,
        actor: { nested: { a: 1, b: 2 }, type: "agent" },
        fields: [intrinsicField, secondField],
      };

      const parsed = parseBlockPropertyMutationRequestV2(left);
      expect(makeBlockPropertyFieldPathV2(parsed.fields[0]!)).toMatch(/^intrinsic\//u);
      expect(canonicalizeBlockPropertyMutationRequestV2(left)).toBe(
        canonicalizeBlockPropertyMutationRequestV2(right),
      );
      expect(parsed.fields.map(makeBlockPropertyFieldPathV2)).toEqual(
        [...parsed.fields].map(makeBlockPropertyFieldPathV2).sort(),
      );
    });

    test("rejects retired Data Source and v1 coordinates", () => {
      expect(() =>
        parseBlockPropertyMutationRequestV2({
          ...baseRequest,
          fields: [
            {
              scope: "data_source",
              pageId: "page-1",
              dataSourceId: "source-1",
              propertyId: "status",
              operation: "set",
              expectedRevision: 1,
              value: "triage",
            },
          ],
        }),
      ).toThrow(BlockPropertyMutationV2ContractError);
      expect(() =>
        parseBlockPropertyMutationRequestV2({
          ...baseRequest,
          fields: [{ ...intrinsicField, scope: "database", databaseBlockId: "db-1" }],
        }),
      ).toThrow(BlockPropertyMutationV2ContractError);
    });

    test("rejects duplicate paths", () => {
      expect(() =>
        parseBlockPropertyMutationRequestV2({
          ...baseRequest,
          fields: [intrinsicField, intrinsicField],
        }),
      ).toThrow(/duplicate property path/u);
    });

    test("strictly validates intrinsic committed results", () => {
      const value = {
        mutationId: "mutation-v2",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        duplicate: false,
        fields: [
          {
            path: "intrinsic/page-1/run.target",
            scope: "intrinsic",
            blockId: "page-1",
            propertyKey: "run.target",
            operation: "set",
            revision: 2,
            value: "cloud",
          },
        ],
        blockMetadataRevisions: { "page-1": 3 },
        commitSeq: 5,
        committedAt: "2026-07-18T00:00:00.000Z",
      };

      const parsed = parseBlockPropertyMutationResultV2(value);
      expect(parsed.fields[0]).toMatchObject({
        scope: "intrinsic",
        propertyKey: "run.target",
      });
      expect(
        parseBlockPropertyMutationCommandResultV2({
          ok: true,
          value,
          localCommit: committedLocalCommit("epoch-1", 5),
        }),
      ).toEqual({
        ok: true,
        value: parsed,
        localCommit: committedLocalCommit("epoch-1", 5),
      });

      expect(() =>
        parseBlockPropertyMutationResultV2({
          ...value,
          fields: [{ ...value.fields[0], propertyKey: undefined }],
        }),
      ).toThrow(/propertyKey/u);
      expect(() =>
        parseBlockPropertyMutationResultV2({
          ...value,
          fields: [{ ...value.fields[0], path: "intrinsic/wrong/run.target" }],
        }),
      ).toThrow(/path does not match/u);
    });

    test("strictly parses v2 errors and requires complete conflict evidence", () => {
      const conflict = {
        code: "property_conflict",
        message: "Property changed",
        retryable: false,
        mutationId: "mutation-v2",
        fieldPath: "intrinsic/page-1/run.target",
        expectedRevision: 1,
        actualRevision: 2,
      };
      expect(parseBlockPropertyMutationCommandErrorV2(conflict)).toEqual(conflict);
      expect(
        parseBlockPropertyMutationCommandResultV2({
          ok: false,
          error: conflict,
        }),
      ).toEqual({ ok: false, error: conflict });
      expect(() =>
        parseBlockPropertyMutationCommandErrorV2({
          ...conflict,
          actualRevision: undefined,
        }),
      ).toThrow(/both revisions/u);
      expect(() =>
        parseBlockPropertyMutationCommandErrorV2({
          code: "database_not_found",
          message: "Old coordinate",
          retryable: false,
        }),
      ).toThrow(/not supported/u);
    });
  });
});

describe("block property mutations", () => {
  const operationFails = (operation: () => void): boolean => {
    try {
      operation();
      return false;
    } catch {
      return true;
    }
  };

  const baseRequest = {
    mutationId: "mutation-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "session-1",
    actor: { type: "agent", nested: { b: 2, a: 1 } },
  };

  describe("Block property mutation contract", () => {
    test("canonicalizes independent fields and set intent deterministically", () => {
      const left = {
        ...baseRequest,
        fields: [
          {
            scope: "database" as const,
            pageId: "card-1",
            databaseBlockId: "database-1",
            propertyId: "tags-1",
            operation: "add_remove" as const,
            add: ["zeta", "alpha", "alpha"],
            remove: ["old", "old"],
          },
          {
            scope: "intrinsic" as const,
            blockId: "card-1",
            propertyKey: "run.baseBranch",
            operation: "set" as const,
            expectedRevision: 4,
            value: { b: true, a: [1, 2] },
          },
        ],
      };
      const right = {
        ...baseRequest,
        actor: { nested: { a: 1, b: 2 }, type: "agent" },
        fields: [
          left.fields[1],
          {
            ...left.fields[0],
            add: ["alpha", "zeta"],
            remove: ["old"],
          },
        ],
      };

      const parsed = parseBlockPropertyMutationRequest(left);
      const setIntent = parsed.fields.find((field) => field.operation === "add_remove");
      expect(setIntent?.operation).toBe("add_remove");
      if (!setIntent || setIntent.operation !== "add_remove") {
        throw new Error("Expected a set intent");
      }
      expect(JSON.stringify(setIntent.add)).toBe(JSON.stringify(["alpha", "zeta"]));
      expect(JSON.stringify(setIntent.remove)).toBe(JSON.stringify(["old"]));
      expect(canonicalizeBlockPropertyMutationRequest(left)).toBe(
        canonicalizeBlockPropertyMutationRequest(right),
      );
      expect(parsed.fields.map(makeBlockPropertyFieldPath).join("|")).toBe(
        [...parsed.fields].map(makeBlockPropertyFieldPath).sort().join("|"),
      );
    });

    test("rejects unknown keys, duplicate paths, invalid JSON, and ambiguous set intent", () => {
      const intrinsic = {
        scope: "intrinsic" as const,
        blockId: "card-1",
        propertyKey: "run.baseBranch",
        operation: "set" as const,
        expectedRevision: 1,
        value: "running",
      };
      expect(
        operationFails(() =>
          parseBlockPropertyMutationRequest({
            ...baseRequest,
            unsupported: true,
            fields: [intrinsic],
          }),
        ),
      ).toBe(true);
      const withoutActor = Object.fromEntries(
        Object.entries(baseRequest).filter(([key]) => key !== "actor"),
      );
      expect(
        operationFails(() =>
          parseBlockPropertyMutationRequest({
            ...withoutActor,
            fields: [intrinsic],
          }),
        ),
      ).toBe(true);
      expect(
        operationFails(() =>
          parseBlockPropertyMutationRequest({
            ...baseRequest,
            fields: [intrinsic, intrinsic],
          }),
        ),
      ).toBe(true);
      expect(
        operationFails(() =>
          parseBlockPropertyMutationRequest({
            ...baseRequest,
            fields: [{ ...intrinsic, value: Number.NaN }],
          }),
        ),
      ).toBe(true);
      expect(
        operationFails(() =>
          parseBlockPropertyMutationRequest({
            ...baseRequest,
            fields: [
              {
                scope: "database",
                pageId: "card-1",
                databaseBlockId: "database-1",
                propertyId: "tags-1",
                operation: "add_remove",
                add: ["same"],
                remove: ["same"],
              },
            ],
          }),
        ),
      ).toBe(true);
    });

    test("strictly validates committed receipts", () => {
      const result = parseBlockPropertyMutationResult({
        mutationId: "mutation-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        duplicate: false,
        fields: [
          {
            path: "intrinsic/card-1/run.baseBranch",
            scope: "intrinsic",
            blockId: "card-1",
            propertyKey: "run.baseBranch",
            operation: "set",
            revision: 2,
            value: "running",
          },
        ],
        blockMetadataRevisions: { "card-1": 3 },
        commitSeq: 5,
        committedAt: "2026-07-11T00:00:00.000Z",
      });
      expect(result.fields[0]?.revision).toBe(2);
      expect(result.blockMetadataRevisions["card-1"]).toBe(3);
      expect(parseBlockPropertyMutationCommandResult({ ok: true, value: result }).ok).toBe(true);
      expect(
        operationFails(() => parseBlockPropertyMutationResult({ ...result, extra: true })),
      ).toBe(true);
    });

    test("preserves JSON keys that would otherwise mutate object prototypes", () => {
      const actor = JSON.parse('{"__proto__":{"kind":"agent"}}') as unknown;
      const parsed = parseBlockPropertyMutationRequest({
        ...baseRequest,
        actor,
        fields: [
          {
            scope: "intrinsic",
            blockId: "card-1",
            propertyKey: "run.baseBranch",
            operation: "set",
            expectedRevision: 1,
            value: "running",
          },
        ],
      });
      expect(Object.hasOwn(parsed.actor, "__proto__")).toBe(true);
      expect(canonicalizeBlockPropertyMutationRequest(parsed).includes("__proto__")).toBe(true);
    });
  });
});

describe("Data Source built-in Property definitions", () => {
  test("matches every reserved Property only with its canonical value type", () => {
    for (const [propertyId, definition] of Object.entries(
      BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS,
    )) {
      expect(
        matchBuiltInDataSourceProperty({
          propertyId,
          valueType: definition.valueType,
        }),
      ).toBe(propertyId);
    }
  });

  test("does not grant built-in semantics to custom or type-corrupt properties", () => {
    expect(
      matchBuiltInDataSourceProperty({
        propertyId: "p_0123abcd",
        valueType: "select",
      }),
    ).toBeNull();
    expect(
      matchBuiltInDataSourceProperty({
        propertyId: "status",
        valueType: "multi_select",
      }),
    ).toBeNull();
  });
});
