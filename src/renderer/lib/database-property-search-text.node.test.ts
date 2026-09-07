import { describe, expect, test } from "vite-plus/test";

import { databasePropertyValueSearchText } from "./database-property-search-text";

describe("Database Property search text", () => {
  test("searches visible relation titles without indexing restricted targets or identity metadata", () => {
    expect(
      databasePropertyValueSearchText({
        kind: "relation",
        value: {
          value_revision: 1,
          total_count: 2,
          restricted_count: 1,
          has_more: true,
          targets: [
            {
              kind: "visible",
              edge_id: "a".repeat(64),
              page_id: "page-a",
              title: "Research notes",
              lifecycle: "active",
              membership_state: "active",
            },
          ],
        },
      }),
    ).toBe("Research notes");
  });
  test("indexes registry labels without exposing canonical option identities", () => {
    expect(
      databasePropertyValueSearchText(["o_BBBBBBBB", "o_AAAAAAAA"], {
        optionBacked: true,
        options: [
          { id: "o_AAAAAAAA", name: "Product" },
          { id: "o_CCCCCCCC", name: "Not selected" },
        ],
      }),
    ).toBe("Unknown option Product");
    expect(databasePropertyValueSearchText(42)).toBe("42");
  });
});
