import { expect, test } from "vite-plus/test";
import { nativeReadOnlyBenchmarkEnvironment } from "../tests/e2e/support/native-transcript-benchmark-preflight";

test("official-native launch overrides inherited fake runtime, account keys, and external SQLite homes", () => {
  const syntheticEnvironment = {
    PATH: "/usr/bin",
    NODEX_FAKE_CODEX_STATE_PATH: "/fixture/state",
    NODEX_FAKE_CODEX_CUSTOM_OPTION: "fake",
    NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "/fixture",
    NODEX_NATIVE_TRANSCRIPT_AUTH_FILE: "/private/authorized-auth.json",
    CODEX_SQLITE_HOME: "/outside",
    OPENAI_API_KEY: "test-value",
  };
  const overlay = nativeReadOnlyBenchmarkEnvironment(syntheticEnvironment);
  const merged = { ...syntheticEnvironment, ...overlay };
  expect(merged.PATH).toBe("/usr/bin");
  expect(merged.NODEX_FAKE_CODEX_STATE_PATH).toBeUndefined();
  expect(merged.NODEX_FAKE_CODEX_CUSTOM_OPTION).toBeUndefined();
  expect(merged.NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT).toBeUndefined();
  expect(merged.NODEX_NATIVE_TRANSCRIPT_AUTH_FILE).toBeUndefined();
  expect(merged.CODEX_SQLITE_HOME).toBeUndefined();
  expect(merged.OPENAI_API_KEY).toBeUndefined();
});
