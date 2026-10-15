import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedPageLifecycleMutationV2,
  pageLifecycleMutationHttpStatusV2,
  pageLifecycleTransportFailureV2,
} from "./page-lifecycle-v2-transport";

const request = {
  operationId: "page-lifecycle-v2-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  clientSessionId: "spoofed-session",
  actor: { kind: "spoofed", userId: "admin" },
  operation: {
    kind: "create_page",
    pageId: "page-1",
    title: "Transport v2",
    nfm: "Body",
    status: "triage",
    dataSourceId: "source-1",
    viewPlacement: { kind: "end" },
    tagOptionIds: ["o_AAAAAAAA"],
    newTagOptions: [{ optionId: "o_AAAAAAAA", name: "Release" }],
    expectedTagsPropertyRevision: 7,
  },
} as const;

describe("Page lifecycle v2 transport binding", () => {
  test("binds Project scope and host identity without changing create intent", () => {
    const result = bindTrustedPageLifecycleMutationV2(request, "project-1", {
      actor: { kind: "electron", webContentsId: 7 },
      clientSessionId: "renderer-7",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      operationId: "page-lifecycle-v2-1",
      projectId: "project-1",
      storeEpoch: "epoch-1",
      clientSessionId: "renderer-7",
      actor: { kind: "electron", webContentsId: 7 },
      operation: {
        kind: "create_page",
        dataSourceId: "source-1",
        tagOptionIds: ["o_AAAAAAAA"],
        newTagOptions: [{ optionId: "o_AAAAAAAA", name: "Release" }],
        expectedTagsPropertyRevision: 7,
      },
    });
    expect(result.value.actor.userId).toBeUndefined();
  });

  test("rejects malformed, cross-Project, and invalid host identity inputs", () => {
    const wrongProject = bindTrustedPageLifecycleMutationV2(request, "project-2", {
      actor: { kind: "http_loopback" },
    });
    expect(wrongProject).toMatchObject({
      ok: false,
      error: {
        code: "invalid_page_lifecycle_request",
        operationId: "page-lifecycle-v2-1",
        pageId: "page-1",
      },
    });

    const malformed = bindTrustedPageLifecycleMutationV2(
      {
        ...request,
        operation: { ...request.operation, tagOptionIds: ["Release"] },
      },
      "project-1",
      { actor: { kind: "http_loopback" } },
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: {
        code: "invalid_page_lifecycle_request",
        operationId: "page-lifecycle-v2-1",
        pageId: "page-1",
      },
    });

    const invalidHost = bindTrustedPageLifecycleMutationV2(request, "project-1", {
      actor: { kind: undefined } as never,
    });
    expect(invalidHost).toMatchObject({
      ok: false,
      error: {
        code: "invalid_page_lifecycle_request",
        operationId: "page-lifecycle-v2-1",
        pageId: "page-1",
      },
    });
  });

  test("preserves lifecycle HTTP and writer-failure semantics", () => {
    expect(
      pageLifecycleMutationHttpStatusV2({
        code: "page_not_found",
        message: "denied",
        retryable: false,
      }),
    ).toBe(404);
    expect(
      pageLifecycleMutationHttpStatusV2({
        code: "data_source_not_found",
        message: "missing",
        retryable: false,
      }),
    ).toBe(404);
    expect(
      pageLifecycleMutationHttpStatusV2({
        code: "operation_id_collision",
        message: "collision",
        retryable: false,
      }),
    ).toBe(409);
    expect(
      pageLifecycleMutationHttpStatusV2({
        code: "tags_property_revision_conflict",
        message: "stale tags schema",
        retryable: false,
        expectedRevision: 4,
        actualRevision: 5,
      }),
    ).toBe(409);

    const bound = bindTrustedPageLifecycleMutationV2(request, "project-1", {
      actor: { kind: "http_loopback" },
    });
    if (!bound.ok) throw new Error(bound.error.message);
    expect(pageLifecycleTransportFailureV2(bound.value, new Error("writer unavailable"))).toEqual({
      ok: false,
      error: {
        code: "unknown",
        message: "writer unavailable",
        retryable: true,
        operationId: "page-lifecycle-v2-1",
        pageId: "page-1",
      },
    });
  });
});
