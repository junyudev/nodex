import { describe, expect, test } from "vite-plus/test";
import { resolveChatSessionForThreadId } from "./chat-session-for-thread";

interface Session {
  readonly id: string;
  readonly archived: boolean;
  readonly executionRef?: { readonly threadId: string } | null;
  readonly thread?: { readonly threadId: string } | null;
}

const runtimeThreadId =
  "nodex:thread:6d6c200f396dbc87ece0a38200ab03e7d6e7cadbb14568f0c02f8996ae2bec9c";

function ports(
  overrides: Partial<Parameters<typeof resolveChatSessionForThreadId<Session>>[1]> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      knownSessions: [] as Session[],
      readAgentThreadSessionId: async (id: string) => {
        calls.push(`read:${id}`);
        return "session-runtime";
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

  test("finds an Agent Runtime Thread's own Session instead of admitting it as native", async () => {
    const { calls, value } = ports();

    const session = await resolveChatSessionForThreadId(runtimeThreadId, value);

    expect(session.id).toBe("session-runtime");
    expect(calls).toEqual([`read:${runtimeThreadId}`, "session:session-runtime"]);
  });

  test("admits a native Thread and refuses one that is gone", async () => {
    const admitted = ports();
    expect((await resolveChatSessionForThreadId("native-1", admitted.value)).id).toBe(
      "session-native",
    );
    expect(admitted.calls).toEqual(["ensure:native-1"]);

    const gone = ports({ ensureThreadSession: async () => null });
    await expect(resolveChatSessionForThreadId("native-2", gone.value)).rejects.toThrow(
      "This chat is no longer available",
    );
  });
});
