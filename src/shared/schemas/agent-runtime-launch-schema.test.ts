import { describe, expect, test } from "vite-plus/test";
import { AgentRuntimeLaunchSchema } from "./agent-runtime-api";

/** A chat launched from a Page, as the renderer builds it (see launchAgentRuntimeSession). */
function pageSendLaunch(overrides: Record<string, unknown> = {}) {
  return {
    launchId: "launch-1",
    acceptedAt: 1_700_000_000_000,
    sessionId: "session-1",
    projectId: null,
    title: "Send source",
    initialPageIds: ["page-1"],
    workPage: { pageId: "page-1", onlyIfAgentWork: true },
    modelSelection: { instanceId: "codex", model: "gpt-6" },
    interactionMode: "default",
    runInTarget: "localProject",
    message: { messageId: "message-1", text: "Explain this paragraph" },
    ...overrides,
  };
}

describe("agent runtime launch boundary", () => {
  test("accepts a Page send that names the Page it works on", () => {
    const parsed = AgentRuntimeLaunchSchema.parse(pageSendLaunch());
    expect(parsed.workPage).toEqual({ pageId: "page-1", onlyIfAgentWork: true });
  });

  test("rejects launch fields that only Main may set", () => {
    const hostOnly = [
      { messageOrigin: "host" },
      { coordinator: true },
      { messageFingerprint: "fingerprint-1" },
      {
        automationExecution: {
          automationId: "a",
          runId: "r",
          leaseId: "l",
          dispatchId: "d",
        },
      },
    ];
    for (const extra of hostOnly) {
      expect(() => AgentRuntimeLaunchSchema.parse(pageSendLaunch(extra))).toThrow();
    }
  });

  test("rejects a Page reference with an unknown key", () => {
    expect(() =>
      AgentRuntimeLaunchSchema.parse(
        pageSendLaunch({ workPage: { pageId: "page-1", owner: "someone" } }),
      ),
    ).toThrow();
  });
});
