import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import { projectContentAccess } from "../../../../shared/content-access-context";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import type { PageStagePageModel } from "@/lib/page-stage-page";
import { readPageStageSemanticProperties } from "@/lib/page-stage-properties";
import { usePageStageProperties } from "./use-page-stage-properties";

const optionRuntime = vi.hoisted(() => ({ readWindow: vi.fn() }));
vi.mock("@/lib/database-property-options-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-property-options-runtime")>()),
  readPropertyOptionWindow: optionRuntime.readWindow,
}));

const tagsProperty: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("tags"),
  dataSourceId: parseDataSourceId("source-1"),
  name: "Tags",
  ...testPropertySemantics("multi_select", 2),
  valueType: "multi_select",
  config: {},
  optionCount: 2,
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const tagsItem = {
  property: tagsProperty,
  value: ["o_AAAAAAAA", "o_BBBBBBBB"],
  valueRevision: 1,
  error: null,
  pageVisibility: "always_show",
} as const;

const statusProperty: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("status"),
  dataSourceId: parseDataSourceId("source-1"),
  name: "Status",
  ...testPropertySemantics("select", 3),
  valueType: "select",
  config: {},
  optionCount: 3,
  rankKey: "0",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const statusItem = {
  property: statusProperty,
  value: "plan",
  valueRevision: 4,
  error: null,
  pageVisibility: "always_show",
} as const;

const pageModel: PageStagePageModel = {
  page: {
    id: "page-1",
    pageKey: null,
    archived: false,
    title: "Page",
    richTitle: [],
    isAllDay: false,
    reminders: [],
    revision: 1,
    created: new Date("2026-08-12T00:00:00.000Z"),
  },
  databaseContext: {
    kind: "member",
    membership: {
      id: "membership-1",
      dataSourceId: "source-1",
      databaseId: "database-1",
      revision: 1,
    },
    properties: [tagsItem],
    semanticProperties: readPageStageSemanticProperties([tagsItem]),
    pageLayout: {
      dataSourceId: parseDataSourceId("source-1"),
      revision: 1,
      entries: [
        {
          propertyId: tagsProperty.propertyId,
          visibility: "always_show",
          rankKey: "a0",
        },
      ],
    },
  },
};

describe("usePageStageProperties", () => {
  beforeEach(() => optionRuntime.readWindow.mockReset());

  test("resolves visible selected option labels before a picker opens", async () => {
    optionRuntime.readWindow.mockResolvedValue({
      options: [
        { id: "o_AAAAAAAA", name: "Feature", color: "green" },
        { id: "o_BBBBBBBB", name: "Fix", color: "orange" },
      ],
      nextCursor: null,
      projectionRevision: 1,
    });

    const hook = renderHook(() =>
      usePageStageProperties({
        pageModel,
        contentAccessContext: projectContentAccess("project-1"),
        onUpdateProperty: async () => ({ status: "updated", didMutate: true }),
        onOpenPage: () => undefined,
        onRefreshProperties: async () => undefined,
        beginSaving: () => () => undefined,
      }),
    );

    await waitFor(() => expect(hook.result.current.optionRegistryStates.tags).toBe("ready"));
    expect(hook.result.current.options.tags).toEqual([
      { id: "o_AAAAAAAA", name: "Feature", color: "green" },
      { id: "o_BBBBBBBB", name: "Fix", color: "orange" },
    ]);
    expect(optionRuntime.readWindow).toHaveBeenCalledTimes(1);
  });

  test("commits Status through the same revision-aware Property mutation as every scalar", async () => {
    optionRuntime.readWindow.mockResolvedValue({
      options: [
        { id: "plan", name: "Plan", color: "gray" },
        { id: "ship", name: "Ship", color: "green" },
      ],
      nextCursor: null,
      projectionRevision: 1,
    });
    const onUpdateProperty = vi.fn(async () => ({
      status: "conflict" as const,
      currentValue: "plan",
      currentRevision: 5,
    }));
    const statusPageModel: PageStagePageModel = {
      ...pageModel,
      databaseContext: {
        kind: "member",
        membership: {
          id: "membership-1",
          dataSourceId: "source-1",
          databaseId: "database-1",
          revision: 1,
        },
        properties: [statusItem],
        semanticProperties: readPageStageSemanticProperties([statusItem]),
        pageLayout: {
          dataSourceId: parseDataSourceId("source-1"),
          revision: 1,
          entries: [
            {
              propertyId: statusProperty.propertyId,
              visibility: "always_show",
              rankKey: "a0",
            },
          ],
        },
      },
    };
    const hook = renderHook(() =>
      usePageStageProperties({
        pageModel: statusPageModel,
        contentAccessContext: projectContentAccess("project-1"),
        onUpdateProperty,
        onOpenPage: () => undefined,
        onRefreshProperties: async () => undefined,
        beginSaving: () => () => undefined,
      }),
    );

    let result: Awaited<ReturnType<typeof hook.result.current.edit>> | undefined;
    await act(async () => {
      result = await hook.result.current.edit(statusItem, {
        kind: "replace",
        value: "ship",
        expectedValueRevision: 4,
      });
    });

    expect(onUpdateProperty).toHaveBeenCalledWith("page-1", "status", {
      kind: "replace",
      value: "ship",
      expectedValueRevision: 4,
    });
    expect(result?.status).toBe("conflict");
    expect(hook.result.current.errors.status).toBe(
      "Value changed elsewhere. Review and try again.",
    );
  });
});
