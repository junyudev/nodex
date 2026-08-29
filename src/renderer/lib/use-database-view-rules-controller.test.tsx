import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DatabaseViewRules } from "../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { useDatabaseViewRulesController } from "./use-database-view-rules-controller";

const timestamp = "2026-08-30T00:00:00.000Z";
const property = (propertyId: string, name: string): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId: parseDataSourceId("source-rules"),
  name,
  ...testPropertySemantics("text"),
  valueType: "text",
  config: {},
  rankKey: propertyId,
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const emptyRules: DatabaseViewRules = {
  propertyFilters: [],
  advancedFilter: null,
  sorts: [],
};

describe("useDatabaseViewRulesController", () => {
  test("keeps an empty Filter create popup anchored to the toolbar", () => {
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeFilterToolbar());
    expect(result.current.barOpen).toBe(false);
    expect(result.current.popover).toEqual({ kind: "create_filter", origin: "toolbar" });

    act(() => result.current.invokeFilterToolbar());
    expect(result.current.barOpen).toBe(false);
    expect(result.current.popover).toBeNull();
  });

  test("does not reopen a toolbar picker when dismissal and its click share an event turn", () => {
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeFilterToolbar());
    expect(result.current.popover).toEqual({ kind: "create_filter", origin: "toolbar" });

    act(() => {
      result.current.setPopoverOpen({ kind: "create_filter", origin: "toolbar" }, false);
      result.current.invokeFilterToolbar();
    });
    expect(result.current.popover).toBeNull();
  });

  test("uses Filter as the rule bar toggle once filters exist", () => {
    const name = property("p_NAME0001", "Name");
    const initialRules: DatabaseViewRules = {
      ...emptyRules,
      propertyFilters: [
        {
          filterId: "filter-name",
          clause: {
            kind: "clause",
            propertyId: name.propertyId,
            operator: "text_contains",
            value: "alpha",
          },
        },
      ],
    };
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(initialRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeFilterToolbar());
    expect(result.current.barOpen).toBe(true);
    expect(result.current.popover).toBeNull();

    act(() => result.current.invokeFilterToolbar());
    expect(result.current.barOpen).toBe(false);
  });

  test("keeps an empty Sort create popup anchored to the toolbar", () => {
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeSortToolbar());
    expect(result.current.barOpen).toBe(false);
    expect(result.current.popover).toEqual({ kind: "create_sort" });
  });

  test("opens the bar and its Sort editor when sorts already exist", async () => {
    const initialRules: DatabaseViewRules = {
      ...emptyRules,
      sorts: [{ field: { kind: "created" }, direction: "desc", nulls: "last" }],
    };
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(initialRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeSortToolbar());
    expect(result.current.barOpen).toBe(true);
    await waitFor(() => expect(result.current.popover).toEqual({ kind: "sort" }));

    act(() => result.current.invokeSortToolbar());
    expect(result.current.barOpen).toBe(false);
    expect(result.current.popover).toBeNull();
  });

  test("moves a newly created Sort from its toolbar picker into the bar editor", async () => {
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.invokeSortToolbar());
    act(() => result.current.addSort({ kind: "title" }));

    expect(result.current.barOpen).toBe(true);
    expect(result.current.rules.sorts).toEqual([
      { field: { kind: "title" }, direction: "asc", nulls: "last" },
    ]);
    await waitFor(() => expect(result.current.popover).toEqual({ kind: "sort" }));
  });

  test("uses stable filter identities for add and reorder", async () => {
    const name = property("p_NAME0001", "Name");
    const notes = property("p_NOTE0001", "Notes");
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(true);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.addQuickFilter(name));
    act(() => result.current.addQuickFilter(notes));
    const ids = result.current.rules.propertyFilters.map((filter) => filter.filterId);
    expect(new Set(ids).size).toBe(2);

    act(() => result.current.reorderQuickFilters([...ids].reverse()));
    expect(result.current.rules.propertyFilters.map((filter) => filter.filterId)).toEqual(
      [...ids].reverse(),
    );
  });

  test("waits for a closed rule bar to mount before opening a newly added filter", async () => {
    const name = property("p_NAME0001", "Name");
    const { result } = renderHook(() => {
      const [rules, setRules] = useState(emptyRules);
      const [barOpen, setBarOpen] = useState(false);
      return useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules,
        barOpen,
        onBarOpenChange: setBarOpen,
        onRulesChange: setRules,
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      });
    });

    act(() => result.current.addQuickFilter(name));
    expect(result.current.barOpen).toBe(true);
    expect(result.current.rules.propertyFilters).toHaveLength(1);
    await waitFor(() =>
      expect(result.current.popover).toEqual({
        kind: "quick_filter",
        filterId: result.current.rules.propertyFilters[0]?.filterId,
      }),
    );
  });

  test("an old popup close callback cannot dismiss a newly opened popup", () => {
    const { result } = renderHook(() =>
      useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules: emptyRules,
        barOpen: true,
        onBarOpenChange: vi.fn(),
        onRulesChange: vi.fn(),
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      }),
    );

    act(() => {
      result.current.setPopoverOpen({ kind: "sort" }, true);
      result.current.setPopoverOpen({ kind: "create_filter", origin: "toolbar" }, true);
      result.current.setPopoverOpen({ kind: "sort" }, false);
    });
    expect(result.current.popover).toEqual({ kind: "create_filter", origin: "toolbar" });
  });

  test("distinguishes toolbar and bar Filter popup close callbacks", () => {
    const { result } = renderHook(() =>
      useDatabaseViewRulesController({
        ownerKey: "view-a",
        rules: emptyRules,
        barOpen: true,
        onBarOpenChange: vi.fn(),
        onRulesChange: vi.fn(),
        filtersPersonal: false,
        sortsPersonal: false,
        onReset: vi.fn(),
        onPublish: vi.fn(),
      }),
    );

    act(() => {
      result.current.setPopoverOpen({ kind: "create_filter", origin: "toolbar" }, true);
      result.current.setPopoverOpen({ kind: "create_filter", origin: "bar" }, true);
      result.current.setPopoverOpen({ kind: "create_filter", origin: "toolbar" }, false);
    });
    expect(result.current.popover).toEqual({ kind: "create_filter", origin: "bar" });
  });

  test("closes the popup when authoring switches to another View", () => {
    const { result, rerender } = renderHook(
      ({ ownerKey }) =>
        useDatabaseViewRulesController({
          ownerKey,
          rules: emptyRules,
          barOpen: true,
          onBarOpenChange: vi.fn(),
          onRulesChange: vi.fn(),
          filtersPersonal: false,
          sortsPersonal: false,
          onReset: vi.fn(),
          onPublish: vi.fn(),
        }),
      { initialProps: { ownerKey: "view-a" } },
    );

    act(() => result.current.setPopoverOpen({ kind: "sort" }, true));
    expect(result.current.popover).toEqual({ kind: "sort" });

    rerender({ ownerKey: "view-b" });
    expect(result.current.popover).toBeNull();
  });

  test("moves a quick filter to advanced exactly once", () => {
    const name = property("p_NAME0001", "Name");
    const initialRules: DatabaseViewRules = {
      ...emptyRules,
      propertyFilters: [
        {
          filterId: "filter-name",
          clause: {
            kind: "clause",
            propertyId: name.propertyId,
            operator: "text_contains",
            value: "alpha",
          },
        },
      ],
    };
    const onRulesChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ rules }) =>
        useDatabaseViewRulesController({
          ownerKey: "view-a",
          rules,
          barOpen: true,
          onBarOpenChange: vi.fn(),
          onRulesChange,
          filtersPersonal: false,
          sortsPersonal: false,
          onReset: vi.fn(),
          onPublish: vi.fn(),
        }),
      { initialProps: { rules: initialRules } },
    );

    act(() => result.current.moveQuickFilterToAdvanced("filter-name"));
    const moved = onRulesChange.mock.calls[0]?.[0] as DatabaseViewRules;
    expect(moved.propertyFilters).toEqual([]);
    expect(moved.advancedFilter?.children).toEqual([initialRules.propertyFilters[0]?.clause]);

    rerender({ rules: moved });
    act(() => result.current.moveQuickFilterToAdvanced("filter-name"));
    expect(onRulesChange).toHaveBeenCalledTimes(1);
  });
});
