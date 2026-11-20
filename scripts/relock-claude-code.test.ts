import { expect, test } from "vite-plus/test";
import lock from "../resources/agent-runtime/claude-code.lock.json";
import { installedClaudeAgentSdkVersion } from "./relock-claude-code";

test("Claude Code is pinned to the installed Agent SDK version", () => {
  const version = installedClaudeAgentSdkVersion();
  expect(lock.version).toBe(version);
  expect(lock.assets["darwin-arm64"].url).toEqual(
    `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-${version}.tgz`,
  );
});
