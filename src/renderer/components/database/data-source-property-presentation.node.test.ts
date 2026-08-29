import { describe, expect, test } from "vite-plus/test";

import {
  EstimateIcon,
  MultiSelectIcon,
  PriorityIcon,
  StatusIcon,
  TagsIcon,
} from "@/components/shared/icons";
import { parseDataSourcePropertyId } from "../../../shared/database-identities";
import { dataSourcePropertyIcon } from "./data-source-property-presentation";

describe("Data Source Property icons", () => {
  test("uses semantic icons for built-in identities", () => {
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("status"),
        valueType: "select",
      }),
    ).toBe(StatusIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("priority"),
        valueType: "select",
      }),
    ).toBe(PriorityIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("estimate"),
        valueType: "select",
      }),
    ).toBe(EstimateIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("tags"),
        valueType: "multi_select",
      }),
    ).toBe(TagsIcon);
  });

  test("uses distinct Select and Multi-select icons for user-defined Properties", () => {
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("p_0123abcd"),
        valueType: "select",
      }),
    ).toBe(TagsIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("p_abcdefgh"),
        valueType: "multi_select",
      }),
    ).toBe(MultiSelectIcon);
  });
});
