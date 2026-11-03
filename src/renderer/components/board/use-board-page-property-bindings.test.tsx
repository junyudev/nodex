import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { DatabaseViewMutationReceipt } from "@/lib/database-view-row-mutations";

const commands = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock("@/lib/database-view-row-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-view-row-mutations")>()),
  commitDatabaseViewOperations: commands.commit,
}));
vi.mock("@/components/database/use-property-option-registries", () => ({
  usePropertyOptionRegistries: () => ({ options: {}, states: {}, hasMore: {}, loadingMore: {} }),
}));

import { useBoardPagePropertyBindings } from "./use-board-page-property-bindings";

const tags: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("tags"),
  dataSourceId: parseDataSourceId("source-1"),
  name: "Tags",
  ...testPropertySemantics("multi_select", 0),
  valueType: "multi_select",
  config: {},
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
};
// Only the query fields consumed by the binding adapter belong to this command double.
const model = {
  dataSourceId: tags.dataSourceId,
  query: {
    properties: [tags],
    view: { config: { presentation: {} } },
    rows: [{ page: { pageId: "page-1", title: "Page" }, values: {} }],
  },
} as unknown as DatabaseViewRenderModel;
const option = { optionId: "o_AAAAAAAA", name: "Feature" };
const mountBindings = (
  onCommitted: (receipt: DatabaseViewMutationReceipt | null) => Promise<void>,
) =>
  renderHook(() =>
    useBoardPagePropertyBindings({
      model,
      projectId: "project-1",
      columnIdByPageId: new Map(),
      onMoveGroupingValue: async () => false,
      onCommitted,
      onOpenRelationPage: () => {},
    }),
  );
const binding = (hook: ReturnType<typeof mountBindings>) =>
  hook.result.current.bindingsByPageId.get("page-1")![0]!;

test("keeps a rejected option creation pending through refresh and preserves its original rejection", async () => {
  let rejectCommit!: (error: unknown) => void;
  let rejectRefresh!: (error: unknown) => void;
  const commit = new Promise<never>((_resolve, reject) => {
    rejectCommit = reject;
  });
  const refresh = new Promise<void>((_resolve, reject) => {
    rejectRefresh = reject;
  });
  commands.commit.mockReturnValueOnce(commit);
  const onCommitted = vi.fn(() => refresh);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const hook = mountBindings(onCommitted);
  const failure = new Error("Revision changed");
  let completion!: Promise<unknown>;
  try {
    await act(async () => {
      completion = Promise.resolve(binding(hook).onCreateOption!(option)).catch(
        (error: unknown) => error,
      );
      await Promise.resolve();
    });
    expect(binding(hook).pending).toBe(true);
    await act(async () => {
      rejectCommit(failure);
      await Promise.resolve();
    });
    await waitFor(() => expect(onCommitted).toHaveBeenCalledExactlyOnceWith(null));
    expect(binding(hook).pending).toBe(true);
    await act(async () => {
      rejectRefresh(new Error("Refresh failed"));
      expect(await completion).toBe(failure);
    });
    expect(binding(hook).pending).toBe(false);
    expect(binding(hook).error).toBe("Couldn’t save this Property. Refresh and try again.");
    expect(report).toHaveBeenCalledTimes(2);
  } finally {
    report.mockRestore();
    hook.unmount();
  }
});
