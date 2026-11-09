import { beforeAll, describe, expect, test } from "vite-plus/test";
import { bindRendererSpace } from "./renderer-space";
import {
  resolveSessionExecution,
  resolveSessionForkAvailability,
  resolveSessionProjectMove,
  type SessionExecutionSource,
} from "./session-execution";
import { resolveWorkbenchPanelCapabilities } from "./workbench-panel-capabilities";

const hosted: SessionExecutionSource = {
  id: "session-1",
  projectId: "project-1",
  displayTitle: "Hosted work",
  archived: false,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T01:00:00.000Z",
  thread: null,
  executionRef: { runtimeId: "host-runtime", threadId: "root-1" },
};

beforeAll(() => {
  bindRendererSpace({
    spaceId: "team",
    kind: "team",
    memberId: "alice",
    deviceId: "desktop",
    name: "Crew",
    availability: "ready",
  });
});

describe("a team Space's hosted chats", () => {
  test("fork on their Space host from the chat they run", () => {
    expect(resolveSessionForkAvailability(resolveSessionExecution(hosted))).toEqual({
      available: true,
      source: { sessionId: "session-1", threadId: "root-1" },
    });
  });

  test("move to another Project for their owner or a Space Owner, through the host", () => {
    expect(resolveSessionProjectMove({ ...hosted, canManage: true })).toEqual({
      kind: "runtime",
      sessionId: "session-1",
    });
    expect(resolveSessionProjectMove({ ...hosted, canManage: false })).toBeNull();
  });

  test("open side chats on their Space host", () => {
    const panels = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: "codex",
        projectId: "project-1",
        hasAttachedThread: true,
        cwd: null,
      },
    });
    expect(panels.actions.side_chat).toEqual({ available: true, reason: null });
    expect(panels.availableActionKinds).toContain("side_chat");
  });
});
