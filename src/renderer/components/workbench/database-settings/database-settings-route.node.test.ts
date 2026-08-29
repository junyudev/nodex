import { describe, expect, it } from "vitest";

import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import {
  backDatabaseSettingsRoute,
  openDatabaseSettingsRoute,
  pushDatabaseSettingsRoute,
  reconcileDatabaseSettingsRouteStack,
} from "./database-settings-route";

const databaseId = parseDatabaseId("database");
const firstViewId = parseDatabaseViewId("first-view");
const secondViewId = parseDatabaseViewId("second-view");
const firstSourceId = parseDataSourceId("first-source");
const secondSourceId = parseDataSourceId("second-source");

describe("database settings route stack", () => {
  it("backs through one typed stack and closes from its root", () => {
    const root = openDatabaseSettingsRoute({ kind: "root", databaseId, viewId: firstViewId });
    const nested = pushDatabaseSettingsRoute(root, { kind: "view", viewId: firstViewId });

    expect(backDatabaseSettingsRoute(nested)).toEqual(root);
    expect(backDatabaseSettingsRoute(root)).toBeNull();
  });

  it("moves view-owned routes to the newly selected exact View", () => {
    const stack = openDatabaseSettingsRoute({ kind: "view_properties", viewId: firstViewId });

    expect(
      reconcileDatabaseSettingsRouteStack({
        stack,
        databaseId,
        previousViewId: firstViewId,
        nextViewId: secondViewId,
        previousDataSourceId: firstSourceId,
        nextDataSourceId: firstSourceId,
      }),
    ).toEqual([{ kind: "view", viewId: secondViewId }]);
  });

  it("preserves Source-owned Property routes only while their Source remains active", () => {
    const stack = openDatabaseSettingsRoute({
      kind: "property",
      dataSourceId: firstSourceId,
      propertyId: parseDataSourcePropertyId("status"),
    });
    const sameSource = reconcileDatabaseSettingsRouteStack({
      stack,
      databaseId,
      previousViewId: firstViewId,
      nextViewId: secondViewId,
      previousDataSourceId: firstSourceId,
      nextDataSourceId: firstSourceId,
    });
    const changedSource = reconcileDatabaseSettingsRouteStack({
      stack,
      databaseId,
      previousViewId: firstViewId,
      nextViewId: secondViewId,
      previousDataSourceId: firstSourceId,
      nextDataSourceId: secondSourceId,
    });

    expect(sameSource).toBe(stack);
    expect(changedSource.at(-1)).toEqual({ kind: "view", viewId: secondViewId });
  });
});
