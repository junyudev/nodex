import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { usePropertyOptionRegistries } from "./use-property-option-registries";

const optionRuntime = vi.hoisted(() => ({ readWindow: vi.fn() }));
vi.mock("@/lib/database-property-options-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-property-options-runtime")>()),
  readPropertyOptionWindow: optionRuntime.readWindow,
}));

const property: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("tags"),
  dataSourceId: parseDataSourceId("source-1"),
  name: "Tags",
  ...testPropertySemantics("multi_select", 3),
  valueType: "multi_select",
  config: {},
  optionCount: 3,
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("usePropertyOptionRegistries", () => {
  beforeEach(() => optionRuntime.readWindow.mockReset());

  test("merges a continuation and restarts instead of merging another projection", async () => {
    optionRuntime.readWindow
      .mockResolvedValueOnce({
        options: [{ id: "o_AAAAAAAA", name: "First" }],
        nextCursor: "cursor-1",
        projectionRevision: 1,
      })
      .mockResolvedValueOnce({
        options: [{ id: "o_BBBBBBBB", name: "Second" }],
        nextCursor: "cursor-2",
        projectionRevision: 1,
      })
      .mockResolvedValueOnce({
        options: [{ id: "o_DDDDDDDD", name: "Must not merge" }],
        nextCursor: null,
        projectionRevision: 2,
      })
      .mockResolvedValueOnce({
        options: [{ id: "o_CCCCCCCC", name: "Refreshed" }],
        nextCursor: null,
        projectionRevision: 2,
      });
    const hook = renderHook(() =>
      usePropertyOptionRegistries({
        routingContext: { kind: "project", projectId: "project-1" },
        properties: [property],
      }),
    );

    await waitFor(() => expect(hook.result.current.states.tags).toBe("idle"));
    expect(optionRuntime.readWindow).not.toHaveBeenCalled();
    act(() => hook.result.current.requestOptions(property));
    await waitFor(() =>
      expect(hook.result.current.options.tags).toEqual([{ id: "o_AAAAAAAA", name: "First" }]),
    );
    expect(hook.result.current.hasMore.tags).toBe(true);

    act(() => hook.result.current.requestMoreOptions(property));
    await waitFor(() =>
      expect(hook.result.current.options.tags).toEqual([
        { id: "o_AAAAAAAA", name: "First" },
        { id: "o_BBBBBBBB", name: "Second" },
      ]),
    );
    expect(hook.result.current.hasMore.tags).toBe(true);

    act(() => hook.result.current.requestMoreOptions(property));
    await waitFor(() =>
      expect(hook.result.current.options.tags).toEqual([{ id: "o_CCCCCCCC", name: "Refreshed" }]),
    );
    expect(hook.result.current.hasMore.tags).toBe(false);
    expect(optionRuntime.readWindow.mock.calls.map(([, , after]) => after)).toEqual([
      null,
      "cursor-1",
      "cursor-2",
      null,
    ]);
  });

  test("drops a same-shaped registry when the Data Source identity changes", async () => {
    const nextProperty = {
      ...property,
      dataSourceId: parseDataSourceId("source-2"),
    };
    optionRuntime.readWindow
      .mockResolvedValueOnce({
        options: [{ id: "o_AAAAAAAA", name: "Source A" }],
        nextCursor: null,
        projectionRevision: 1,
      })
      .mockResolvedValueOnce({
        options: [{ id: "o_BBBBBBBB", name: "Source B" }],
        nextCursor: null,
        projectionRevision: 1,
      });
    const hook = renderHook(
      ({ currentProperty }) =>
        usePropertyOptionRegistries({
          routingContext: { kind: "project", projectId: "project-1" },
          properties: [currentProperty],
        }),
      { initialProps: { currentProperty: property } },
    );
    await waitFor(() => expect(hook.result.current.states.tags).toBe("idle"));
    act(() => hook.result.current.requestOptions(property));
    await waitFor(() => expect(hook.result.current.options.tags?.[0]?.name).toBe("Source A"));

    hook.rerender({ currentProperty: nextProperty });
    await waitFor(() => expect(hook.result.current.options.tags).toEqual([]));
    expect(hook.result.current.states.tags).toBe("idle");
    act(() => hook.result.current.requestOptions(nextProperty));
    await waitFor(() => expect(hook.result.current.options.tags?.[0]?.name).toBe("Source B"));
    expect(optionRuntime.readWindow.mock.calls.map(([, current]) => current.dataSourceId)).toEqual([
      parseDataSourceId("source-1"),
      parseDataSourceId("source-2"),
    ]);
  });

  test("preloads a registry whose labels are required by a closed surface", async () => {
    optionRuntime.readWindow
      .mockResolvedValueOnce({
        options: [
          { id: "o_AAAAAAAA", name: "First" },
          { id: "o_BBBBBBBB", name: "Second" },
        ],
        nextCursor: "page-2",
        projectionRevision: 1,
      })
      .mockResolvedValueOnce({
        options: [{ id: "o_CCCCCCCC", name: "Third" }],
        nextCursor: null,
        projectionRevision: 1,
      });

    const hook = renderHook(() =>
      usePropertyOptionRegistries({
        routingContext: { kind: "project", projectId: "project-1" },
        properties: [property],
        requiredOptionIds: { [property.propertyId]: ["o_CCCCCCCC"] },
      }),
    );

    await waitFor(() => expect(hook.result.current.states.tags).toBe("ready"));
    expect(hook.result.current.options.tags?.map((option) => option.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(optionRuntime.readWindow).toHaveBeenCalledTimes(2);
  });

  test("preloads compact semantic registries before a picker opens", async () => {
    const statusProperty: DataSourcePropertyRecordV2 = {
      ...property,
      propertyId: parseDataSourcePropertyId("status"),
      name: "Status",
      ...testPropertySemantics("select", 5),
      valueType: "select",
      config: { options: [{ id: "build", name: "In progress" }] },
      optionCount: 5,
    };
    optionRuntime.readWindow.mockResolvedValueOnce({
      options: [
        { id: "triage", name: "Triage" },
        { id: "plan", name: "Planned" },
        { id: "build", name: "In progress" },
        { id: "review", name: "Review" },
        { id: "ship", name: "Shipped" },
      ],
      nextCursor: null,
      projectionRevision: 1,
    });

    const hook = renderHook(() =>
      usePropertyOptionRegistries({
        routingContext: { kind: "project", projectId: "project-1" },
        properties: [statusProperty],
      }),
    );

    await waitFor(() => expect(hook.result.current.states.status).toBe("ready"));
    expect(hook.result.current.options.status).toHaveLength(5);
    expect(optionRuntime.readWindow).toHaveBeenCalledTimes(1);
  });
});
