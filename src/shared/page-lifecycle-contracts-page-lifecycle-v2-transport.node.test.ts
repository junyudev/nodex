import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedPageLifecycleMutationV2,
  pageLifecycleMutationHttpStatusV2,
  pageLifecycleTransportFailureV2,
} from "./page-lifecycle-v2-transport";
import {
  canonicalizePageLifecycleMutationRequestV2,
  parsePageLifecycleMutationCommandResultV2,
  parsePageLifecycleMutationRequestV2,
  parsePageLifecycleMutationReceiptV2,
  PageLifecycleV2ContractError,
} from "./page-lifecycle-v2";
import {
  compilePageLifecycleCreateRequestV2,
  type PageLifecycleCreateDisplayIntent,
} from "./page-lifecycle-v2-runtime";
import { committedLocalCommit } from "./testing/local-commit";

describe("page lifecycle v2 transport", () => {
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
      markdown: "Body",
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
      expect(pageLifecycleTransportFailureV2(bound.value, new Error("writer unavailable"))).toEqual(
        {
          ok: false,
          error: {
            code: "unknown",
            message: "writer unavailable",
            retryable: true,
            operationId: "page-lifecycle-v2-1",
            pageId: "page-1",
          },
        },
      );
    });
  });
});

describe("page lifecycle v2", () => {
  const v2Request = () => ({
    operationId: "operation-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "session-1",
    actor: { kind: "test", ignoredForIdentity: true },
    operation: {
      kind: "create_page",
      pageId: "page-1",
      title: "Ship v2",
      markdown: "Body",
      status: "triage",
      viewPlacement: { kind: "start" },
      priority: "p1-high",
      estimate: "m",
      dueDate: "2026-07-31",
      scheduledStart: null,
      scheduledEnd: null,
      isAllDay: false,
      recurrence: null,
      reminders: [],
      scheduleTimezone: null,
      assignee: null,
      runInTarget: "localProject",
      runInLocalPath: null,
      runInBaseBranch: null,
      runInWorktreePath: null,
      runInEnvironmentPath: null,
      dataSourceId: "source-1",
      tagOptionIds: ["o_BBBBBBBB", "o_AAAAAAAA"],
      newTagOptions: [{ optionId: "o_BBBBBBBB", name: "  Cafe\u0301  " }],
      expectedTagsPropertyRevision: 9,
    },
  });

  const createDisplayIntent = (): PageLifecycleCreateDisplayIntent => ({
    operationId: "operation-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "session-1",
    actor: { kind: "test" },
    operation: {
      kind: "create_page",
      pageId: "page-1",
      title: "Ship v2",
      markdown: "Body",
      status: "triage",
      priority: "p1-high",
      estimate: "m",
      tagOptions: [
        { optionId: "o_BBBBBBBB", name: "  Cafe\u0301  " },
        { optionId: "o_AAAAAAAA", name: "release" },
        { optionId: "o_AAAAAAAA", name: "release" },
      ],
      dueDate: "2026-07-31",
      viewPlacement: { kind: "before", pageId: "page-before" },
    },
  });

  describe("Page Lifecycle v2 contract", () => {
    test("parses an authority-ready create request and preserves create fields", () => {
      const parsed = parsePageLifecycleMutationRequestV2(v2Request());

      expect(parsed).toMatchObject({
        operationId: "operation-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        clientSessionId: "session-1",
        actor: { kind: "test", ignoredForIdentity: true },
        operation: {
          kind: "create_page",
          pageId: "page-1",
          title: "Ship v2",
          markdown: "Body",
          status: "triage",
          priority: "p1-high",
          estimate: "m",
          dueDate: "2026-07-31",
          dataSourceId: "source-1",
          tagOptionIds: ["o_AAAAAAAA", "o_BBBBBBBB"],
          newTagOptions: [{ optionId: "o_BBBBBBBB", name: "Café" }],
          expectedTagsPropertyRevision: 9,
        },
      });
      expect("tags" in parsed.operation).toBe(false);
    });

    test("canonicalizes set-like option fields and excludes audit attribution", () => {
      const first = v2Request();
      const second = {
        ...v2Request(),
        clientSessionId: "another-session",
        actor: { kind: "retry" },
        operation: {
          ...v2Request().operation,
          tagOptionIds: ["o_AAAAAAAA", "o_BBBBBBBB"],
        },
      };

      expect(canonicalizePageLifecycleMutationRequestV2(first)).toBe(
        canonicalizePageLifecycleMutationRequestV2(second),
      );
    });

    test("rejects ambiguous or non-identity tag payloads", () => {
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: { ...v2Request().operation, tags: ["release"] },
        }),
      ).toThrow("unsupported fields: tags");
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: {
            ...v2Request().operation,
            tagOptionIds: ["release"],
            newTagOptions: [],
          },
        }),
      ).toThrow("optionId is not valid");
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: {
            ...v2Request().operation,
            tagOptionIds: ["o_AAAAAAAA"],
            newTagOptions: [{ optionId: "o_BBBBBBBB", name: "Café" }],
          },
        }),
      ).toThrow("must also appear in tagOptionIds");
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: {
            ...v2Request().operation,
            tagOptionIds: ["o_AAAAAAAA", "o_BBBBBBBB"],
            newTagOptions: [
              { optionId: "o_AAAAAAAA", name: "Release" },
              { optionId: "o_BBBBBBBB", name: " Release " },
            ],
          },
        }),
      ).toThrow("repeats a canonical tag name");
    });

    test("rejects unknown request fields and invalid revisions", () => {
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          unexpected: true,
        }),
      ).toThrow("unsupported fields: unexpected");
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: {
            ...v2Request().operation,
            expectedTagsPropertyRevision: -1,
          },
        }),
      ).toThrow("non-negative safe integer");
      const operationWithoutPlacement: Record<string, unknown> = {
        ...v2Request().operation,
      };
      delete operationWithoutPlacement.viewPlacement;
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: operationWithoutPlacement,
        }),
      ).toThrow("missing required fields: viewPlacement");
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: {
            ...v2Request().operation,
            beforeViewPageId: "page-anchor",
          },
        }),
      ).toThrow("unsupported fields: beforeViewPageId");
    });

    test("keeps non-create operation shapes under the v2 envelope", () => {
      const parsed = parsePageLifecycleMutationRequestV2({
        operationId: "archive-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        actor: { kind: "test" },
        operation: {
          kind: "archive_page",
          pageId: "page-1",
          expectedMetadataRevision: 7,
        },
      });

      expect(parsed).toMatchObject({
        operation: {
          kind: "archive_page",
          pageId: "page-1",
          expectedMetadataRevision: 7,
        },
      });
    });

    test("parses v2 receipts with exact-retry tag allocation evidence", () => {
      const receipt = {
        operationId: "operation-1",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        operationKind: "create_page",
        pageId: "page-1",
        duplicate: false,
        metadataRevision: 1,
        parentRevision: 1,
        lifecycle: "active",
        documentId: "document-1",
        documentGeneration: 1,
        documentHeadSeq: 1,
        databaseId: "database-1",
        dataSourceId: "source-1",
        membershipId: "membership-1",
        viewId: "view-1",
        libraryRankKey: null,
        viewRankKey: "7fffffffffffffffffffffffffffffff",
        createdBlockIds: ["page-1", "document-1"],
        createdTagOptionIds: ["o_AAAAAAAA"],
        commitSeq: 1,
        committedAt: "2026-07-18T00:00:00.000Z",
      };

      expect(parsePageLifecycleMutationReceiptV2(receipt)).toMatchObject({
        dataSourceId: "source-1",
        createdTagOptionIds: ["o_AAAAAAAA"],
      });
      expect(
        parsePageLifecycleMutationCommandResultV2({
          ok: true,
          value: receipt,
          localCommit: committedLocalCommit("epoch-1", 1),
        }),
      ).toMatchObject({
        ok: true,
        value: { operationId: "operation-1" },
        localCommit: { status: "committed", commit: { commit_seq: 1 } },
      });
    });

    test("strictly distinguishes v2 Source and tag conflicts", () => {
      expect(
        parsePageLifecycleMutationCommandResultV2({
          ok: false,
          error: {
            code: "tags_property_revision_conflict",
            message: "Tags changed",
            retryable: false,
            operationId: "operation-1",
            pageId: "page-1",
            expectedRevision: 4,
            actualRevision: 5,
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "tags_property_revision_conflict" },
      });
      expect(() =>
        parsePageLifecycleMutationCommandResultV2({
          ok: false,
          error: {
            code: "primary_database_not_found",
            message: "Legacy coordinate",
            retryable: false,
          },
        }),
      ).toThrow("code is invalid");
    });
  });

  describe("Page Lifecycle v2 compiler", () => {
    test("preserves one existing option identity and accepts a preallocated new option", () => {
      const compiled = compilePageLifecycleCreateRequestV2({
        request: createDisplayIntent(),
        tagsProperty: {
          propertyId: "tags",
          dataSourceId: "source-1",
          valueType: "multi_select",
          lifecycle: "active",
          revision: 12,
          config: {
            options: [{ id: "o_AAAAAAAA", name: "release" }],
          },
        },
      });

      expect(compiled.operation).toMatchObject({
        dataSourceId: "source-1",
        tagOptionIds: ["o_AAAAAAAA", "o_BBBBBBBB"],
        newTagOptions: [{ optionId: "o_BBBBBBBB", name: "Café" }],
        expectedTagsPropertyRevision: 12,
        priority: "p1-high",
        estimate: "m",
        dueDate: "2026-07-31",
        viewPlacement: { kind: "before", pageId: "page-before" },
      });
      expect("tags" in compiled.operation).toBe(false);
    });

    test("keeps canonical tag names case-sensitive", () => {
      const base = createDisplayIntent();
      const request: PageLifecycleCreateDisplayIntent = {
        ...base,
        operation: {
          ...base.operation,
          tagOptions: [
            { optionId: "o_AAAAAAAA", name: "UI" },
            { optionId: "o_BBBBBBBB", name: "ui" },
          ],
        },
      };
      const compiled = compilePageLifecycleCreateRequestV2({
        request,
        tagsProperty: {
          propertyId: "tags",
          dataSourceId: "source-1",
          valueType: "multi_select",
          lifecycle: "active",
          revision: 2,
          config: { options: [{ id: "o_AAAAAAAA", name: "UI" }] },
        },
      });

      expect(compiled.operation).toMatchObject({
        tagOptionIds: ["o_AAAAAAAA", "o_BBBBBBBB"],
        newTagOptions: [{ optionId: "o_BBBBBBBB", name: "ui" }],
      });
    });

    test("rejects an ambiguous existing canonical name", () => {
      expect(() =>
        compilePageLifecycleCreateRequestV2({
          request: createDisplayIntent(),
          tagsProperty: {
            propertyId: "tags",
            dataSourceId: "source-1",
            valueType: "multi_select",
            lifecycle: "active",
            revision: 1,
            config: {
              options: [
                { id: "o_AAAAAAAA", name: "release" },
                { id: "o_BBBBBBBB", name: " release " },
              ],
            },
          },
        }),
      ).toThrow('repeats canonical option name "release"');
    });

    test("requires the reserved active tags Property and rejects identity substitution", () => {
      expect(() =>
        compilePageLifecycleCreateRequestV2({
          request: createDisplayIntent(),
          tagsProperty: {
            propertyId: "p_abcdefgh",
            dataSourceId: "source-1",
            valueType: "multi_select",
            lifecycle: "active",
            revision: 1,
            config: { options: [] },
          },
        }),
      ).toThrow("reserved tags Property");

      expect(() =>
        compilePageLifecycleCreateRequestV2({
          request: {
            ...createDisplayIntent(),
            operation: {
              ...createDisplayIntent().operation,
              tagOptions: [{ optionId: "o_BBBBBBBB", name: "release" }],
            },
          },
          tagsProperty: {
            propertyId: "tags",
            dataSourceId: "source-1",
            valueType: "multi_select",
            lifecycle: "active",
            revision: 1,
            config: { options: [{ id: "o_AAAAAAAA", name: "release" }] },
          },
        }),
      ).toThrow("already belongs to another option identity");
    });

    test("surfaces v2 contract failures through one error type", () => {
      expect(() =>
        parsePageLifecycleMutationRequestV2({
          ...v2Request(),
          operation: { ...v2Request().operation, status: "unknown" },
        }),
      ).toThrow(PageLifecycleV2ContractError);
    });
  });
});
