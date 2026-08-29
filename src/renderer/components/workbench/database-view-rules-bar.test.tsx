import { fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import type { DatabaseViewConfigV6 } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import type { DatabaseViewRulesController } from "../../lib/use-database-view-rules-controller";
import { useDatabaseViewRulesController } from "../../lib/use-database-view-rules-controller";
import { render } from "../../test/dom";
import { DatabaseViewRulesBar, DatabaseViewRuleToolbarControls } from "./database-view-rules-bar";

const config: DatabaseViewConfigV6 = {
  schemaKey: "nodex.database-view",
  schemaVersion: 6,
  rules: {
    propertyFilters: [],
    advancedFilter: null,
    sorts: [{ field: { kind: "created" }, direction: "desc", nulls: "last" }],
  },
  presentation: {
    conditionalColors: [],
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: { fields: [], propertyOrder: [], showEmptyGroups: false },
  },
};

const timestamp = "2026-08-30T00:00:00.000Z";
const property = (
  propertyId: string,
  name: string,
  valueType: DataSourcePropertyRecordV2["valueType"],
): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId: parseDataSourceId("source-rule-bar"),
  name,
  ...testPropertySemantics(valueType),
  valueType,
  config: {},
  rankKey: propertyId,
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const tags = property("p_TAGS0001", "Tags", "multi_select");

test("keeps active rules editable in the inline rule bar", () => {
  const setPopover = vi.fn();
  const controller: DatabaseViewRulesController = {
    rules: config.rules,
    barOpen: true,
    popover: null,
    pulse: 0,
    filtersPersonal: false,
    sortsPersonal: false,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover,
    setPopoverOpen: (target, open) => setPopover(open ? target : null),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort: vi.fn(),
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter: vi.fn(),
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter: vi.fn(),
    setSorts: vi.fn(),
    reset: vi.fn(),
    publish: vi.fn(),
  };
  const screen = render(
    <DatabaseViewRulesBar controller={controller} config={config} properties={[]} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Edit sorts" }));
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));

  expect(setPopover).toHaveBeenCalledWith({ kind: "sort" });
  expect(setPopover).toHaveBeenCalledWith({ kind: "create_filter", origin: "bar" });
});

test("resets and publishes all personal filter and sort rules directly", async () => {
  const publish = vi.fn();
  const resetRules = vi.fn();
  const personalRules: DatabaseViewConfigV6["rules"] = {
    propertyFilters: [
      {
        filterId: "filter-tags",
        clause: {
          kind: "clause",
          propertyId: tags.propertyId,
          operator: "multi_select_contains",
          value: ["option-design"],
        },
      },
    ],
    advancedFilter: null,
    sorts: [{ field: { kind: "created" }, direction: "asc", nulls: "last" }],
  };
  const controller: DatabaseViewRulesController = {
    rules: personalRules,
    barOpen: true,
    popover: null,
    pulse: 0,
    filtersPersonal: true,
    sortsPersonal: true,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover: vi.fn(),
    setPopoverOpen: vi.fn(),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort: vi.fn(),
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter: vi.fn(),
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter: vi.fn(),
    setSorts: vi.fn(),
    reset: resetRules,
    publish,
  };
  const screen = render(
    <DatabaseViewRulesBar
      controller={controller}
      config={config}
      properties={[tags]}
      optionRegistries={{
        [tags.propertyId]: [{ id: "option-design", name: "Design", color: "blue" }],
      }}
    />,
  );

  const reset = screen.getByRole("button", { name: "Reset my changes" });
  const save = screen.getByRole("button", { name: "Save for everyone" });
  const tail = screen.getByTestId("database-view-rules-bar-tail");
  expect(reset.textContent).toBe("");
  expect(save.textContent).toBe("");
  expect(reset.querySelector("svg")).not.toBeNull();
  expect(save.querySelector("svg")).not.toBeNull();
  expect(tail.contains(reset)).toBe(true);
  expect(tail.contains(save)).toBe(true);
  expect(screen.queryByText("Changes here are personal until saved for everyone.")).toBeNull();
  expect(screen.queryByLabelText("Personal filter change")).toBeNull();
  expect(screen.queryByLabelText("Personal sort change")).toBeNull();

  const sortToken = screen.getByRole("button", { name: "Edit sorts" });
  const filterToken = screen.getByRole("button", { name: "Edit filter Tags" });
  expect(sortToken.dataset.personalActionPreview).toBeUndefined();
  expect(filterToken.dataset.personalActionPreview).toBeUndefined();

  fireEvent.pointerMove(save, { pointerType: "mouse" });
  fireEvent.mouseEnter(save);
  expect(sortToken.dataset.personalActionPreview).toBe("publish");
  expect(filterToken.dataset.personalActionPreview).toBe("publish");
  await waitFor(() =>
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Save these filter and sort changes\nFor everyone",
    ),
  );
  fireEvent.mouseLeave(save);
  expect(sortToken.dataset.personalActionPreview).toBeUndefined();
  expect(filterToken.dataset.personalActionPreview).toBeUndefined();

  fireEvent.focus(reset);
  expect(sortToken.dataset.personalActionPreview).toBe("reset");
  expect(filterToken.dataset.personalActionPreview).toBe("reset");
  fireEvent.blur(reset);
  expect(sortToken.dataset.personalActionPreview).toBeUndefined();
  expect(filterToken.dataset.personalActionPreview).toBeUndefined();

  fireEvent.click(save);

  expect(publish).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledWith("all");
  expect(screen.queryByRole("button", { name: "Save filters" })).toBeNull();

  fireEvent.click(reset);
  expect(resetRules).toHaveBeenCalledOnce();
  expect(resetRules).toHaveBeenCalledWith("all");
  expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
});

test("previews only the personal rule branches affected by save and reset", () => {
  const sharedQuickFilter = {
    filterId: "filter-tags",
    clause: {
      kind: "clause" as const,
      propertyId: tags.propertyId,
      operator: "multi_select_contains" as const,
      value: ["option-design"],
    },
  };
  const sharedConfig: DatabaseViewConfigV6 = {
    ...config,
    rules: { ...config.rules, propertyFilters: [sharedQuickFilter] },
  };
  const controller: DatabaseViewRulesController = {
    rules: {
      ...sharedConfig.rules,
      advancedFilter: {
        kind: "group",
        operator: "and",
        children: [
          {
            kind: "clause",
            propertyId: tags.propertyId,
            operator: "multi_select_contains",
            value: ["option-review"],
          },
        ],
      },
    },
    barOpen: true,
    popover: null,
    pulse: 0,
    filtersPersonal: true,
    sortsPersonal: false,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover: vi.fn(),
    setPopoverOpen: vi.fn(),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort: vi.fn(),
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter: vi.fn(),
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter: vi.fn(),
    setSorts: vi.fn(),
    reset: vi.fn(),
    publish: vi.fn(),
  };
  const screen = render(
    <DatabaseViewRulesBar
      controller={controller}
      config={sharedConfig}
      properties={[tags]}
      optionRegistries={{
        [tags.propertyId]: [
          { id: "option-design", name: "Design", color: "blue" },
          { id: "option-review", name: "Review", color: "yellow" },
        ],
      }}
    />,
  );

  fireEvent.mouseEnter(screen.getByRole("button", { name: "Save for everyone" }));

  expect(
    screen.getByRole("button", { name: "Edit advanced filter" }).dataset.personalActionPreview,
  ).toBe("publish");
  expect(
    screen.getByRole("button", { name: "Edit filter Tags" }).dataset.personalActionPreview,
  ).toBeUndefined();
  expect(
    screen.getByRole("button", { name: "Edit sorts" }).dataset.personalActionPreview,
  ).toBeUndefined();
});

test("keeps empty Sort creation at the toolbar instead of adding a bar placeholder", async () => {
  const addSort = vi.fn();
  const controller: DatabaseViewRulesController = {
    rules: { propertyFilters: [], advancedFilter: null, sorts: [] },
    barOpen: true,
    popover: { kind: "create_sort" },
    pulse: 0,
    filtersPersonal: false,
    sortsPersonal: false,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover: vi.fn(),
    setPopoverOpen: vi.fn(),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort,
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter: vi.fn(),
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter: vi.fn(),
    setSorts: vi.fn(),
    reset: vi.fn(),
    publish: vi.fn(),
  };
  const screen = render(
    <>
      <DatabaseViewRuleToolbarControls controller={controller} properties={[]} />
      <DatabaseViewRulesBar
        controller={controller}
        config={{ ...config, rules: controller.rules }}
        properties={[]}
      />
    </>,
  );

  expect(screen.queryByRole("button", { name: "Add sort" })).toBeNull();
  expect(await screen.findByText("New sort")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(addSort).toHaveBeenCalledWith({ kind: "title" });
});

test("toolbar buttons close their own empty-state picker on the next click", async () => {
  function Harness() {
    const [rules, setRules] = useState(config.rules);
    const [barOpen, setBarOpen] = useState(false);
    const controller = useDatabaseViewRulesController({
      ownerKey: "view-empty",
      rules: { ...rules, sorts: [] },
      barOpen,
      onBarOpenChange: setBarOpen,
      onRulesChange: setRules,
      filtersPersonal: false,
      sortsPersonal: false,
      onReset: vi.fn(),
      onPublish: vi.fn(),
    });
    return <DatabaseViewRuleToolbarControls controller={controller} properties={[]} />;
  }
  const screen = render(<Harness />);
  const filterButton = screen.getByRole("button", { name: "Filter View" });

  fireEvent.click(filterButton);
  expect(await screen.findByText("Add filter")).not.toBeNull();
  fireEvent.click(filterButton);
  await waitFor(() => expect(screen.queryByText("Add filter")).toBeNull());
});

test("edits option filters directly in the quick-filter surface", async () => {
  const removeQuickFilter = vi.fn();
  const quickConfig: DatabaseViewConfigV6 = {
    ...config,
    rules: {
      propertyFilters: [
        {
          filterId: "filter-tags",
          clause: {
            kind: "clause",
            propertyId: tags.propertyId,
            operator: "multi_select_contains",
            value: [],
          },
        },
      ],
      advancedFilter: null,
      sorts: [],
    },
  };
  const controller: DatabaseViewRulesController = {
    rules: quickConfig.rules,
    barOpen: true,
    popover: { kind: "quick_filter", filterId: "filter-tags" },
    pulse: 0,
    filtersPersonal: false,
    sortsPersonal: false,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover: vi.fn(),
    setPopoverOpen: vi.fn(),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort: vi.fn(),
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter,
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter: vi.fn(),
    setSorts: vi.fn(),
    reset: vi.fn(),
    publish: vi.fn(),
  };
  const screen = render(
    <DatabaseViewRulesBar
      controller={controller}
      config={quickConfig}
      properties={[tags]}
      optionRegistries={{
        [tags.propertyId]: [
          { id: "option-design", name: "Design", color: "blue" },
          { id: "option-review", name: "Review", color: "yellow" },
        ],
      }}
    />,
  );

  expect(screen.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Design" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Filter value for Tags" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete filter" }));
  expect(removeQuickFilter).toHaveBeenCalledWith("filter-tags");
});

test("offers complete destructive actions in sort and advanced-filter editors", async () => {
  const setSorts = vi.fn();
  const setAdvancedFilter = vi.fn();
  const advancedFilter = {
    kind: "group" as const,
    operator: "and" as const,
    children: [
      {
        kind: "clause" as const,
        propertyId: tags.propertyId,
        operator: "multi_select_contains" as const,
        value: [],
      },
    ],
  };
  const advancedConfig: DatabaseViewConfigV6 = {
    ...config,
    rules: { propertyFilters: [], advancedFilter, sorts: [] },
  };
  const controller: DatabaseViewRulesController = {
    rules: advancedConfig.rules,
    barOpen: true,
    popover: { kind: "advanced_filter" },
    pulse: 0,
    filtersPersonal: false,
    sortsPersonal: false,
    busy: false,
    error: null,
    setBarOpen: vi.fn(),
    setPopover: vi.fn(),
    setPopoverOpen: vi.fn(),
    invokeFilterToolbar: vi.fn(),
    invokeSortToolbar: vi.fn(),
    addQuickFilter: vi.fn(),
    addSort: vi.fn(),
    editAdvancedFilter: vi.fn(),
    updateQuickFilter: vi.fn(),
    removeQuickFilter: vi.fn(),
    moveQuickFilterToAdvanced: vi.fn(),
    reorderQuickFilters: vi.fn(),
    setAdvancedFilter,
    setSorts,
    reset: vi.fn(),
    publish: vi.fn(),
  };
  const screen = render(
    <DatabaseViewRulesBar controller={controller} config={advancedConfig} properties={[tags]} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Delete filter" }));
  expect(setAdvancedFilter).toHaveBeenCalledWith(null);

  const sortController: DatabaseViewRulesController = {
    ...controller,
    rules: config.rules,
    popover: { kind: "sort" },
  };
  screen.rerender(
    <DatabaseViewRulesBar controller={sortController} config={config} properties={[]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete sort" }));
  expect(setSorts).toHaveBeenCalledWith([]);
});
