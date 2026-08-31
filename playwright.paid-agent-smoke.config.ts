import { defineConfig } from "@playwright/test";

import { baseElectronE2eConfig } from "./playwright.e2e.config";
import {
  PAID_AGENT_SMOKE_DEFINITIONS,
  requirePaidAgentSmokeCase,
} from "./scripts/paid-agent-smoke-contract";

if (process.env.CI) {
  throw new Error("Paid Agent smoke is local-only and must never run in CI.");
}

const caseId = requirePaidAgentSmokeCase(process.env.NODEX_PAID_AGENT_SMOKE_CASE);

export default defineConfig(baseElectronE2eConfig, {
  testMatch: /paid-agent-smoke\.spec\.ts/u,
  grep: new RegExp(PAID_AGENT_SMOKE_DEFINITIONS[caseId].grep, "u"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
});
