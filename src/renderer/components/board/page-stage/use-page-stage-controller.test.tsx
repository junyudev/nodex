import { act } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";

import type { DatabasePage, PageInput } from "@/lib/types";
import { projectPageDetailToStageModel, type PageStagePageModel } from "@/lib/page-stage-page";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { settleAsyncRender } from "@/test/dom";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "../../../../shared/block-documents/page-document";
import { plainTextToPortableRichText } from "../../../../shared/block-documents/portable-rich-text";
import {
  usePageStageController,
  type PageStageControllerDependencies,
} from "./use-page-stage-controller";
import type { PageStageProps, PageStageSessionSnapshot } from "./types";
import { buildPageDetailStoryResult } from "./page-stage-story-page-detail";

type PageStageController = ReturnType<typeof usePageStageController>;

function buildPage(overrides: Partial<DatabasePage> = {}): DatabasePage {
  const title = overrides.title ?? "Projected title";
  return {
    id: "page-1",
    status: "build",
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    description: "Projected body",
    tags: [],
    created: new Date("2026-01-01T00:00:00.000Z"),
    order: 1,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
  };
}

function updatedResult(page: DatabasePage, updates: Partial<PageInput>) {
  void page;
  void updates;
  return { status: "updated", didMutate: true } as const;
}

function toStageModel(page: DatabasePage): PageStagePageModel {
  const detail = buildPageDetailStoryResult("project-1", page);
  if (!detail.ok) throw new Error(detail.error.message);
  return projectPageDetailToStageModel(detail.value);
}

function documentAuthority(): PageStageProps["documentAuthority"] {
  return {
    kind: "yjs",
    descriptor: {
      libraryId: "library-1",
      accessContext: { kind: "project", projectId: "project-1" },
      ownerBlockId: "page-1",
      ownerType: "page",
      ownerLifecycle: "active",
      documentId: "document-1",
      authorization: null,
      storeEpoch: "store-epoch-1",
      generation: 1,
      headSeq: 1,
      schemaKey: "nodex.page",
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      readiness: "ready",
      sync: { kind: "yjs", stateVector: new Uint8Array() },
    },
    reload: async () => undefined,
  };
}

function buildProps(overrides: Partial<PageStageProps> = {}): PageStageProps {
  const sourcePage = buildPage();
  const page = overrides.page === undefined ? toStageModel(sourcePage) : overrides.page;
  return {
    page,
    contentAccessContext: { kind: "project", projectId: "project-1" },
    documentAuthority: documentAuthority(),
    onClose: () => undefined,
    onUpdate: async (_pageId, updates) => updatedResult(sourcePage, updates),
    onUpdateProperty: async () => ({ status: "updated", didMutate: true }),
    onDelete: async () => undefined,
    ...overrides,
  };
}

function renderController(
  props: PageStageProps,
  dependencies: PageStageControllerDependencies = {},
) {
  let controller: PageStageController | null = null;
  let renderCount = 0;

  function Harness({ nextProps, children }: { nextProps: PageStageProps; children?: ReactNode }) {
    renderCount += 1;
    controller = usePageStageController(nextProps, dependencies);
    return <>{children}</>;
  }

  const view = render(<Harness nextProps={props} />);
  if (!controller) throw new Error("Expected Page Detail controller to render");

  return {
    view,
    get controller(): PageStageController {
      if (!controller) throw new Error("Expected Page Detail controller");
      return controller;
    },
    get renderCount(): number {
      return renderCount;
    },
    rerender(nextProps: PageStageProps): void {
      view.rerender(<Harness nextProps={nextProps} />);
    },
  };
}

describe("usePageStageController", () => {
  test("does not resynchronize an unchanged metadata revision when command props are recreated", async () => {
    const initialPage = buildPage();
    const result = renderController(
      buildProps({
        page: toStageModel(initialPage),
        onUpdate: async (_pageId, patch) => updatedResult(initialPage, patch),
      }),
    );
    await settleAsyncRender();
    act(() => result.controller.handleDocumentTitleChange("Live collaborative title"));

    const equivalentPage = buildPage();
    await act(async () => {
      result.rerender(
        buildProps({
          page: toStageModel(equivalentPage),
          onUpdate: async (_pageId, patch) => updatedResult(equivalentPage, patch),
        }),
      );
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(result.controller.title).toBe("Live collaborative title");
  });

  test("keeps collaborative title changes out of metadata writes", async () => {
    const updates: Partial<PageInput>[] = [];
    const leftTitles: string[] = [];
    let persisted = 0;
    const result = renderController(
      buildProps({
        onLeavePage: (snapshot) => leftTitles.push(snapshot.titleSnapshot),
        onUpdate: async (_pageId, patch) => {
          updates.push(patch);
          return updatedResult(buildPage(), patch);
        },
      }),
      {
        persistDocument: async () => {
          persisted += 1;
        },
      },
    );
    await settleAsyncRender();

    act(() => result.controller.handleDocumentTitleChange("Live Y.Text title"));
    await act(async () => result.controller.handleClose());

    expect(persisted).toBe(1);
    expect(updates.length).toBe(0);
    expect(leftTitles.join(",")).toBe("Live Y.Text title");
  });

  test("does not publish a Project session snapshot for Library authority", async () => {
    const snapshots: PageStageSessionSnapshot[] = [];
    const result = renderController(
      buildProps({
        contentAccessContext: { kind: "library" },
        onLeavePage: (snapshot) => snapshots.push(snapshot),
      }),
    );
    await settleAsyncRender();

    await act(async () => result.controller.handleClose());

    expect(snapshots).toEqual([]);
  });

  test("commits a generic Property edit without writing whole-page metadata", async () => {
    const updates: Partial<PageInput>[] = [];
    const propertyUpdates: Array<{ propertyId: string; value: unknown }> = [];
    const result = renderController(
      buildProps({
        onUpdate: async (_pageId, patch) => {
          updates.push(patch);
          return updatedResult(buildPage(), patch);
        },
        onUpdateProperty: async (_pageId, propertyId, edit) => {
          propertyUpdates.push({
            propertyId,
            value: edit.kind === "replace" ? edit.value : edit,
          });
          return { status: "updated", didMutate: true };
        },
      }),
    );
    await settleAsyncRender();

    const assignee = result.controller.propertyControls.properties.find(
      (item) => item.property.propertyId === "assignee",
    );
    if (!assignee) throw new Error("Expected Assignee Property");
    await act(async () => {
      await result.controller.propertyControls.edit(assignee, {
        kind: "replace",
        value: "alex",
        expectedValueRevision: assignee.valueRevision,
      });
    });

    expect(propertyUpdates).toEqual([{ propertyId: "assignee", value: "alex" }]);
    expect(updates).toEqual([]);
  });

  test("isolates a Property conflict without exposing a whole-page overwrite", async () => {
    const propertyUpdates: string[] = [];
    const result = renderController(
      buildProps({
        onUpdateProperty: async (_pageId, propertyId) => {
          propertyUpdates.push(propertyId);
          return {
            status: "conflict",
            error: "Property changed elsewhere",
          };
        },
      }),
    );
    await settleAsyncRender();

    const priority = result.controller.propertyControls.properties.find(
      (item) => item.property.propertyId === "priority",
    );
    if (!priority) throw new Error("Expected Priority Property");
    await act(async () => {
      await result.controller.propertyControls.edit(priority, {
        kind: "replace",
        value: "p1-high",
        expectedValueRevision: priority.valueRevision,
      });
    });

    expect(propertyUpdates).toEqual(["priority"]);
    expect(result.controller.propertyControls.errors.priority).toBe(
      "Value changed elsewhere. Review and try again.",
    );
    expect("handleOverwriteMine" in result.controller).toBe(false);
  });

  test("keeps committed Property edits separate while flushing the Document on close", async () => {
    const propertyUpdates: string[] = [];
    let persisted = 0;
    const result = renderController(
      buildProps({
        onUpdateProperty: async (_pageId, propertyId) => {
          propertyUpdates.push(propertyId);
          return { status: "updated", didMutate: true };
        },
      }),
      {
        persistDocument: async () => {
          persisted += 1;
        },
      },
    );
    await settleAsyncRender();

    const assignee = result.controller.propertyControls.properties.find(
      (item) => item.property.propertyId === "assignee",
    );
    if (!assignee) throw new Error("Expected Assignee Property");
    await act(async () => {
      await result.controller.propertyControls.edit(assignee, {
        kind: "replace",
        value: "alex",
        expectedValueRevision: assignee.valueRevision,
      });
    });
    await act(async () => result.controller.handleClose());

    expect(persisted).toBe(1);
    expect(propertyUpdates).toEqual(["assignee"]);
  });
});
