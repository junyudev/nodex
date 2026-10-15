import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type { PageDetail } from "../../shared/page-detail";
import type { ProjectionStreamMessage } from "../../shared/projection-stream";
import { buildPageDetailFixtureResult } from "@/test/page-detail-fixture";
import { buildPageStageFixturePage } from "@/test/page-stage-fixture";
import { ProjectionInvalidationProvider } from "./projection-invalidation-context";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";

const mocks = vi.hoisted(() => ({
  readPageDetail: vi.fn(),
}));

vi.mock("./api", () => ({
  readPageDetail: mocks.readPageDetail,
}));

import {
  getPageDetail,
  invalidatePageDetail,
  pageDetailStoreDiagnostics,
  resetPageDetailStoreForTests,
  setPageDetail,
  usePageDetail,
} from "./page-detail-store";

const timestamp = "2026-07-22T00:00:00.000Z";

const detail = (title: string, headSeq: number, storeEpoch = "epoch-1"): PageDetail => ({
  projectId: "project-1",
  libraryId: "library-1",
  storeEpoch,
  commitSeq: headSeq,
  page: {
    pageId: "page-1",
    libraryId: "library-1",
    parent: { kind: "library", libraryId: "library-1" },
    lifecycle: "active",
    parentRevision: 1,
    metadataRevision: 1,
    documentId: "document-1",
    documentGeneration: 1,
    documentHeadSeq: headSeq,
    title,
    richTitle: plainTextToPortableRichText(title),
    preview: title,
    plainText: title,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  document: {
    readiness: "ready",
    schemaKey: "nodex.page",
    schemaVersion: 3,
  },
  intrinsicProperties: [],
  dataSourceContext: { kind: "standalone" },
});

const pageEvent = (
  pageId: string,
  headSeq: number,
  storeEpoch = "epoch-1",
  relationalPage?: PageDetail,
): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope: {
    kind: "project",
    libraryId: "library-1",
    projectId: "project-1",
  },
  stream: { storeEpoch, commitSeq: headSeq },
  delivery: {
    storeEpoch,
    commitSeq: headSeq,
    manifestHash: String(headSeq).padStart(64, "b").slice(-64),
    operationId: `operation-${headSeq}`,
    committedAt: "2026-08-06T00:00:00.000Z",
    impact: {
      kind: "resources",
      page_ids: [pageId],
      // Page Document effects carry routing coordinates for every relational
      // projection that contains the Page. Those coordinates are not shared
      // Page Detail dependencies: the exact Page effect scope is authoritative.
      database_ids:
        relationalPage?.dataSourceContext.kind === "member"
          ? [relationalPage.dataSourceContext.database.databaseId]
          : [],
      data_source_ids:
        relationalPage?.dataSourceContext.kind === "member"
          ? [relationalPage.dataSourceContext.dataSource.dataSourceId]
          : [],
      view_ids:
        relationalPage?.dataSourceContext.kind === "member" &&
        relationalPage.dataSourceContext.database.defaultViewId
          ? [relationalPage.dataSourceContext.database.defaultViewId]
          : [],
      document_heads: [
        {
          page_id: pageId,
          document_id: pageId === "page-1" ? "document-1" : `document:${pageId}`,
          generation: 1,
          head_seq: headSeq,
        },
      ],
    },
    effect: {
      scope: {
        schema_version: 1,
        canonical_key: `scope:${pageId}`,
        scope: {
          kind: "page",
          project_id: "project-1",
          page_id: pageId,
        },
      },
      baseRevision: Math.max(0, headSeq - 1),
      resultRevision: headSeq,
      coveredCommitSeq: headSeq,
      patch: { kind: "page_changed", projectId: "project-1", pageId },
      requiresReadAtLeast: true,
      effectHash: String(headSeq).padStart(64, "a").slice(-64),
    },
  },
});

const databaseViewEvent = (page: PageDetail, commitSeq: number): ProjectionStreamMessage => {
  if (page.dataSourceContext.kind !== "member") {
    throw new Error("Expected member Page Detail fixture");
  }
  const dataSourceId = page.dataSourceContext.dataSource.dataSourceId;
  const databaseId = page.dataSourceContext.database.databaseId;
  const viewId = page.dataSourceContext.database.defaultViewId;
  if (!viewId) throw new Error("Expected member Page Detail View fixture");
  return {
    version: 2,
    kind: "effect",
    scope: {
      kind: "project",
      libraryId: page.libraryId,
      projectId: page.projectId,
    },
    stream: { storeEpoch: page.storeEpoch, commitSeq },
    delivery: {
      storeEpoch: page.storeEpoch,
      commitSeq,
      manifestHash: String(commitSeq).padStart(64, "b").slice(-64),
      operationId: `operation-view-${commitSeq}`,
      committedAt: "2026-08-06T00:00:00.000Z",
      impact: {
        kind: "resources",
        page_ids: [page.page.pageId],
        database_ids: [databaseId],
        data_source_ids: [dataSourceId],
        view_ids: [viewId],
        document_heads: [],
      },
      effect: {
        scope: {
          schema_version: 1,
          canonical_key: `database-view:${page.projectId}:${viewId}`,
          scope: {
            kind: "database_view",
            project_id: page.projectId,
            database_id: databaseId,
            data_source_id: dataSourceId,
            view_id: viewId,
          },
        },
        baseRevision: commitSeq - 1,
        resultRevision: commitSeq,
        coveredCommitSeq: commitSeq,
        patch: null,
        requiresReadAtLeast: true,
        effectHash: String(commitSeq).padStart(64, "c").slice(-64),
      },
    },
  };
};

const memberDetail = (pageId: string, title: string, commitSeq: number): PageDetail => {
  const page = buildPageStageFixturePage();
  const result = buildPageDetailFixtureResult(
    "project-1",
    {
      ...page,
      id: pageId,
      title,
      richTitle: plainTextToPortableRichText(title),
    },
    {
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    ...result.value,
    page: {
      ...result.value.page,
      documentHeadSeq: commitSeq,
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("Page Detail store realtime convergence", () => {
  let projectionListener: ((message: ProjectionStreamMessage) => void) | null;
  let latestMessage: ProjectionStreamMessage | null;
  let projectionRegistry: ProjectionInvalidationRegistry;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ProjectionInvalidationProvider registry={projectionRegistry}>
      {children}
    </ProjectionInvalidationProvider>
  );
  const publish = (message: ProjectionStreamMessage) => {
    latestMessage = message;
    projectionListener?.(message);
  };

  beforeEach(() => {
    resetPageDetailStoreForTests();
    mocks.readPageDetail.mockReset();
    projectionListener = null;
    latestMessage = null;
    projectionRegistry = new ProjectionInvalidationRegistry({
      subscribeProjection: (scope, listener) => {
        projectionListener = listener;
        if (latestMessage) {
          listener({
            version: 2,
            kind: "checkpoint",
            scope,
            stream: latestMessage.stream,
          });
        }
        return () => {
          if (projectionListener === listener) projectionListener = null;
        };
      },
    });
  });

  test("isolates opaque Project and Page identities that share delimiter text", () => {
    const first = {
      ...detail("First", 1),
      projectId: "project:a",
      page: { ...detail("First", 1).page, pageId: "page" },
    };
    const second = {
      ...detail("Second", 1),
      projectId: "project",
      page: { ...detail("Second", 1).page, pageId: "a:page" },
    };

    setPageDetail(first);
    setPageDetail(second);
    invalidatePageDetail(first.projectId, first.page.pageId);

    expect(getPageDetail(first.projectId, first.page.pageId)).toBe(null);
    expect(getPageDetail(second.projectId, second.page.pageId)?.page.title).toBe("Second");
  });

  test("bounds inactive Page Detail entries across 10k-key churn", () => {
    const template = detail("Bounded", 1);
    for (let index = 0; index < 10_000; index += 1) {
      setPageDetail({
        ...template,
        page: {
          ...template.page,
          pageId: `page-${index}`,
          documentId: `document-${index}`,
        },
      });
    }

    expect(pageDetailStoreDiagnostics()).toMatchObject({
      entries: 128,
      inFlight: 0,
      projectionRegistrations: 0,
    });
  });

  test("rereads only the matching Page after its Document head advances", async () => {
    mocks.readPageDetail
      .mockResolvedValueOnce({ ok: true, value: detail("Before", 1) })
      .mockResolvedValueOnce({ ok: true, value: detail("After", 2) });
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.detail?.page.title).toBe("Before"));

    await act(async () => {
      publish(pageEvent("another-page", 2));
      await Promise.resolve();
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      publish(pageEvent("page-1", 2));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.detail?.page.title).toBe("After"));
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(2);
  });

  test("performs a trailing reread when invalidated during an in-flight read", async () => {
    const firstRead = deferred<{ ok: true; value: PageDetail }>();
    mocks.readPageDetail
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce({ ok: true, value: detail("Latest", 2) });
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });

    await act(async () => {
      publish(pageEvent("page-1", 2));
      firstRead.resolve({ ok: true, value: detail("Stale", 1) });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.detail?.page.title).toBe("Latest"));
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(2);
    expect(mocks.readPageDetail).toHaveBeenNthCalledWith(2, "project-1", "page-1", 2);
  });

  test("does not refetch when the initial checkpoint is covered by an in-flight read", async () => {
    const firstRead = deferred<{ ok: true; value: PageDetail }>();
    mocks.readPageDetail.mockReturnValueOnce(firstRead.promise);
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });

    await act(async () => {
      publish({
        version: 2,
        kind: "checkpoint",
        scope: {
          kind: "project",
          libraryId: "library-1",
          projectId: "project-1",
        },
        stream: { storeEpoch: "epoch-1", commitSeq: 2 },
      });
      firstRead.resolve({ ok: true, value: detail("Already current", 2) });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.detail?.page.title).toBe("Already current");
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(1);
  });

  test("performs a trailing minimum-commit read when a checkpoint outruns the in-flight read", async () => {
    const firstRead = deferred<{ ok: true; value: PageDetail }>();
    mocks.readPageDetail
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce({ ok: true, value: detail("Latest", 2) });
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });

    await act(async () => {
      publish({
        version: 2,
        kind: "checkpoint",
        scope: {
          kind: "project",
          libraryId: "library-1",
          projectId: "project-1",
        },
        stream: { storeEpoch: "epoch-1", commitSeq: 2 },
      });
      firstRead.resolve({ ok: true, value: detail("Stale", 1) });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.detail?.page.title).toBe("Latest");
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(2);
  });

  test("does not reread when an in-flight canonical snapshot covers the impact", async () => {
    const firstRead = deferred<{ ok: true; value: PageDetail }>();
    mocks.readPageDetail.mockReturnValueOnce(firstRead.promise);
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });

    await act(async () => {
      publish(pageEvent("page-1", 2));
      firstRead.resolve({ ok: true, value: detail("Already current", 2) });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.detail?.page.title).toBe("Already current");
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(1);
  });

  test("accepts a lower Document head after the Store epoch changes", async () => {
    mocks.readPageDetail
      .mockResolvedValueOnce({ ok: true, value: detail("Before restore", 8) })
      .mockResolvedValueOnce({
        ok: true,
        value: detail("Restored Store", 1, "epoch-2"),
      });
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.detail?.page.title).toBe("Before restore");
    });

    await act(async () => {
      publish(pageEvent("page-1", 1, "epoch-2"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.detail?.page.title).toBe("Restored Store");
    });
    expect(result.current.detail?.storeEpoch).toBe("epoch-2");
  });

  test("keeps its stable scope while a Page is missing and converges after restore", async () => {
    mocks.readPageDetail
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "page_not_found", message: "Page not found" },
      })
      .mockResolvedValueOnce({ ok: true, value: detail("Restored", 2) });
    const { result } = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.error).toBe("Page not found"));

    await act(async () => {
      publish(pageEvent("page-1", 2));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.detail?.page.title).toBe("Restored"));
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(2);
  });

  test("retains a Page across surface remounts without serving it past an effect", async () => {
    mocks.readPageDetail.mockResolvedValueOnce({ ok: true, value: detail("Open", 1) });
    const { result, unmount } = renderHook(
      () => usePageDetail("library-1", "project-1", "page-1"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail?.page.title).toBe("Open"));

    unmount();
    expect(getPageDetail("project-1", "page-1")?.page.title).toBe("Open");

    const remounted = renderHook(() => usePageDetail("library-1", "project-1", "page-1"), {
      wrapper,
    });
    expect(remounted.result.current.detail?.page.title).toBe("Open");
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(1);
    remounted.unmount();

    await act(async () => {
      publish(pageEvent("page-1", 2));
      await Promise.resolve();
    });

    expect(getPageDetail("project-1", "page-1")).toBe(null);
  });

  test("retains cached sibling Page Details after another row changes in the same Data Source", async () => {
    const pageA = memberDetail("page-a", "Page A", 1);
    const pageB = memberDetail("page-b", "Page B", 1);
    const pageC = memberDetail("page-c", "Page C", 1);
    const pageCEdited = memberDetail("page-c", "Page C edited", 2);
    mocks.readPageDetail
      .mockResolvedValueOnce({ ok: true, value: pageA })
      .mockResolvedValueOnce({ ok: true, value: pageB })
      .mockResolvedValueOnce({ ok: true, value: pageC })
      .mockResolvedValueOnce({
        ok: true,
        value: pageCEdited,
      });

    const mountedA = renderHook(() => usePageDetail("library-1", "project-1", "page-a"), {
      wrapper,
    });
    await waitFor(() => expect(mountedA.result.current.detail?.page.title).toBe("Page A"));
    mountedA.unmount();

    const mountedB = renderHook(() => usePageDetail("library-1", "project-1", "page-b"), {
      wrapper,
    });
    await waitFor(() => expect(mountedB.result.current.detail?.page.title).toBe("Page B"));
    mountedB.unmount();

    const mountedC = renderHook(() => usePageDetail("library-1", "project-1", "page-c"), {
      wrapper,
    });
    await waitFor(() => expect(mountedC.result.current.detail?.page.title).toBe("Page C"));

    await act(async () => {
      publish(pageEvent("page-c", 2, "epoch-1", pageCEdited));
      publish(databaseViewEvent(pageCEdited, 2));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mountedC.result.current.detail?.page.title).toBe("Page C edited");
    });

    const remountedA = renderHook(() => usePageDetail("library-1", "project-1", "page-a"), {
      wrapper,
    });
    expect(remountedA.result.current).toMatchObject({
      detail: { page: { title: "Page A" } },
      loading: false,
      error: null,
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(4);
    remountedA.unmount();

    const remountedB = renderHook(() => usePageDetail("library-1", "project-1", "page-b"), {
      wrapper,
    });
    expect(remountedB.result.current).toMatchObject({
      detail: { page: { title: "Page B" } },
      loading: false,
      error: null,
    });
    expect(mocks.readPageDetail).toHaveBeenCalledTimes(4);
    remountedB.unmount();
    mountedC.unmount();
  });

  test("releases authority when an invalidated active Page is later unmounted", async () => {
    mocks.readPageDetail.mockResolvedValueOnce({ ok: true, value: detail("Open", 1) });
    const { result, unmount } = renderHook(
      () => usePageDetail("library-1", "project-1", "page-1"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail?.page.title).toBe("Open"));

    act(() => invalidatePageDetail("project-1", "page-1"));
    expect(projectionListener).not.toBe(null);
    unmount();

    expect(projectionListener).toBe(null);
  });
});
