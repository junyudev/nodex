import { describe, expect, test } from "vite-plus/test";

import { resolveInboxCaptureScope } from "./inbox-capture-scope";

describe("Inbox capture scope", () => {
  test("captures into the Project the user is in, from its Scene or one of its chats", () => {
    expect(resolveInboxCaptureScope({ kind: "project", projectId: "p1" })).toEqual({
      kind: "project",
      projectId: "p1",
    });
    expect(
      resolveInboxCaptureScope({ kind: "session", sessionId: "s1", projectContextId: "p1" }),
    ).toEqual({ kind: "project", projectId: "p1" });
  });

  test("captures into All Inbox everywhere else", () => {
    for (const location of [
      { kind: "session", sessionId: "s1", projectContextId: null },
      { kind: "library" },
      { kind: "inbox" },
      { kind: "empty" },
      { kind: "automations", path: "/scheduled", returnTo: { kind: "project", projectId: "p1" } },
    ] as const) {
      expect(resolveInboxCaptureScope(location)).toEqual({ kind: "all" });
    }
  });
});
