import { describe, expect, test } from "vite-plus/test";
import { projectAgentRuntimeSubagentDisplay } from "./agent-runtime-subagent-display";

describe("Runtime subagent display names", () => {
  test("presents the last native path segment and retains the complete path", () => {
    expect(
      projectAgentRuntimeSubagentDisplay({
        driver: "codex",
        origin: "provider_native",
        title: " /root/review_team/reference_bundle ",
      }),
    ).toEqual({
      displayName: "Reference bundle",
      agentPath: "/root/review_team/reference_bundle",
    });
  });

  test.each([
    { driver: "codex", origin: "app_owned", title: "/root/reference_bundle" },
    { driver: "claudeAgent", origin: "provider_native", title: "/root/reference_bundle" },
    { driver: "codex", origin: "provider_native", title: "UI/API audit" },
    { driver: "codex", origin: "provider_native", title: "Inspect /root/reference_bundle" },
    { driver: "codex", origin: "provider_native", title: "Ada" },
  ] as const)("preserves names that are not Codex native paths: $title", (source) => {
    expect(projectAgentRuntimeSubagentDisplay(source)).toEqual({
      displayName: source.title,
      agentPath: null,
    });
  });

  test("leaves an absent name available for the surface's fallback", () => {
    expect(
      projectAgentRuntimeSubagentDisplay({
        driver: "codex",
        origin: "provider_native",
        title: " ",
      }),
    ).toEqual({ displayName: null, agentPath: null });
  });
});
