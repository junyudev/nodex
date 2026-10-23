import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ProjectSession } from "@/lib/types";
import type { SidebarSectionItem } from "../../../shared/sidebar-sections";
import { moveSidebarSectionSession, resolveSidebarDropSession } from "./sidebar-session-drop";
import type { SidebarThreadDropRequest } from "./sidebar-thread-reorder";

const commands = vi.hoisted(() => ({
  listItems: vi.fn<() => Promise<SidebarSectionItem[]>>(),
  readPinnedOrder: vi.fn(async () => ({
    orderRevision: "pins:3",
    sessionIds: ["session-draft", "session-beta", "session-alpha"],
  })),
  moveItem: vi.fn(async (_input: unknown) => undefined),
  moveSession: vi.fn(async (_input: unknown) => undefined),
  reorder: vi.fn(async (_projectId: string | null, _sessionIds: readonly string[]) => undefined),
  setPinned: vi.fn(async (_sessionId: string, _input: unknown) => undefined),
  reorderPinned: vi.fn(async (_revision: string, _sessionIds: readonly string[]) => undefined),
}));

vi.mock("@/lib/sidebar-sections-api", () => ({
  listAllSidebarSectionItems: commands.listItems,
  readSidebarPinnedSessionOrder: commands.readPinnedOrder,
}));
vi.mock("@/lib/agent-runtime-runtime", () => ({
  agentRuntimeRuntime: { moveSession: commands.moveSession },
}));
vi.mock("@/lib/workspace-catalog-commands", () => ({
  workspaceSidebarCommands: { moveItem: commands.moveItem },
  workspaceSessionCommands: {
    reorder: commands.reorder,
    setPinned: commands.setPinned,
    reorderPinned: commands.reorderPinned,
  },
}));

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id: "session-alpha",
    projectId: "project-alpha",
    noThreadFallbackTitle: "Chat alpha",
    displayTitle: "Chat alpha",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

const nativeSession = session({
  thread: {
    sessionId: "session-alpha",
    projectId: "project-alpha",
    threadId: "thread-alpha",
    threadPreview: "",
    backendBinding: { kind: "codex" },
    executionHostId: "local",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-10-23T00:00:00.000Z",
  },
});

const drop: SidebarThreadDropRequest = {
  threadId: "thread-alpha",
  sessionId: "session-alpha",
  sourceContainerId: "section:work",
  targetContainerId: "section:ideas",
  beforeThreadId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  commands.listItems.mockResolvedValue([]);
});

describe("Sidebar Section Session moves", () => {
  test("materializes an imported Thread before placing its Session", async () => {
    const catalog = {
      readCurrent: vi.fn(async () => nativeSession),
      ensureThreadSession: vi.fn(async () => nativeSession),
    };
    expect(await resolveSidebarDropSession({ ...drop, sessionId: undefined }, [], catalog)).toBe(
      nativeSession,
    );
    expect(catalog.ensureThreadSession).toHaveBeenCalledWith("thread-alpha");
    expect(catalog.readCurrent).not.toHaveBeenCalled();
  });

  test("resolves a durable draft by Session identity without creating a Thread", async () => {
    const draft = session();
    const catalog = {
      readCurrent: vi.fn(async () => draft),
      ensureThreadSession: vi.fn(async () => null),
    };
    expect(await resolveSidebarDropSession({ ...drop, threadId: null }, [], catalog)).toBe(draft);
    expect(catalog.readCurrent).toHaveBeenCalledWith(draft.id);
    expect(catalog.ensureThreadSession).not.toHaveBeenCalled();
  });

  test.each([
    ["draft", session()],
    ["native", nativeSession],
    ["Runtime", session({ executionRef: { runtimeId: "runtime-alpha", threadId: "root-alpha" } })],
  ] as const)("places a %s Session at the exact mixed Section boundary", async (_kind, source) => {
    commands.listItems.mockResolvedValue([
      {
        kind: "session",
        placementId: "placement-beta",
        rankKey: 1,
        revision: 1,
        session: { ...session(), id: "session-beta" },
      },
    ]);
    const moveNativeThread = vi.fn(async () => null);
    await moveSidebarSectionSession({
      drop: { ...drop, threadId: source.thread?.threadId ?? null, beforeItemId: "placement-beta" },
      session: source,
      moveNativeThread,
    });
    expect(commands.moveItem).toHaveBeenCalledWith({
      item: { kind: "session", sessionId: source.id },
      sectionId: "ideas",
      placement: { kind: "before", item: { kind: "session", sessionId: "session-beta" } },
    });
    expect(moveNativeThread).not.toHaveBeenCalled();
    expect(commands.moveSession).not.toHaveBeenCalled();
  });

  test("keeps Section membership when the native Project move fails", async () => {
    const moveNativeThread = vi.fn(async () => null);
    await expect(
      moveSidebarSectionSession({
        drop: { ...drop, targetContainerId: "project:project-beta" },
        session: nativeSession,
        moveNativeThread,
      }),
    ).rejects.toThrow("Couldn’t move chat");
    expect(moveNativeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContainerId: "project:project-alpha",
        targetContainerId: "project:project-beta",
        sessionId: nativeSession.id,
      }),
    );
    expect(commands.moveItem).not.toHaveBeenCalled();
  });

  test.each([
    ["chats", null, false],
    ["project:project-beta", "project-beta", false],
    ["pinned", null, true],
    ["project-pinned:project-beta", "project-beta", true],
  ] as const)(
    "moves a durable draft from its Section to %s without starting a Thread",
    async (targetContainerId, projectId, pinned) => {
      const draft = session();
      const events: string[] = [];
      commands.moveSession.mockImplementationOnce(async () => {
        events.push("move");
      });
      const finishPlacement = pinned ? commands.setPinned : commands.moveItem;
      finishPlacement.mockImplementationOnce(async () => {
        events.push(pinned ? "pin" : "release");
      });
      const moveNativeThread = vi.fn(async () => null);
      await moveSidebarSectionSession({
        drop: { ...drop, threadId: null, targetContainerId },
        session: draft,
        moveNativeThread,
      });
      expect(commands.moveSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: draft.id, projectId }),
      );
      expect(moveNativeThread).not.toHaveBeenCalled();
      if (pinned) {
        expect(events).toEqual(["move", "pin"]);
        expect(commands.setPinned).toHaveBeenCalledWith(draft.id, { pinned: true });
        expect(commands.moveItem).not.toHaveBeenCalled();
        return;
      }
      expect(events).toEqual(["move", "release"]);
      expect(commands.moveItem).toHaveBeenCalledWith({
        item: { kind: "session", sessionId: draft.id },
        sectionId: null,
        placement: { kind: "end" },
      });
    },
  );

  test("retains a draft's Section if its destination rejects the move", async () => {
    commands.moveSession.mockRejectedValueOnce(
      new Error("Target scope already owns a default-draft Project Session"),
    );
    await expect(
      moveSidebarSectionSession({
        drop: { ...drop, threadId: null, targetContainerId: "pinned" },
        session: session(),
        moveNativeThread: vi.fn(async () => null),
      }),
    ).rejects.toThrow("Target scope already owns a default-draft Project Session");
    expect(commands.setPinned).not.toHaveBeenCalled();
    expect(commands.moveItem).not.toHaveBeenCalled();
  });

  test("releases a native Chat only after its destination commits", async () => {
    const events: string[] = [];
    const moveNativeThread = vi.fn(async () => {
      events.push("move");
      expect(commands.moveItem).not.toHaveBeenCalled();
      return { operationId: "move-alpha", projectionRevision: 5 };
    });
    commands.moveItem.mockImplementationOnce(async () => {
      events.push("release");
    });
    await moveSidebarSectionSession({
      drop: { ...drop, targetContainerId: "chats" },
      session: nativeSession,
      moveNativeThread,
    });
    expect(events).toEqual(["move", "release"]);
    expect(commands.moveItem).toHaveBeenCalledWith({
      item: { kind: "session", sessionId: nativeSession.id },
      sectionId: null,
      placement: { kind: "end" },
    });
  });

  test.each([
    ["Runtime", "runtime-root-beta", undefined],
    ["draft", null, undefined],
    ["after Runtime", null, "runtime-root-before"],
  ] as const)(
    "places a native Chat at a %s Session boundary without a native Thread anchor",
    async (_kind, beforeThreadId, afterThreadId) => {
      const events: string[] = [];
      const moveNativeThread = vi.fn(async (input: SidebarThreadDropRequest) => {
        expect(input.beforeThreadId).toBeNull();
        expect(input.afterThreadId).toBeUndefined();
        expect(input.insertAtEnd).toBeUndefined();
        expect(input.useDefaultOrder).toBe(true);
        events.push("membership");
        return { operationId: "move-alpha", projectionRevision: 5 };
      });
      commands.reorder.mockImplementationOnce(async () => {
        events.push("position");
      });
      commands.moveItem.mockImplementationOnce(async () => {
        events.push("release");
      });
      await moveSidebarSectionSession({
        drop: {
          ...drop,
          targetContainerId: "project:project-beta",
          beforeThreadId,
          afterThreadId,
          targetItemIds: ["session-before", "session-beta", "session-after"],
          beforeItemId: "session-beta",
        },
        session: nativeSession,
        moveNativeThread,
      });
      expect(commands.reorder).toHaveBeenCalledWith("project-beta", [
        "session-before",
        nativeSession.id,
        "session-beta",
        "session-after",
      ]);
      expect(events).toEqual(["membership", "position", "release"]);
    },
  );

  test("keeps a native Chat in its Section if the Session position cannot commit", async () => {
    commands.reorder.mockRejectedValueOnce(new Error("Destination changed"));
    await expect(
      moveSidebarSectionSession({
        drop: {
          ...drop,
          targetContainerId: "chats",
          beforeItemId: "session-draft",
          targetItemIds: ["session-before", "session-draft"],
        },
        session: nativeSession,
        moveNativeThread: vi.fn(async () => ({ operationId: "move-alpha", projectionRevision: 5 })),
      }),
    ).rejects.toThrow("Destination changed");
    expect(commands.moveItem).not.toHaveBeenCalled();
  });

  test("moves Runtime chats to Chats by Session identity before clearing the Section", async () => {
    const runtimeSession = session({
      executionRef: { runtimeId: "runtime-alpha", threadId: "root-alpha" },
    });
    commands.moveSession.mockImplementationOnce(async () => {
      expect(commands.moveItem).not.toHaveBeenCalled();
    });
    const moveNativeThread = vi.fn(async () => null);
    await moveSidebarSectionSession({
      drop: {
        ...drop,
        targetContainerId: "chats",
        targetItemIds: ["session-beta", "session-gamma"],
        beforeItemId: "session-gamma",
      },
      session: runtimeSession,
      moveNativeThread,
    });
    expect(commands.moveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: runtimeSession.id, projectId: null }),
    );
    expect(commands.reorder).toHaveBeenCalledWith(null, [
      "session-beta",
      runtimeSession.id,
      "session-gamma",
    ]);
    expect(commands.moveItem).toHaveBeenCalledWith(expect.objectContaining({ sectionId: null }));
    expect(moveNativeThread).not.toHaveBeenCalled();
  });

  test("keeps the Section when the Runtime destination rejects the move", async () => {
    commands.moveSession.mockRejectedValueOnce(new Error("Project is unavailable"));
    await expect(
      moveSidebarSectionSession({
        drop: { ...drop, targetContainerId: "project:project-beta" },
        session: session({ executionRef: { runtimeId: "runtime-alpha", threadId: "root-alpha" } }),
        moveNativeThread: vi.fn(async () => null),
      }),
    ).rejects.toThrow("Project is unavailable");
    expect(commands.moveItem).not.toHaveBeenCalled();
  });

  test("moves a Section Chat into the root Pinned lane before pinning it", async () => {
    const moveNativeThread = vi.fn(async () => ({
      operationId: "move-alpha",
      projectionRevision: 5,
    }));
    await moveSidebarSectionSession({
      drop: { ...drop, targetContainerId: "pinned" },
      session: nativeSession,
      moveNativeThread,
    });
    expect(commands.setPinned).toHaveBeenCalledWith(nativeSession.id, { pinned: true });
    expect(commands.moveItem).not.toHaveBeenCalled();
    expect(commands.moveSession).not.toHaveBeenCalled();
    expect(moveNativeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContainerId: "project:project-alpha",
        targetContainerId: "pinned",
      }),
    );
  });

  test("inserts into Pinned at a Session boundary while retaining draft and other Project slots", async () => {
    const moveNativeThread = vi.fn(async (_input: SidebarThreadDropRequest) => ({
      operationId: "move-alpha",
      projectionRevision: 5,
    }));
    await moveSidebarSectionSession({
      drop: {
        ...drop,
        targetContainerId: "pinned",
        beforeThreadId: "runtime-root-beta",
        beforeItemId: "session-beta",
      },
      session: nativeSession,
      moveNativeThread,
    });
    expect(moveNativeThread).toHaveBeenCalledWith(
      expect.objectContaining({ beforeThreadId: null, useDefaultOrder: true }),
    );
    expect(commands.setPinned).toHaveBeenCalledWith(nativeSession.id, { pinned: true });
    expect(commands.reorderPinned).toHaveBeenCalledWith("pins:3", [
      "session-draft",
      nativeSession.id,
      "session-beta",
    ]);
  });

  test("surfaces a concurrent Pinned reorder conflict instead of silently accepting the wrong position", async () => {
    commands.reorderPinned.mockRejectedValueOnce(new Error("Pinned order changed"));
    await expect(
      moveSidebarSectionSession({
        drop: { ...drop, targetContainerId: "pinned", beforeItemId: "session-beta" },
        session: nativeSession,
        moveNativeThread: vi.fn(async () => ({ operationId: "move-alpha", projectionRevision: 5 })),
      }),
    ).rejects.toThrow("Pinned order changed");
  });
});
