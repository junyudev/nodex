import { expect, test } from "vite-plus/test";
import { resolveVitestTestTier } from "./vitest-test-tier";

test("validates explicit test tiers", () => {
  expect(resolveVitestTestTier("default")).toBe("default");
  expect(resolveVitestTestTier("stress")).toBe("stress");
  expect(() => resolveVitestTestTier("slow")).toThrow(
    'NODEX_TEST_TIER must be "default" or "stress"',
  );
});
