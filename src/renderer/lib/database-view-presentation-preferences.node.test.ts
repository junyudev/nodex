import { describe, expect, test } from "vite-plus/test";

import { normalizeDatabaseViewPresentationPreferences } from "./database-view-personal-preferences";

describe("Database View presentation preferences", () => {
  test("keeps valid View-local overrides when a sibling entry is stale", () => {
    expect(
      normalizeDatabaseViewPresentationPreferences({
        "view-valid": {
          display: {
            fields: [{ kind: "property", propertyId: "priority" }],
          },
        },
        "view-stale": { display: { fields: [{ kind: "property" }] } },
        "": { display: {} },
      }),
    ).toEqual({
      "view-valid": {
        display: {
          fields: [{ kind: "property", propertyId: "priority" }],
        },
      },
    });
  });
});
