import { describe, expect, test, vi } from "vite-plus/test";
import { prepareCreatedThreadNavigation } from "./created-thread-navigation";
import type { CodexCreatedThreadResolution } from "../../shared/codex-child-thread-summary";
import type { ProjectSession } from "../../shared/types";

const ready: CodexCreatedThreadResolution = {
  hostId: "remote",
  threadId: "same",
  ready: true,
  parentThreadId: null,
};
const session: ProjectSession = {
  id: "session",
  projectId: null,
  noThreadFallbackTitle: "Chat",
  displayTitle: "Chat",
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  createdAt: "now",
  updatedAt: "now",
  thread: {
    sessionId: "session",
    projectId: null,
    threadId: "same",
    executionHostId: "remote",
    backendBinding: { kind: "codex" },
    threadPreview: "",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "now",
  },
};
describe("host-qualified created chat navigation", () => {
  test("foreign resolution performs no Session write", async () => {
    const ensureOpen = vi.fn(async () => session);
    expect(
      await prepareCreatedThreadNavigation(
        { threadId: "same", expectedHostId: "remote" },
        {
          resolve: async () => ({ ...ready, hostId: "local" }),
          ensureOpen,
        },
      ),
    ).toBeNull();
    expect(ensureOpen).not.toHaveBeenCalled();
  });
  test("an explicit missing root crosses the guarded command without inventing a read receipt", async () => {
    const ensureOpen = vi.fn(async () => session);
    expect(
      await prepareCreatedThreadNavigation(
        { threadId: "same", expectedHostId: "remote" },
        { resolve: async () => null, ensureOpen },
      ),
    ).toEqual({ type: "session", resolution: null, session });
    expect(ensureOpen).toHaveBeenCalledExactlyOnceWith({ hostId: "remote", threadId: "same" });
    expect(
      await prepareCreatedThreadNavigation(
        { threadId: "same", expectedHostId: "remote" },
        { resolve: async () => null, ensureOpen: async () => null },
      ),
    ).toBeNull();
  });
  test.each([
    { threadId: "same" },
    { clientThreadId: "client-new-thread:pending", expectedHostId: "remote" },
  ])("missing host or launch receipt cannot start discovery", async (input) => {
    const ensureOpen = vi.fn(async () => session);
    expect(
      await prepareCreatedThreadNavigation(input, { resolve: async () => null, ensureOpen }),
    ).toBeNull();
    expect(ensureOpen).not.toHaveBeenCalled();
  });
  test("a still-active launch cannot create a Session merely because its native ID exists", async () => {
    const ensureOpen = vi.fn(async () => session);
    const clientThreadId = "client-new-thread:pending";
    expect(
      await prepareCreatedThreadNavigation(
        { clientThreadId, expectedHostId: "remote" },
        {
          resolve: async () => ({ ...ready, clientThreadId, ready: false }),
          ensureOpen,
        },
      ),
    ).toEqual({ type: "pending", hostId: "remote", clientThreadId });
    expect(ensureOpen).not.toHaveBeenCalled();
  });
  test("parented children do not become root Sessions", async () => {
    const ensureOpen = vi.fn(async () => session);
    const resolution = { ...ready, parentThreadId: "root" };
    expect(
      await prepareCreatedThreadNavigation(
        { threadId: "same", expectedHostId: "remote" },
        {
          resolve: async () => resolution,
          ensureOpen,
        },
      ),
    ).toEqual({ type: "child", resolution });
    expect(ensureOpen).not.toHaveBeenCalled();
  });
  test("requires the returned Session to carry the exact Codex host and Thread", async () => {
    const input = { threadId: "same", expectedHostId: "remote" };
    const ensureOpen = vi.fn(async () => session);
    expect(
      await prepareCreatedThreadNavigation(input, { resolve: async () => ready, ensureOpen }),
    ).toEqual({ type: "session", resolution: ready, session });
    expect(ensureOpen).toHaveBeenCalledExactlyOnceWith({ hostId: "remote", threadId: "same" });
    expect(
      await prepareCreatedThreadNavigation(input, {
        resolve: async () => ready,
        ensureOpen: async () => ({
          ...session,
          thread: { ...session.thread!, executionHostId: "local" },
        }),
      }),
    ).toBeNull();
  });
});
