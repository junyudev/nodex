import { expect, it } from "vitest";
import {
  appToolsManifest,
  appToolsHostCallTimeoutMs,
  APP_TOOLS_CALL_TIMEOUT_MS,
  APP_TOOLS_PIPE_REPLY_GRACE_MS,
  APP_TOOLS_PROVIDER_TIMEOUT_MS,
} from "./manifest";

it("derives wait call deadlines while preserving ordinary tool lifetimes", () => {
  const targets = [{ sessionId: "one" }];
  expect(appToolsHostCallTimeoutMs("wait_sessions", { targets })).toBe(660_000);
  expect(appToolsHostCallTimeoutMs("wait_sessions", { targets, timeoutMs: 3_600_000 })).toBe(
    3_660_000,
  );
  expect(appToolsHostCallTimeoutMs("read_session", { timeoutMs: 3_600_000 })).toBe(
    APP_TOOLS_CALL_TIMEOUT_MS,
  );
  expect(
    appToolsHostCallTimeoutMs("wait_sessions", { targets: [...targets, { sessionId: "two" }] }),
  ).toBe(APP_TOOLS_CALL_TIMEOUT_MS);
  expect(appToolsHostCallTimeoutMs("wait_sessions", {})).toBe(APP_TOOLS_CALL_TIMEOUT_MS);
});

it("leaves reply time at every transport boundary beyond the maximum semantic wait", () => {
  const host = appToolsHostCallTimeoutMs("wait_sessions", {
    targets: [{ sessionId: "one" }],
    timeoutMs: 3_600_000,
  });
  const pipeClient = host + APP_TOOLS_PIPE_REPLY_GRACE_MS;
  expect(pipeClient).toBeGreaterThan(host);
  expect(APP_TOOLS_PROVIDER_TIMEOUT_MS).toBeGreaterThan(pipeClient);
  expect(appToolsManifest.mcpServers.nodex_app.tool_timeout_sec * 1000).toBeGreaterThanOrEqual(
    APP_TOOLS_PROVIDER_TIMEOUT_MS,
  );
});
