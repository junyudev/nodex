import { DEFAULT_RUNTIME_MODE } from "@nodex/agent-runtime/contracts";
import { expect, test } from "vite-plus/test";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "./agent-runtime-settings";

test("the Profile default matches the Runtime's default permission mode", () => {
  expect(DEFAULT_AGENT_RUNTIME_SETTINGS.defaultRuntimeMode).toBe(DEFAULT_RUNTIME_MODE);
});
