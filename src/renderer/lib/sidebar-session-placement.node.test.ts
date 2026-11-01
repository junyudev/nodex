import { describe, expect, it } from "vitest";
import { resolveSidebarSessionPlacement } from "./sidebar-session-placement";

const sessionIdOf = (threadKey: string) =>
  threadKey.startsWith("pending:") ? null : `session-${threadKey}`;

describe("resolveSidebarSessionPlacement", () => {
  it("anchors a moved chat before the chat now below it", () => {
    expect(
      resolveSidebarSessionPlacement({
        activeThreadKey: "c",
        nextVisibleThreadKeys: ["a", "c", "b"],
        getSessionId: sessionIdOf,
      }),
    ).toEqual({ sessionId: "session-c", placement: { kind: "before", sessionId: "session-b" } });
  });

  it("anchors a chat moved to the end after the chat above it", () => {
    expect(
      resolveSidebarSessionPlacement({
        activeThreadKey: "a",
        nextVisibleThreadKeys: ["b", "c", "a"],
        getSessionId: sessionIdOf,
      }),
    ).toEqual({ sessionId: "session-a", placement: { kind: "after", sessionId: "session-c" } });
  });

  it("falls back to the chat above when the row below has no Session yet", () => {
    expect(
      resolveSidebarSessionPlacement({
        activeThreadKey: "a",
        nextVisibleThreadKeys: ["b", "a", "pending:x"],
        getSessionId: sessionIdOf,
      }),
    ).toEqual({ sessionId: "session-a", placement: { kind: "after", sessionId: "session-b" } });
  });

  it("has no placement without a Session or a neighbor", () => {
    expect(
      resolveSidebarSessionPlacement({
        activeThreadKey: "pending:x",
        nextVisibleThreadKeys: ["a", "pending:x"],
        getSessionId: sessionIdOf,
      }),
    ).toBeNull();
    expect(
      resolveSidebarSessionPlacement({
        activeThreadKey: "a",
        nextVisibleThreadKeys: ["a"],
        getSessionId: sessionIdOf,
      }),
    ).toBeNull();
  });
});
