import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import type { DatabaseViewConfigV6 } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { render } from "../../test/dom";
import {
  DatabaseViewAdvancedFilterEditor,
  DatabaseViewFilterValueField,
} from "./database-view-filter-editors";

const timestamp = "2026-08-30T00:00:00.000Z";
const property = (propertyId: string, name: string): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId: parseDataSourceId("source-filters"),
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

const name = property("p_NAME0001", "Name");
const priorityOptions = [
  { id: "p0-critical", name: "P0 - Critical" },
  { id: "p1-high", name: "P1 - High" },
  { id: "p2-medium", name: "P2 - Medium" },
  { id: "p3-low", name: "P3 - Low" },
] as const;
const priority: DataSourcePropertyRecordV2 = {
  ...property("priority", "Priority"),
  ...testPropertySemantics("select", priorityOptions.length),
  valueType: "select",
  config: { options: priorityOptions },
};
const config: DatabaseViewConfigV6 = {
  schemaKey: "nodex.database-view",
  schemaVersion: 6,
  rules: {
    propertyFilters: [],
    advancedFilter: {
      kind: "group",
      operator: "and",
      children: [
        { kind: "clause", propertyId: name.propertyId, operator: "text_contains", value: "one" },
        { kind: "clause", propertyId: name.propertyId, operator: "text_contains", value: "two" },
        { kind: "clause", propertyId: name.propertyId, operator: "text_contains", value: "three" },
      ],
    },
    sorts: [],
  },
  presentation: {
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: { fields: [], propertyOrder: [], showEmptyGroups: false },
    conditionalColors: [],
  },
};

describe("DatabaseViewAdvancedFilterEditor", () => {
  test("authors the boolean tree as Where, selectable And/Or, and lowercase continuations", async () => {
    const onChange = vi.fn();
    const screen = render(
      <DatabaseViewAdvancedFilterEditor config={config} properties={[name]} onChange={onChange} />,
    );

    expect(screen.getByText("Where")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Filter group operator root" }).textContent,
    ).toContain("And");
    expect(screen.getByText("and")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add filter rule" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("A group to nest more filters")).toBeTruthy();

    const addFilterActions = screen.getAllByText("Add filter rule");
    await act(async () => {
      fireEvent.click(addFilterActions.at(-1)!.closest("button")!);
      await Promise.resolve();
    });
    const next = onChange.mock.lastCall?.[0] as DatabaseViewConfigV6;
    expect(next.rules.advancedFilter?.children).toHaveLength(4);
    expect(next.rules.advancedFilter?.children.at(-1)).toEqual(
      config.rules.advancedFilter?.children.at(-1),
    );
  });

  test("uses the canonical Priority value icons, order, and labels in Filter options", async () => {
    const onChange = vi.fn();
    const screen = render(
      <DatabaseViewFilterValueField
        clause={{
          kind: "clause",
          propertyId: priority.propertyId,
          operator: "select_is",
          value: "p1-high",
        }}
        property={priority}
        options={priorityOptions}
        disabled={false}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Filter value for Priority" });
    expect(trigger.textContent).toContain("P1 - High");
    expect(trigger.querySelectorAll("svg rect")).toHaveLength(3);

    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const canonicalNames = new Set<string>(priorityOptions.map((option) => option.name));
    const canonicalOptions = screen
      .getAllByRole("option")
      .filter((option) => canonicalNames.has(option.textContent?.trim() ?? ""));
    expect(canonicalOptions.map((option) => option.textContent?.trim())).toEqual(
      priorityOptions.map((option) => option.name),
    );
    expect(canonicalOptions.every((option) => option.querySelector("svg") !== null)).toBe(true);
    expect(canonicalOptions[0]?.querySelector("svg path")).not.toBeNull();
    expect(canonicalOptions[1]?.querySelectorAll("svg rect")).toHaveLength(3);

    await act(async () => {
      fireEvent.click(canonicalOptions[2]!);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith("p2-medium");
  });
});
