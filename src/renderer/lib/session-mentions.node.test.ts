import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ProjectSession } from "./types";
import { readSessionMentionSummary } from "./session-mentions";
import { readCurrentProjectSessionDetail } from "./project-session-query-cache";
import { invokeRendererQuery } from "./renderer-command";

vi.mock("./project-session-query-cache", () => ({ readCurrentProjectSessionDetail: vi.fn() }));
vi.mock("./renderer-command", () => ({ invokeRendererQuery: vi.fn() }));

const session = (overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id: "session-1",
  displayTitle: "Current chat",
  noThreadFallbackTitle: "Current chat",
  projectId: null,
  activityAt: 0,
  pinned: false,
  managed: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  remindAt: null,
  canManage: true,
  canStop: true,
  createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
  thread: null,
  executionRef: null,
  ...overrides,
});

beforeEach(() => {
  vi.mocked(readCurrentProjectSessionDetail).mockReset();
  vi.mocked(invokeRendererQuery).mockReset();
});

describe("Session mention resolution", () => {
  test("uses the owning Session and its Runtime root without asking any provider for metadata", async () => {
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue(
      session({ executionRef: { runtimeId: "runtime-1", threadId: "opaque-execution-root" } }),
    );

    expect(await readSessionMentionSummary("session-1")).toMatchObject({
      sessionId: "session-1",
      threadId: "opaque-execution-root",
      threadName: "Current chat",
      statusType: "notLoaded",
    });
    expect(readCurrentProjectSessionDetail).toHaveBeenCalledWith("session-1");
    expect(invokeRendererQuery).not.toHaveBeenCalled();
  });

  test.each(["codex", "claude"] as const)(
    "projects registered %s history metadata without opening its native provider",
    async (driver) => {
      vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue(
        session({
          thread: {
            sessionId: "session-1",
            projectId: null,
            threadId: "provider-history",
            threadName: "Old native title",
            threadPreview: "Saved preview",
            executionHostId: "build-box",
            backendBinding: { driver, instanceId: driver },
            cwd: "/project",
            statusType: "idle",
            statusActiveFlags: [],
            archived: false,
            createdAt: 1,
            updatedAt: 2,
            linkedAt: "2026-10-28T00:00:00Z",
          },
        }),
      );

      expect(await readSessionMentionSummary("session-1")).toMatchObject({
        sessionId: "session-1",
        threadId: "provider-history",
        threadName: "Current chat",
        threadPreview: "Saved preview",
        executionHostId: "build-box",
        cwd: "/project",
        statusType: "idle",
      });
      expect(invokeRendererQuery).not.toHaveBeenCalled();
    },
  );

  test("resolves an unstarted Session without asking for an execution Thread", async () => {
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue(
      session({ id: "unstarted", displayTitle: "Draft chat" }),
    );

    expect(await readSessionMentionSummary("unstarted")).toMatchObject({
      sessionId: "unstarted",
      threadId: "unstarted",
      threadName: "Draft chat",
    });
    expect(invokeRendererQuery).not.toHaveBeenCalled();
  });

  test("leaves a deleted Session unavailable", async () => {
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue(null);

    expect(await readSessionMentionSummary("missing-session")).toBeNull();
    expect(invokeRendererQuery).not.toHaveBeenCalled();
  });
});
