import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import { useDatabaseViewPresentation } from "./database-view-presentation";
import { commitDatabaseViewOperations } from "./database-view-row-mutations";

vi.mock("./projection-invalidation-service", () => ({
  getRendererProjectionInvalidationRegistry: () => ({ register: () => () => undefined }),
}));

// This hook's identity and read lifecycle need only these projection fields.
const model = (commitSeq: number, databaseViewId = "view"): DatabaseViewRenderModel =>
  ({
    libraryId: "library",
    routingContext: { kind: "library" },
    storeEpoch: "epoch",
    commitSeq,
    databaseId: "database",
    dataSourceId: "source",
    databaseViewId,
    query: { view: { config: {} }, rows: [] },
  }) as unknown as DatabaseViewRenderModel;

test("retains its mounted read owner across reads and replaces it when the View identity changes", () => {
  const initial = model(1);
  const view = renderHook(
    ({ current }) => useDatabaseViewPresentation(current, undefined, commitDatabaseViewOperations),
    {
      initialProps: { current: initial },
    },
  );
  const first = view.result.current.owner;
  expect(first.isActive()).toBe(true);
  const nextRead = model(2);
  view.rerender({ current: nextRead });
  expect(view.result.current.owner).toBe(first);
  expect(view.result.current.model).toBe(nextRead);
  const nextView = model(2, "another-view");
  view.rerender({ current: nextView });
  const second = view.result.current.owner;
  expect(second).not.toBe(first);
  expect(first.isActive()).toBe(false);
  expect(second.isActive()).toBe(true);
  expect(view.result.current.model).toBe(nextView);
  view.unmount();
  expect(second.isActive()).toBe(false);
});
