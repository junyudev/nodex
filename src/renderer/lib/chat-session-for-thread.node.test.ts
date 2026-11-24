import { describe, expect, test } from "vite-plus/test";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import { resolveChatSessionForThreadId } from "./chat-session-for-thread";

interface Session {
  readonly id: string;
  readonly archived: boolean;
  readonly executionRef?: { readonly threadId: string } | null;
  readonly thread?: { readonly threadId: string } | null;
}

const runtimeThreadId = "nodex:thread:root";
const identity = (threadId: string): ConversationIdentity => ({
  execution: "agent-runtime",
  threadId,
  sessionId: "session-runtime",
  title: "Research",
  role: "subagent",
  agent: null,
  archived: false,
  host: null,
});

function ports(
  overrides: Partial<Parameters<typeof resolveChatSessionForThreadId<Session>>[1]> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      knownSessions: [] as Session[],
      readConversationIdentity: async (id: string) => {
        calls.push(`read:${id}`);
        return identity(id);
      },
      resolveSessionById: async (id: string): Promise<Session> => {
        calls.push(`session:${id}`);
        return { id, archived: false, executionRef: { threadId: runtimeThreadId } };
      },
      ensureThreadSession: async (id: string): Promise<Session | null> => {
        calls.push(`ensure:${id}`);
        return { id: "session-native", archived: false, thread: { threadId: id } };
      },
      ...overrides,
    },
  };
}

describe("resolveChatSessionForThreadId", () => {
  test("prefers a known live Session for either execution identity", async () => {
    const known: Session = { id: "known", archived: false, executionRef: { threadId: "t-1" } };
    const { calls, value } = ports({ knownSessions: [known] });

    expect(await resolveChatSessionForThreadId("t-1", value)).toBe(known);
    expect(calls).toEqual([]);
  });

  test.each([
    runtimeThreadId,
    "thread:task:child",
    "thread:provider:codex:native-thread:child",
    "thread:provider:claude:native-thread:child",
    "opaque-child",
  ])("opens %s through the Session its execution owner identifies", async (threadId) => {
    const { calls, value } = ports();

    expect((await resolveChatSessionForThreadId(threadId, value)).id).toBe("session-runtime");
    expect(calls).toEqual([`read:${threadId}`, "session:session-runtime"]);
  });

  test("admits an identified native Codex conversation that has no Session", async () => {
    const { calls, value } = ports({
      readConversationIdentity: async (threadId) => ({
        ...identity(threadId),
        execution: "native-codex",
        executionHostId: "build-box",
        sessionId: null,
      }),
    });

    expect((await resolveChatSessionForThreadId("native-1", value)).id).toBe("session-native");
    expect(calls).toEqual(["ensure:native-1"]);
  });

  test("uses a native conversation's existing Session without admitting it again", async () => {
    const { calls, value } = ports({
      readConversationIdentity: async (threadId) => ({
        ...identity(threadId),
        execution: "native-codex",
        executionHostId: "local",
        sessionId: "existing-native-session",
      }),
    });

    expect((await resolveChatSessionForThreadId("native-1", value)).id).toBe(
      "existing-native-session",
    );
    expect(calls).toEqual(["session:existing-native-session"]);
  });

  test.each([null, { ...identity("archived"), archived: true }])(
    "refuses an unknown or archived conversation without native admission",
    async (unavailable) => {
      const { calls, value } = ports({ readConversationIdentity: async () => unavailable });

      await expect(resolveChatSessionForThreadId("unavailable", value)).rejects.toThrow(
        "This chat is no longer available",
      );
      expect(calls).toEqual([]);
    },
  );

  test("rechecks an owning Session that became archived", async () => {
    const { calls, value } = ports({
      resolveSessionById: async (id) => ({ id, archived: true }),
    });

    await expect(resolveChatSessionForThreadId("thread:task:child", value)).rejects.toThrow(
      "This chat is no longer available",
    );
    expect(calls).toEqual(["read:thread:task:child"]);
  });
});
