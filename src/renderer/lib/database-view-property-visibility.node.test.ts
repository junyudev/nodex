import { describe, expect, it } from "vitest";

import type { DatabaseViewLayoutDisplayConfig } from "../../shared/database-kernel";
import {
  DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
  databaseViewPropertyVisibilityKeys,
  moveDatabaseViewProperty,
  moveDatabaseViewPropertyToSortableTarget,
  toggleDatabaseViewPropertyVisibility,
} from "./database-view-property-visibility";

const display: DatabaseViewLayoutDisplayConfig = {
  fields: [
    { kind: "property", propertyId: "tag" },
    { kind: "intrinsic", field: "updated_at" },
  ],
  propertyOrder: ["tag", "files", "status"],
  showEmptyGroups: false,
  showDescription: true,
};
const propertyIds = ["tag", "files", "status"];

describe("Database View Property visibility order", () => {
  it("projects shown and hidden Properties from one ordered list", () => {
    expect(databaseViewPropertyVisibilityKeys(display, propertyIds)).toEqual([
      "tag",
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
      "files",
      "status",
    ]);
  });

  it("moves a hidden Property without changing its visibility", () => {
    const next = moveDatabaseViewProperty(display, propertyIds, "status", "files", "before");

    expect(next.propertyOrder).toEqual(["tag", "status", "files"]);
    expect(next.fields).toEqual(display.fields);
  });

  it("crossing the boundary changes order and visibility together", () => {
    const next = moveDatabaseViewProperty(
      display,
      propertyIds,
      "status",
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
      "before",
    );

    expect(next.propertyOrder).toEqual(["tag", "status", "files"]);
    expect(next.fields).toEqual([
      { kind: "property", propertyId: "tag" },
      { kind: "intrinsic", field: "updated_at" },
      { kind: "property", propertyId: "status" },
    ]);
  });

  it("maps sortable targets to directional insertion on either side of the boundary", () => {
    const hidden = moveDatabaseViewPropertyToSortableTarget(
      display,
      propertyIds,
      "tag",
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
    );
    expect(databaseViewPropertyVisibilityKeys(hidden, propertyIds)).toEqual([
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
      "tag",
      "files",
      "status",
    ]);

    const shown = moveDatabaseViewPropertyToSortableTarget(
      display,
      propertyIds,
      "status",
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
    );
    expect(databaseViewPropertyVisibilityKeys(shown, propertyIds)).toEqual([
      "tag",
      "status",
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
      "files",
    ]);
  });

  it("places a hidden toggle at the start of the hidden section", () => {
    const next = toggleDatabaseViewPropertyVisibility(display, propertyIds, "tag", false);

    expect(next.propertyOrder).toEqual(["tag", "files", "status"]);
    expect(next.fields).toEqual([{ kind: "intrinsic", field: "updated_at" }]);
    expect(databaseViewPropertyVisibilityKeys(next, propertyIds)).toEqual([
      DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
      "tag",
      "files",
      "status",
    ]);
  });
});
