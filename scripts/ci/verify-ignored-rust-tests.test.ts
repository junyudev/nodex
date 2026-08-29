import { describe, expect, test } from "vite-plus/test";

import { findIgnoredRustTests, verifyIgnoredRustTestManifest } from "./verify-ignored-rust-tests";

describe("ignored Rust test CI contract", () => {
  test("discovers the repository's ignored tests and gives each one a canonical tier", async () => {
    const tests = await findIgnoredRustTests();
    expect(tests.map((test) => test.name)).toEqual(
      expect.arrayContaining([
        "canvas_incremental_hot_path_stays_bounded_at_twenty_thousand_elements",
        "million_edge_relation_projection_stays_bounded_at_sqlite_boundary",
        "read_budget_gate_large_fixture",
        "sidebar_section_large_window_budget",
      ]),
    );
    await expect(verifyIgnoredRustTestManifest()).resolves.toHaveLength(tests.length);
  });
});
