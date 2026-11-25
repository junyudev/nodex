import { expect, test } from "vite-plus/test";
import { resolveVitestTestTier } from "./vitest-test-tier";

test("validates explicit Vitest collection scopes", () => {
  expect(resolveVitestTestTier("default")).toBe("default");
  expect(resolveVitestTestTier("nightly")).toBe("nightly");
  expect(resolveVitestTestTier("stress")).toBe("stress");
  expect(resolveVitestTestTier("live")).toBe("live");
  expect(resolveVitestTestTier("related")).toBe("related");
  expect(() => resolveVitestTestTier("slow")).toThrow(
    'NODEX_TEST_TIER must be "default", "nightly", "stress", "live", or "related"',
  );
});
