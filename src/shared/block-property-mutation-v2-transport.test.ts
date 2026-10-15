import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedBlockPropertyMutationV2,
  bindTrustedLibraryBlockPropertyMutationV2,
  blockPropertyMutationHttpStatusV2,
  blockPropertyMutationTransportFailureV2,
} from "./block-property-mutation-v2-transport";
import { parseLibraryBlockPropertyMutationCommandResultV2 } from "./block-property-mutations-v2";
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
