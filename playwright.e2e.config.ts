import { defineConfig } from "@playwright/test";
import { E2E_EXPECT_TIMEOUT_MS, E2E_TEST_TIMEOUT_MS } from "./config/test-timeouts";

export const baseElectronE2eConfig = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 1 : 0,
  timeout: E2E_TEST_TIMEOUT_MS,
  expect: {
    timeout: E2E_EXPECT_TIMEOUT_MS,
    toPass: { timeout: E2E_EXPECT_TIMEOUT_MS },
  },
  use: {
    trace: "retain-on-failure",
  },
});

export const resolveElectronE2eGrepInvert = (includePerformance: boolean): RegExp =>
  includePerformance ? /@paid-agent/u : /@paid-agent|@performance/u;

const excludedElectronTests = resolveElectronE2eGrepInvert(
  process.env.NODEX_E2E_INCLUDE_PERFORMANCE === "1",
);

export default defineConfig(baseElectronE2eConfig, {
  grepInvert: excludedElectronTests,
});
