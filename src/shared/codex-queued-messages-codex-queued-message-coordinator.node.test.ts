import { expect, test, describe, it, vi } from "vite-plus/test";
import {
  QueuedMessageCoordinator,
  type QueuedMessageCoordinatorClient,
  type QueuedMessageRole,
  type QueuedMessageState,
} from "./codex-queued-message-coordinator";
import { QueuedMessageExecution, type QueueSubmission } from "./codex-queued-message-execution";
import { QueuedMessageLocks } from "./codex-queued-message-locks";
import {
  parseCodexQueuedMessageFollowerRequest,
  parseCodexQueuedMessageFollowerResult,
} from "./codex-queued-message-follower-request";
import { conversationFollowerRequest } from "./codex-thread-follower-request";
import { acceptsCodexPeerRequestVersion, codexPeerRequestVersion } from "./codex-peer-protocol";

describe("codex queued message coordinator", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  function fixture() {
    let state: QueuedMessageState<string> = { thread: ["persisted"] };
    let role: QueuedMessageRole = { role: "owner" };
    const broadcasts: readonly string[][] = [];
    const client: QueuedMessageCoordinatorClient<string> = {
      storage: {
        read: () => ({ isLoading: false, value: state }),
        load: async () => state,
        update: async (recipe) => {
          state = recipe(state);
        },
      },
      role: () => role,
      validate() {},
      requestFollower: async () => {},
      broadcast: async () => {},
      changed() {},
      wake() {},
      error() {},
    };
    const queue = new QueuedMessageCoordinator(client);
    return {
      queue,
      client,
      broadcasts,
      setRole: (next: QueuedMessageRole) => {
        role = next;
      },
      setState: (next: QueuedMessageState<string>) => {
        state = next;
      },
      read: () => state,
      readRole: () => role,
    };
  }
  test("owner FIFO reevaluates each recipe against committed storage rather than optimistic stale state", async () => {
    const f = fixture();
    const gate = deferred<void>();
    const commits: string[][] = [];
    let first = true;
    f.client.storage.update = async (recipe) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      const next = recipe(f.read());
      f.setState(next);
      commits.push([...(next.thread ?? [])]);
    };
    const one = f.queue.update("thread", (messages) => [...messages, "one"]);
    const two = f.queue.update("thread", (messages) => [...messages, "two"]);
    expect(f.queue.readMessages("thread")).toEqual(["persisted", "one", "two"]);
    f.setState({ thread: ["external"] });
    gate.resolve();
    await Promise.all([one, two]);
    expect(commits).toEqual([
      ["external", "one"],
      ["external", "one", "two"],
    ]);
    expect(f.read().thread).toEqual(["external", "one", "two"]);
    f.queue[Symbol.dispose]();
  });
  test("shutdown drains optimistic queue edits through the final storage write", async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.client.storage.update = async (recipe) => {
      await gate.promise;
      f.setState(recipe(f.read()));
    };
    f.queue.mutate("thread", () => ["paused"]);
    let drained = false;
    const flush = f.queue.flushPendingWrites().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(f.read().thread).toEqual(["persisted"]);
    f.queue.mutate("thread", (messages) => [...messages, "second"]);
    gate.resolve();
    await flush;
    expect(drained).toBe(true);
    expect(f.read().thread).toEqual(["paused", "second"]);
    f.queue[Symbol.dispose]();
  });

  test("follower buffers owner broadcasts during writes and reconciles only its current owner", async () => {
    const f = fixture();
    f.setRole({ role: "follower", ownerClientId: "owner-a" });
    const gate = deferred<void>();
    f.client.requestFollower = () => gate.promise;
    const write = f.queue.update("thread", () => ["local"]);
    await Promise.resolve();
    f.queue.receiveBroadcast("wrong-owner", "thread", ["wrong"]);
    f.queue.receiveBroadcast("owner-a", "thread", ["committed"]);
    expect(f.queue.readMessages("thread")).toEqual(["local"]);
    gate.resolve();
    await write;
    expect(f.queue.readMessages("thread")).toEqual(["committed"]);
    expect(f.read().thread).toEqual(["persisted"]);
    f.queue[Symbol.dispose]();
  });
  test("failed owner admission rolls back the optimistic overlay and does not poison the FIFO", async () => {
    const f = fixture();
    f.setRole({ role: "follower", ownerClientId: "elsewhere" });
    await expect(f.queue.acceptFromFollower("thread", ["rejected"])).rejects.toThrow(
      "no longer owns",
    );
    expect(f.queue.readMessages("thread")).toEqual(["persisted"]);
    f.setRole({ role: "owner" });
    await f.queue.acceptFromFollower("thread", ["accepted"]);
    expect(f.read().thread).toEqual(["accepted"]);
    f.queue[Symbol.dispose]();
  });
  test("execution wakes do not invalidate an in-flight storage refresh", async () => {
    const f = fixture();
    f.setRole({ role: "follower", ownerClientId: "owner" });
    f.queue.receiveBroadcast("owner", "thread", ["old"]);
    f.setRole({ role: "owner" });
    const loaded = deferred<QueuedMessageState<string>>();
    let loads = 0;
    f.client.storage.load = () => {
      loads++;
      return loaded.promise;
    };
    f.queue.storageChanged();
    expect(f.queue.isRefreshing("thread")).toBe(true);
    f.queue.requestExecutionWake();
    f.queue.requestExecutionWake();
    loaded.resolve({ thread: ["fresh"] });
    await loaded.promise;
    await Promise.resolve();
    expect(f.queue.readMessages("thread")).toEqual(["fresh"]);
    expect(f.queue.isRefreshing("thread")).toBe(false);
    expect(loads).toBe(1);
    f.queue[Symbol.dispose]();
  });

  test("owner receipt cleanup cannot forward a stale automatic mutation after becoming a follower", async () => {
    const f = fixture();
    let forwarded = false;
    f.client.requestFollower = async () => {
      forwarded = true;
    };
    const cleanup = f.queue.updateAsOwner("thread", () => []);
    f.setRole({ role: "follower", ownerClientId: "new-owner" });
    await expect(cleanup).rejects.toThrow("no longer owns");
    expect(forwarded).toBe(false);
    expect(f.read().thread).toEqual(["persisted"]);
    f.queue[Symbol.dispose]();
  });

  test.each(["follower", "disposed", "replacement-owner"] as const)(
    "owner receipt cleanup rejects %s while storage is waiting for its read/lock",
    async (transition) => {
      const f = fixture();
      if (transition === "replacement-owner") {
        f.client.captureOwnerWrite = () => {
          const admitted = f.readRole();
          return {
            assertCurrent: () => {
              if (f.readRole() !== admitted)
                throw new Error("This window no longer owns the admitted thread incarnation");
            },
            [Symbol.dispose]: () => {},
          };
        };
      }
      const entered = deferred<void>();
      const release = deferred<void>();
      let writes = 0;
      f.client.storage.update = async (recipe) => {
        entered.resolve();
        await release.promise;
        const next = recipe(f.read());
        writes++;
        f.setState(next);
      };
      const cleanup = f.queue.updateAsOwner("thread", () => []);
      const rejected = expect(cleanup).rejects.toThrow(
        transition === "disposed" ? "retired" : "no longer owns",
      );
      await entered.promise;
      f.setState({ thread: ["new-owner-input"] });
      if (transition === "disposed") f.queue[Symbol.dispose]();
      else {
        f.setRole({ role: "follower", ownerClientId: "new-owner" });
        if (transition === "replacement-owner") f.setRole({ role: "owner" });
      }
      release.resolve();
      await rejected;
      expect(writes).toBe(0);
      expect(f.read().thread).toEqual(["new-owner-input"]);
      f.queue[Symbol.dispose]();
    },
  );

  test("a committed owner write cannot acknowledge or broadcast under its replacement", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const commit = deferred<void>();
    const broadcast = [] as Array<readonly string[]>;
    let disposals = 0;
    f.client.captureOwnerWrite = () => {
      const admitted = f.readRole();
      return {
        assertCurrent: () => {
          if (f.readRole() !== admitted) throw new Error("Owner incarnation changed");
        },
        [Symbol.dispose]: () => {
          disposals++;
        },
      };
    };
    f.client.broadcast = async (_id, messages) => {
      broadcast.push(messages);
    };
    f.client.storage.update = async (recipe) => {
      f.setState(recipe(f.read()));
      entered.resolve();
      await commit.promise;
    };
    const write = f.queue.updateAsOwner("thread", () => ["committed input"]);
    const rejection = expect(write).rejects.toThrow("Owner incarnation changed");
    await entered.promise;
    f.setRole({ role: "follower", ownerClientId: "new-owner" });
    f.setRole({ role: "owner" });
    commit.resolve();
    await rejection;
    expect(f.read().thread).toEqual(["committed input"]);
    expect(broadcast).toEqual([]);
    expect(disposals).toBe(1);
    f.queue[Symbol.dispose]();
  });
});

describe("codex queued message execution", () => {
  type Message = { id: string; pausedReason?: string | null };
  type Resume = {
    conversationId: string;
    serviceTier?: string;
    workspaceRoots?: readonly string[];

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
      update: async (
        recipe: (value: QueuedMessageState<Message>) => QueuedMessageState<Message>,
      ) => {
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
});

describe("queued message follower controls", () => {
  test("preserves the exact targeted identity through typed framing on local and qualified hosts", () => {
    const params = { conversationId: "thread", messageId: "native-message" };
    const request = conversationFollowerRequest("thread-follower-remove-queued-message", params);
    expect(parseCodexQueuedMessageFollowerRequest(request.method, request.params).params).toBe(
      params,
    );
    for (const hostId of [undefined, "remote-a"]) {
      const version = codexPeerRequestVersion(request.method, params, hostId);
      expect(version).toBe(hostId === undefined ? 1 : 2);
      expect(
        acceptsCodexPeerRequestVersion({
          type: "request",
          requestId: "request",
          sourceClientId: "follower",
          method: request.method,
          params,
          version,
          hostId,
        }),
      ).toBe(true);
    }
    const clear = conversationFollowerRequest("thread-follower-clear-queued-messages", {
      conversationId: "thread",
    });
    expect(parseCodexQueuedMessageFollowerRequest(clear.method, clear.params)).toEqual(clear);
  });

  test("rejects missing target identities and never admits native enqueue or reorder through this grammar", () => {
    for (const params of [null, [], {}, { conversationId: " " }, { conversationId: "thread" }])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest("thread-follower-remove-queued-message", params),
      ).toThrow();
    for (const messageId of [null, false, 1, "", " "])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest("thread-follower-remove-queued-message", {
          conversationId: "thread",
          messageId,
        }),
      ).toThrow();
    for (const method of ["thread/queue/add", "thread/queue/reorder", "thread-follower-enqueue"])
      expect(() =>
        parseCodexQueuedMessageFollowerRequest(method, { conversationId: "thread" }),
      ).toThrow();
  });

  test("requires a semantic result even when the transport reports success", () => {
    expect(parseCodexQueuedMessageFollowerResult({ applied: false })).toEqual({ applied: false });
    const applied = { applied: true };
    expect(parseCodexQueuedMessageFollowerResult(applied)).toBe(applied);
    for (const value of [undefined, null, [], {}, { ok: true }, { applied: "true" }])
      expect(() => parseCodexQueuedMessageFollowerResult(value)).toThrow();
  });
});

describe("codex queued message locks", () => {
  it("recovers expired sends without allowing a stale release to unlock the replacement", () => {
    let now = 0;
    const locks = new QueuedMessageLocks(() => now);
    const first = { conversationId: "thread", messageId: "message", lockId: "first" };
    const second = { ...first, lockId: "second" };
    expect(locks.tryAcquire(first)).toBe(true);
    expect(locks.tryAcquire(second)).toBe(false);
    now = 120_000;
    expect(locks.tryAcquire(second)).toBe(true);
    locks.release({ ...first, sent: false });
    expect(locks.tryAcquire({ ...first, messageId: "another" })).toBe(false);
    locks.release({ ...second, sent: true });
    expect(locks.tryAcquire(first)).toBe(false);
    expect(locks.tryAcquire({ ...first, messageId: "another" })).toBe(true);
    now += 600_000;
    expect(locks.tryAcquire(first)).toBe(true);
  });

  it("native acceptance survives a failed lease release without unlocking its active send", () => {
    let now = 0;
    const locks = new QueuedMessageLocks(() => now);
    const first = { conversationId: "thread", messageId: "message", lockId: "first" };
    expect(locks.tryAcquire(first)).toBe(true);
    locks.recordAccepted(first);
    expect(locks.tryAcquire({ ...first, messageId: "another", lockId: "second" })).toBe(false);
    locks.release({ ...first, sent: false });
    expect(locks.tryAcquire({ ...first, lockId: "retry" })).toBe(false);
    const another = { ...first, messageId: "another", lockId: "second" };
    expect(locks.tryAcquire(another)).toBe(true);
    locks.release({ ...another, sent: false });
    now = 600_000;
    expect(locks.tryAcquire({ ...first, lockId: "after-expiry" })).toBe(true);
  });
});
