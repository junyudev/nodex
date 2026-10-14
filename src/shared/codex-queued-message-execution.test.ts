import { expect, it, vi } from "vitest";
import {
  QueuedMessageCoordinator,
  type QueuedMessageState,
} from "./codex-queued-message-coordinator";
import { QueuedMessageExecution, type QueueSubmission } from "./codex-queued-message-execution";
import { QueuedMessageLocks } from "./codex-queued-message-locks";
type Message = { id: string; pausedReason?: string | null };
type Resume = {
  conversationId: string;
  serviceTier?: string;
  workspaceRoots?: readonly string[];
  useAppServerPermissionDefault?: boolean;
  collaborationMode?: string;
};
type Submission = QueueSubmission<Resume, string, string>;
function fixture(
  options: {
    loading?: Promise<QueuedMessageState<Message>>;
    autoWake?: boolean;
    canSend?: boolean;
    startLocks?: QueuedMessageLocks;
    sendLocks?: QueuedMessageLocks;
    selectAutomaticMessage?: (messages: readonly Message[]) => Message | undefined;
  } = {},
) {
  let state: QueuedMessageState<Message> = { thread: [{ id: "message" }] };
  let loading = options.loading != null;
  let execution: QueuedMessageExecution<Message, { conversationId: string }, string, string>;
  const storage = {
    read: () => ({ isLoading: loading, value: loading ? undefined : state }),
    load: vi.fn(async () => {
      if (options.loading) state = await options.loading;
      loading = false;
      return state;
    }),
    update: async (recipe: (value: QueuedMessageState<Message>) => QueuedMessageState<Message>) => {
      state = recipe(state);
    },
  };
  const coordinator = new QueuedMessageCoordinator<Message>({
    storage,
    role: () => ({ role: "owner" }),
    validate: () => {},
    requestFollower: async () => {},
    broadcast: async () => {},
    changed: () => {},
    wake: (id) => {
      if (options.autoWake) execution?.wake(id);
    },
    error: () => {},
  });
  let active: string | null = "active";
  let needsResume = false;
  const prepare = vi.fn(async (_id: string, _message: Message, mode: "start" | "steer") => ({
    status: "ready" as const,
    submission: {
      conversationId: "thread",
      resume: { conversationId: "thread" },
      steer: "steer",
      ...(mode === "start" ? { start: "start" } : {}),
    } satisfies Submission,
  }));
  const release = vi.fn(async (_sent: boolean) => {});
  const start = vi.fn(async () => "new-turn");
  const resume = vi.fn(async (_input: Resume) => ({
    status: "ready" as const,
    activeTurnId: null,
  }));
  const steer = vi.fn(async () => {
    throw new Error("Turn ended");
  });
  const result = vi.fn();
  execution = new QueuedMessageExecution({
    coordinator,
    role: () => ({ role: "owner" }),
    canSend: () => options.canSend ?? true,
    selectAutomaticMessage: options.selectAutomaticMessage,
    validate: () => {},
    error: () => {},
    runtime: {
      prepare,
      isClientReady: () => true,
      canAcquireOwnership: () => true,
      tryAcquireStartTurn: (id) => options.startLocks?.tryAcquireStartTurn(id) ?? true,
      releaseStartTurn: (id) => options.startLocks?.releaseStartTurn(id),
      acquireSendLock: async (conversationId, messageId) => {
        const identity = { conversationId, messageId, lockId: "test-lock" };
        if (options.sendLocks && !options.sendLocks.tryAcquire(identity)) return null;
        return {
          release: async (sent) => {
            await release(sent);
            options.sendLocks?.release({ ...identity, sent });
          },
        };
      },
      errorReason: () => "failed",
      onResult: result,
    },
    submissionHost: {
      needsResume: () => needsResume,
      resume,
      getActiveTurnId: () => active,
      hasPendingTurnStart: () => false,
      start,
      steer,
      canStartAfterSteerError: () => true,
      isNoActiveTurnError: () => false,
    },
  });
  return {
    execution,
    coordinator,
    prepare,
    start,
    steer,
    resume,
    release,
    result,
    storage,
    setState: (next: QueuedMessageState<Message>) => {
      state = next;
    },
    setActive: (value: string | null) => {
      active = value;
    },
    setNeedsResume: (value: boolean) => {
      needsResume = value;
    },
  };
}
it("manual send reparses for start after the observed active turn ends, then removes only the sent message", async () => {
  const f = fixture();
  await f.execution.sendNow("thread", "message");
  expect(f.prepare.mock.calls.map((call) => call[2])).toEqual(["steer", "start"]);
  expect(f.steer).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledWith(true);
  expect(f.result).toHaveBeenCalledWith(
    "thread",
    { id: "message" },
    { status: "sent", kind: "start", turnId: "new-turn" },
  );
  expect(f.coordinator.readMessages("thread")).toEqual([]);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("prepared external send uses the same steer fallback without mutating the persisted queue", async () => {
  const f = fixture({ canSend: false });
  const message = { id: "server-message" };
  const result = await f.execution.sendPreparedNow("thread", message, { prepare: f.prepare });
  expect(result).toEqual({ status: "sent", turnId: "new-turn" });
  expect(f.prepare.mock.calls.map((call) => call[2])).toEqual(["steer", "start"]);
  expect(f.steer).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("prepared external send respects requires-idle while a turn is active", async () => {
  const f = fixture();
  const prepare = vi.fn(async () => ({
    status: "ready" as const,
    submission: {
      conversationId: "thread",
      resume: { conversationId: "thread" },
      steer: "steer",
      requiresIdle: true,
    } satisfies Submission,
  }));
  await expect(
    f.execution.sendPreparedNow("thread", { id: "server-message" }, { prepare }),
  ).rejects.toThrow("Explicit message submission was not sent");
  expect(f.steer).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("captured submission returns a requires-idle deferral without inventing a queue row", async () => {
  const f = fixture();
  const message = { id: "captured-input" };
  const before = f.coordinator.readMessages("thread");
  const prepare = vi.fn(async () => ({
    status: "ready" as const,
    submission: {
      conversationId: "thread",
      resume: { conversationId: "thread" },
      steer: "steer",
      requiresIdle: true,
    } satisfies Submission,
  }));
  try {
    expect(await f.execution.submitCapturedNow("thread", message, { prepare })).toEqual({
      status: "deferred",
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith("thread", message, "steer");
    expect(f.coordinator.readMessages("thread")).toBe(before);
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});

it("manual send loads storage and reserves execution before automatic wake captures the head", async () => {
  let finish!: (state: QueuedMessageState<Message>) => void;
  const loading = new Promise<QueuedMessageState<Message>>((resolve) => {
    finish = resolve;
  });
  const f = fixture({ loading, autoWake: true });
  f.setActive(null);
  const send = f.execution.sendNow("thread", "later");
  await Promise.resolve();
  expect(f.prepare).not.toHaveBeenCalled();
  finish({ thread: [{ id: "head", pausedReason: "failed" }, { id: "later" }] });
  await send;
  expect(f.prepare.mock.calls.map((call) => [call[1].id, call[2]])).toEqual([
    ["later", "steer"],
    ["later", "start"],
  ]);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.coordinator.readMessages("thread")).toEqual([{ id: "head", pausedReason: "failed" }]);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("manual send captures the refreshed message and waits through a superseding refresh", async () => {
  const f = fixture();
  f.setActive(null);
  await f.coordinator.update("thread", (messages) => [...messages]);
  await f.coordinator.waitForRefresh();
  let first!: (value: QueuedMessageState<Message>) => void;
  let second!: (value: QueuedMessageState<Message>) => void;
  f.storage.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
  );
  f.storage.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        second = resolve;
      }),
  );
  f.coordinator.storageChanged();
  const send = f.execution.sendNow("thread", "message");
  f.coordinator.storageChanged();
  first({ thread: [{ id: "discarded" }] });
  await vi.waitFor(() => expect(second).toBeDefined());
  expect(f.prepare).not.toHaveBeenCalled();
  const replacement = { id: "message", pausedReason: "retry this failure" };
  f.setState({ thread: [replacement] });
  second({ thread: [replacement] });
  await send;
  expect(f.prepare.mock.calls[0]?.[1]).toBe(replacement);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.coordinator.readMessages("thread")).toEqual([]);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("retiring execution during storage load rejects the explicit send without dispatch", async () => {
  let finish!: (state: QueuedMessageState<Message>) => void;
  const f = fixture({
    loading: new Promise((resolve) => {
      finish = resolve;
    }),
  });
  const send = f.execution.sendNow("thread", "message");
  const rejected = expect(send).rejects.toThrow("execution is unavailable");
  f.execution[Symbol.dispose]();
  finish({ thread: [{ id: "message" }] });
  await rejected;
  expect(f.start).not.toHaveBeenCalled();
  expect(f.steer).not.toHaveBeenCalled();
  f.coordinator[Symbol.dispose]();
});
it("automatic execution defers while a turn is active and retains the captured message", async () => {
  const f = fixture();
  f.execution.wake("thread");
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledWith(false));
  expect(f.start).not.toHaveBeenCalled();
  expect(f.steer).not.toHaveBeenCalled();
  expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});
it("a changed queue identity during preparation prevents submission", async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.prepare.mockImplementationOnce(async () => {
    await pending;
    return {
      status: "ready",
      submission: {
        conversationId: "thread",
        resume: { conversationId: "thread" },
        steer: "steer",
        start: "start",
      },
    };
  });
  const send = f.execution.sendNow("thread", "message");
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled());
  await f.coordinator.update("thread", () => [{ id: "replacement" }]);
  finish();
  await send;
  expect(f.start).not.toHaveBeenCalled();
  expect(f.steer).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledWith(false);
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("retains the prepared resume input unchanged when resume becomes necessary before admission", async () => {
  const f = fixture();
  f.setActive(null);
  const retainedResume: Resume = {
    conversationId: "thread",
    serviceTier: "fast",
    workspaceRoots: ["/captured-root"],
    useAppServerPermissionDefault: false,
    collaborationMode: "plan",
  };
  f.prepare.mockImplementationOnce(async () => {
    f.setNeedsResume(true);
    return {
      status: "ready",
      submission: {
        conversationId: "thread",
        resume: retainedResume,
        steer: "steer",
        start: "start",
      },
    };
  });
  await f.execution.sendNow("thread", "message");
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledWith(retainedResume, false);
  expect(f.start).toHaveBeenCalledOnce();
  f.execution[Symbol.dispose]();
  f.coordinator[Symbol.dispose]();
});

it("native and local sends share one admission without consuming the local message", async () => {
  const f = fixture({ startLocks: new QueuedMessageLocks() });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async () => {
    await held;
    return { status: "sent" as const };
  });
  try {
    const native = f.execution.sendExternalNow("thread", "native", send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await f.execution.sendNow("thread", "message");
    expect(f.prepare).not.toHaveBeenCalled();
    release();
    expect(await native).toEqual({ status: "sent" });
    expect(f.release).toHaveBeenCalledWith(true);
    expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
    await f.execution.sendNow("thread", "message");
    expect(f.prepare).toHaveBeenCalled();
  } finally {
    release();
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});
it("failed native send releases admission without pausing or deleting captured local input", async () => {
  const f = fixture({ startLocks: new QueuedMessageLocks() });
  try {
    await expect(
      f.execution.sendExternalNow("thread", "native", async () => {
        throw new Error("unknown native delivery");
      }),
    ).rejects.toThrow("unknown native delivery");
    expect(f.release).toHaveBeenCalledWith(false);
    expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
  } finally {
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});

it("native acceptance keeps the shared sent tombstone even when later cleanup fails", async () => {
  const f = fixture({ sendLocks: new QueuedMessageLocks() });
  const send = vi.fn(async (accepted: () => void) => {
    accepted();
    throw new Error("Cleanup failed after native acceptance");
  });
  try {
    await expect(f.execution.sendExternalNow("thread", "native", send)).rejects.toThrow(
      "Cleanup failed",
    );
    expect(f.release).toHaveBeenCalledWith(true);
    expect(await f.execution.sendExternalNow("thread", "native", send)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
  } finally {
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});

it("an unresolved automatic candidate blocks later pending rows after a reorder", async () => {
  const f = fixture({
    selectAutomaticMessage: (messages) =>
      messages.find((message) => message.id === "unresolved") ?? messages[0],
  });
  try {
    f.setState({
      thread: [{ id: "pending" }, { id: "unresolved", pausedReason: "Delivery outcome unknown" }],
    });
    f.execution.wake("thread");
    await Promise.resolve();
    expect(f.prepare).not.toHaveBeenCalled();
    await f.execution.sendNow("thread", "pending");
    expect(f.prepare.mock.calls.map((call) => call[1].id)).toEqual(["pending", "pending"]);
    expect(f.coordinator.readMessages("thread")).toEqual([
      { id: "unresolved", pausedReason: "Delivery outcome unknown" },
    ]);
  } finally {
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});

it("native prepared delivery does not dispatch after its captured caller retires", async () => {
  const f = fixture();
  let admitted = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.prepare.mockImplementationOnce(async () => {
    await held;
    return {
      status: "ready",
      submission: {
        conversationId: "thread",
        resume: { conversationId: "thread" },
        start: "start",
        steer: "steer",
      },
    };
  });
  const send = f.execution.sendPreparedNow(
    "thread",
    { id: "native" },
    { prepare: f.prepare, isCurrent: () => admitted },
  );
  const rejected = expect(send).rejects.toThrow("not sent");
  try {
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    admitted = false;
    release();
    await rejected;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.coordinator.readMessages("thread")).toEqual([{ id: "message" }]);
  } finally {
    release();
    f.execution[Symbol.dispose]();
    f.coordinator[Symbol.dispose]();
  }
});
