import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CodexCanonicalConversationState } from "./types";
import { ConversationStreamRecovery } from "./codex-conversation-recovery";

type Conversation = {
  -readonly [Key in "id" | "resumeState"]: CodexCanonicalConversationState[Key];
};
type Attempt = { id: string; resolve(): void; reject(error: unknown): void };

function fixture(ids: string[]) {
  const conversations = new Map<string, Conversation>(
    ids.map((id) => [id, { id, resumeState: "resumed" }]),
  );
  const owners = new Set(ids);
  const suppressed = new Set<string>();
  const inFlight = new Map<string, Attempt>();
  const attempts: Attempt[] = [];
  const resets: string[] = [];
  const errors: unknown[] = [];
  let disposed = false;
  const resume = (conversation: Conversation) => {
    let ready = false;
    let error: unknown;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const attempt: Attempt = { id: conversation.id, resolve, reject };
    attempts.push(attempt);
    inFlight.set(conversation.id, attempt);
    conversation.resumeState = "resuming";
    return pending
      .then(() => {
        ready = true;
      })
      .catch((cause: unknown) => {
        error = cause;
        throw cause;
      })
      .finally(() => {
        if (inFlight.get(conversation.id) !== attempt) return;
        conversation.resumeState = ready ? "resumed" : "needs_resume";
        recovery.onResumeAttemptSettled(conversation.id, ready, error);
        inFlight.delete(conversation.id);
      });
  };
  const recovery = new ConversationStreamRecovery<Conversation>({
    conversations: () => conversations.values(),
    getConversation: (id) => conversations.get(id),
    streamingConversationIds: () => [...conversations.keys()],
    ownsHistory: (id) => owners.has(id),
    hasResumeInFlight: (id) => inFlight.has(id),
    isSuppressed: (id) => suppressed.has(id),
    isDisposed: () => disposed,
    cancelResumes: () => {
      inFlight.clear();
      resets.push("resumes");
    },
    resetHistory: () => {
      resets.push("history");
    },
    resetStreams: (preserve) => {
      if (!preserve) owners.clear();
      resets.push("streams");
    },
    markNeedsResume: (id) => {
      conversations.get(id)!.resumeState = "needs_resume";
    },
    resume,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
    onError: (_id, error) => {
      errors.push(error);
    },
  });
  return {
    recovery,
    conversations,
    owners,
    suppressed,
    attempts,
    inFlight,
    resets,
    errors,
    resume,
    dispose: () => {
      disposed = true;
      recovery.dispose();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

test("restores only owners with at most two concurrent resumes and releases a slot on settlement", async () => {
  const f = fixture(["a", "b", "c", "follower"]);
  f.owners.delete("follower");
  f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
  await flush();
  expect(f.attempts.map((attempt) => attempt.id)).toEqual(["a", "b"]);
  expect(f.conversations.get("follower")?.resumeState).toBe("needs_resume");
  expect(f.resets).toEqual(["resumes", "history", "streams"]);
  f.attempts[0]!.reject(new Error("offline"));
  await flush();
  expect(f.attempts.map((attempt) => attempt.id)).toEqual(["a", "b", "c"]);
  expect(f.errors).toHaveLength(1);
  f.attempts[1]!.resolve();
  f.attempts[2]!.resolve();
  await flush();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(f.attempts).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.attempts[3]?.id).toBe("a");
  f.dispose();
});

test("ordinary restart invalidates history and roles without automatically acquiring streams", async () => {
  const f = fixture(["a", "b"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.owners.size).toBe(0);
  expect([...f.conversations.values()].map((c) => c.resumeState)).toEqual([
    "needs_resume",
    "needs_resume",
  ]);
  expect(f.attempts).toEqual([]);
  f.dispose();
});

test("foreground has a ten-second fallback while other streams restore immediately", async () => {
  const f = fixture(["foreground", "other"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({
    restoreStreams: true,
    foregroundConversationId: "foreground",
  });
  await flush();
  expect(f.attempts.map((a) => a.id)).toEqual(["other"]);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.attempts.map((a) => a.id)).toEqual(["other", "foreground"]);
  f.dispose();
});

test("a successful foreground view resume cancels its fallback without another native request", async () => {
  const f = fixture(["foreground"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({
    restoreStreams: true,
    foregroundConversationId: "foreground",
  });
  const view = f.resume(f.conversations.get("foreground")!);
  f.attempts[0]!.resolve();
  await view;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.attempts).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  f.dispose();
});

test("transient recovery failures back off from two seconds and cap at sixty seconds", async () => {
  const f = fixture(["a"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
  await flush();
  for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
    const count = f.attempts.length;
    f.attempts.at(-1)!.reject(new Error("temporary disconnect"));
    await flush();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.attempts).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts).toHaveLength(count + 1);
  }
  f.attempts.at(-1)!.resolve();
  await flush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.attempts).toHaveLength(8);
  f.dispose();
});

test.each([
  new Error("thread not found: a"),
  new Error("THREAD NOT LOADED: a"),
  new Error("no rollout found for thread id a"),
  new Error("invalid thread id: a"),
  Object.assign(new Error("missing"), { code: "thread_not_found" }),
  Object.assign(new Error("missing"), { jsonRpcCode: "thread_not_found" }),
])(
  "requires two confirmed missing-thread failures before abandoning recovery: %s",
  async (error) => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    f.attempts[0]!.reject(error);
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.attempts).toHaveLength(2);
    f.attempts[1]!.reject(error);
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  },
);

test.each([new Error("file not found"), { code: "thread_not_found", message: "missing" }])(
  "does not mistake another lookup failure or a plain object for confirmed missing history: %s",
  async (error) => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    f.attempts[0]!.reject(error);
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.attempts).toHaveLength(2);
    f.dispose();
  },
);

test("a different error between missing results requires another missing confirmation", async () => {
  const f = fixture(["a"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
  await flush();
  for (const error of [
    new Error("thread not found: a"),
    new Error("offline"),
    new Error("thread not found: a"),
  ]) {
    const count = f.attempts.length;
    f.attempts.at(-1)!.reject(error);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.attempts).toHaveLength(count + 1);
  }
  f.dispose();
});

test.each(["archive", "owner-loss", "removal", "writer", "local-writer"])(
  "stops retrying when the conversation becomes ineligible: %s",
  async (reason) => {
    const f = fixture(["a"]);
    f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
    await flush();
    if (reason === "archive") f.suppressed.add("a");
    if (reason === "owner-loss") f.owners.delete("a");
    if (reason === "removal") f.conversations.delete("a");
    f.attempts[0]!.reject(
      new Error(
        reason === "writer"
          ? "Thread already has an active writer"
          : reason === "local-writer"
            ? "Thread already has a live local writer"
            : "offline",
      ),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  },
);

test("old-generation settlements cannot consume or release the new generation's two slots", async () => {
  const f = fixture(["a", "b", "c"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
  await flush();
  const old = f.attempts.slice();
  f.recovery.markAllConversationsNeedResumeAfterReconnect({ restoreStreams: true });
  await flush();
  expect(f.attempts.map((a) => a.id)).toEqual(["a", "b", "a", "b"]);
  old[0]!.resolve();
  old[1]!.reject(new Error("old connection"));
  await flush();
  expect(f.attempts).toHaveLength(4);
  expect(f.errors).toHaveLength(0);
  f.attempts[2]!.resolve();
  await flush();
  expect(f.attempts[4]?.id).toBe("c");
  f.dispose();
});

test("fallback joins the in-flight view's eventual result and disposal cancels its retries", async () => {
  const f = fixture(["a"]);
  f.recovery.markAllConversationsNeedResumeAfterReconnect({
    restoreStreams: true,
    foregroundConversationId: "a",
  });
  const view = f.resume(f.conversations.get("a")!).catch(() => {});
  // The timer is allowed to observe needs_resume while another source is still doing preparation.
  f.conversations.get("a")!.resumeState = "needs_resume";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.attempts).toHaveLength(1);
  f.attempts[0]!.reject(new Error("offline"));
  await view;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.attempts).toHaveLength(2);
  f.attempts[1]!.reject(new Error("offline"));
  await flush();
  f.dispose();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.attempts).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
