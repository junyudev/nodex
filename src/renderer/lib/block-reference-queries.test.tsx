import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { PageOwnershipPathsChangedEvent } from "../../shared/page-ownership-path-events";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import { render } from "../test/dom";
import { TestQueryProvider } from "../test/query";
import { usePageOwnershipPathReadModel } from "./block-reference-queries";
import { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";
import { libraryContentRoute, projectContentRoute } from "../../shared/content-routing-context";

const mocks = vi.hoisted(() => ({
  readLibraryModule: vi.fn(),
  resolvePageOwnershipPath: vi.fn(),
  ownershipPathChangeListener: null as ((event: PageOwnershipPathsChangedEvent) => void) | null,
}));

vi.mock("./api", () => ({
  readLibraryModule: mocks.readLibraryModule,
  resolvePageOwnershipPath: mocks.resolvePageOwnershipPath,
  readDatabaseViewReference: vi.fn(),
}));

vi.mock("./renderer-transport", () => ({
  resolveRendererTransport: () => ({
    subscribeBoardChanges: () => () => undefined,
    subscribePageOwnershipPathChanges: (
      _projectId: string,
      listener: (event: PageOwnershipPathsChangedEvent) => void,
    ) => {
      mocks.ownershipPathChangeListener = listener;
      return () => {
        if (mocks.ownershipPathChangeListener === listener) {
          mocks.ownershipPathChangeListener = null;
        }
      };
    },
  }),
}));

function OwnershipPathHarness() {
  const path = usePageOwnershipPathReadModel(projectContentRoute("host-project"), "nested-page");
  return (
    <output>
      {path.data?.status === "available"
        ? path.data.ancestors.map((ancestor) => ancestor.title).join("|")
        : "pending"}
    </output>
  );
}

function LibraryOwnershipPathHarness() {
  const path = usePageOwnershipPathReadModel(libraryContentRoute, "nested-page");
  return <output>{path.data?.status ?? "pending"}</output>;
}

describe("Page reference queries", () => {
  let projectionListeners: Set<(message: ProjectionStreamMessage) => void>;
  let projectionScopes: ProjectionScope[];
  let projectionRegistry: ProjectionInvalidationRegistry;

  beforeEach(() => {
    mocks.readLibraryModule.mockReset();
    mocks.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 0,
        value: { kind: "metadata" },
      },
    });
    mocks.resolvePageOwnershipPath.mockReset();
    mocks.ownershipPathChangeListener = null;
    projectionListeners = new Set();
    projectionScopes = [];
    projectionRegistry = new ProjectionInvalidationRegistry({
      subscribeProjection: (scope, listener) => {
        projectionScopes.push(scope);
        projectionListeners.add(listener);
        return () => projectionListeners.delete(listener);
      },
    });
  });

  test("refreshes the canonical ownership path when an observed Page moves", async () => {
    let parentTitle = "Parent before move";
    mocks.resolvePageOwnershipPath.mockImplementation(async () => ({
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: mocks.resolvePageOwnershipPath.mock.calls.length,
      status: "available",
      targetPageId: "nested-page",
      ancestors: [
        {
          pageId: "parent-page",
          title: parentTitle,
          lifecycle: "active",
        },
      ],
    }));

    const view = render(
      <TestQueryProvider projectionRegistry={projectionRegistry}>
        <OwnershipPathHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByText("Parent before move")).toBeTruthy();
    });
    expect(mocks.resolvePageOwnershipPath).toHaveBeenCalledTimes(1);

    parentTitle = "Parent after move";
    await act(async () => {
      for (const listener of projectionListeners) {
        listener({
          version: 2,
          kind: "effect",
          scope: {
            kind: "project",
            libraryId: "library-1",
            projectId: "host-project",
          },
          stream: { storeEpoch: "epoch-1", commitSeq: 2 },
          delivery: {
            storeEpoch: "epoch-1",
            commitSeq: 2,
            manifestHash: "b".repeat(64),
            operationId: "operation-2",
            committedAt: "2026-08-06T00:00:00.000Z",
            impact: {
              kind: "resources",
              page_ids: ["parent-page"],
              database_ids: [],
              data_source_ids: [],
              view_ids: [],
              document_heads: [],
            },
            effect: {
              scope: {
                schema_version: 1,
                canonical_key: "scope:parent-page",
                scope: {
                  kind: "page",
                  project_id: "host-project",
                  page_id: "parent-page",
                },
              },
              baseRevision: 1,
              resultRevision: 2,
              coveredCommitSeq: 2,
              patch: {
                kind: "page_changed",
                projectId: "host-project",
                pageId: "parent-page",
              },
              requiresReadAtLeast: true,
              effectHash: "a".repeat(64),
            },
          },
        });
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByText("Parent after move")).toBeTruthy();
    });
    expect(mocks.resolvePageOwnershipPath).toHaveBeenCalledTimes(2);

    parentTitle = "Parent after coarse invalidation";
    await act(async () => {
      mocks.ownershipPathChangeListener?.({
        libraryId: "library-1",
        changeKind: "access",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByText("Parent after coarse invalidation")).toBeTruthy();
    });
    expect(mocks.resolvePageOwnershipPath).toHaveBeenCalledTimes(3);
  });

  test("keeps Library ownership reads on Library authority", async () => {
    mocks.resolvePageOwnershipPath.mockResolvedValue({
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 1,
      status: "available",
      targetPageId: "nested-page",
      ancestors: [],
    });

    const view = render(
      <TestQueryProvider projectionRegistry={projectionRegistry}>
        <LibraryOwnershipPathHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByText("available")).toBeTruthy();
    });
    expect(mocks.resolvePageOwnershipPath).toHaveBeenCalledWith({
      routingContext: { kind: "library" },
      targetPageId: "nested-page",
    });
    expect(projectionScopes).toContainEqual({
      kind: "library",
      libraryId: "library-1",
    });
    expect(mocks.ownershipPathChangeListener).toBeNull();
  });
});
