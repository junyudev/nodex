import { describe, expect, test, vi } from "vite-plus/test";
import { readSessionMentionSummary } from "./session-mentions";
import { readCurrentProjectSessionDetail } from "./project-session-query-cache";
import { readCodexThreadSummary } from "./codex-thread-summary";
vi.mock("./project-session-query-cache", () => ({ readCurrentProjectSessionDetail: vi.fn() }));
vi.mock("./codex-thread-summary", () => ({ readCodexThreadSummary: vi.fn() }));

describe("Session mention resolution", () => {
  test("looks up the Session before its current execution binding and uses its current title", async () => {
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue({
      id: "session-1",
      displayTitle: "Current chat",
      projectId: null,
      archived: false,
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
      thread: null,
      executionRef: { runtimeId: "runtime-1", threadId: "execution-root" },
    } as never);
    vi.mocked(readCodexThreadSummary).mockResolvedValue(null);
    const summary = await readSessionMentionSummary("session-1");
    expect(readCurrentProjectSessionDetail).toHaveBeenCalledWith("session-1");
    expect(readCodexThreadSummary).toHaveBeenCalledWith("execution-root");
    expect(summary?.threadId).toBe("execution-root");
    expect(summary?.threadName).toBe("Current chat");
    vi.mocked(readCodexThreadSummary).mockClear();
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue(null);
    expect(await readSessionMentionSummary("missing-session")).toBeNull();
    expect(readCodexThreadSummary).not.toHaveBeenCalled();
  });
  test("resolves an unstarted Session without asking for an execution Thread", async () => {
    vi.mocked(readCurrentProjectSessionDetail).mockResolvedValue({
      id: "unstarted",
      displayTitle: "Draft chat",
      projectId: null,
      archived: false,
      createdAt: "2026-10-28T00:00:00Z",
      updatedAt: "2026-10-28T00:00:00Z",
      thread: null,
      executionRef: null,
    } as never);
    vi.mocked(readCodexThreadSummary).mockClear();
    expect((await readSessionMentionSummary("unstarted"))?.threadName).toBe("Draft chat");
    expect(readCodexThreadSummary).not.toHaveBeenCalled();
  });
});
