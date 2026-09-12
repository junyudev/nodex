import type { CodexRendererRequestCaller } from "../../../shared/codex-renderer-request";
import { afterEach, expect, it, vi } from "vitest";
import { RendererAppServerRequestClient } from "./renderer-app-server-request-client";

afterEach(() => vi.useRealTimers());

it("preserves the distinction between numeric and string delivery identities", async () => {
  using client = new RendererAppServerRequestClient(async () => {});
  const unknown = vi.fn();
  let finish!: (value: string) => void;
  const result = client.send(
    "turn/start",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    {
      requestId: "0",
      onOutcomeUnknown: unknown,
    },
  );
  client.onDelivery({
    type: "outcome-unknown",
    delivery: { requestId: 0, method: "turn/start", stage: "outcome-unknown" },
  });
  client.onDelivery({
    type: "failed",
    delivery: { requestId: 0, method: "turn/start", stage: "not-sent" },
    message: "Other request",
  });
  expect(unknown).not.toHaveBeenCalled();
  client.onDelivery({
    type: "outcome-unknown",
    delivery: { requestId: "0", method: "turn/start", stage: "outcome-unknown" },
  });
  expect(unknown).toHaveBeenCalledOnce();
  finish("accepted");
  await expect(result).resolves.toBe("accepted");
});

for (const hostFirst of [true, false]) {
  it(`deduplicates local and host uncertainty while retaining the native outcome: ${hostFirst}`, async () => {
    vi.useFakeTimers();
    const unknown = vi.fn();
    const abandon = vi.fn(async () => {});
    using client = new RendererAppServerRequestClient(abandon);
    let accept!: (value: string) => void;
    const result = client.send(
      "thread/inject_items",
      () =>
        new Promise<string>((resolve) => {
          accept = resolve;
        }),
      { requestId: "injection", timeoutMs: 30, onOutcomeUnknown: unknown },
    );
    const update = {
      type: "outcome-unknown",
      delivery: { requestId: "injection", method: "thread/inject_items", stage: "outcome-unknown" },
    } as const;
    if (!hostFirst) await vi.advanceTimersByTimeAsync(30);
    client.onDelivery(update);
    client.onDelivery(update);
    await vi.advanceTimersByTimeAsync(30);
    expect(unknown).toHaveBeenCalledExactlyOnceWith(update.delivery);
    expect(abandon).toHaveBeenCalledTimes(hostFirst ? 0 : 1);
    accept("injected");
    await expect(result).resolves.toBe("injected");
  });
}

for (const stage of ["not-sent", "outcome-unknown"] as const) {
  it(`settles terminal host delivery and ignores a late response: ${stage}`, async () => {
    vi.useFakeTimers();
    using client = new RendererAppServerRequestClient(async () => {});
    const unknown = vi.fn();
    let accept!: (value: string) => void;
    const result = client.send(
      "turn/start",
      () =>
        new Promise<string>((resolve) => {
          accept = resolve;
        }),
      { requestId: "start", timeoutMs: 30, onOutcomeUnknown: unknown },
    );
    const rejected = expect(result).rejects.toMatchObject({
      delivery: { requestId: "start", method: "turn/start", stage },
      message: "Native lifetime ended",
    });
    client.onDelivery({
      type: "failed",
      delivery: { requestId: "start", method: "turn/start", stage },
      message: "Native lifetime ended",
    });
    await rejected;
    accept("late");
    await vi.advanceTimersByTimeAsync(60);
    expect(unknown).not.toHaveBeenCalled();
    await expect(
      client.send("turn/start", async () => "new", { requestId: "start" }),
    ).resolves.toBe("new");
  });
}

it("defaults plugin listing to 30 seconds while preserving an explicit disabled deadline", async () => {
  vi.useFakeTimers();
  const abandon = vi.fn(async () => {});
  using client = new RendererAppServerRequestClient(abandon);
  const pending = client.send("plugin/list", async (caller) => {
    expect(caller.timeoutMs).toBe(30_000);
    return new Promise<never>(() => {});
  });
  const rejected = expect(pending).rejects.toThrow("Timeout");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  await expect(
    client.send(
      "plugin/list",
      async (caller) => {
        expect(caller.timeoutMs).toBe(0);
        expect(caller.expiresAtMs).toBeNull();
        return "without deadline";
      },
      { timeoutMs: 0 },
    ),
  ).resolves.toBe("without deadline");
});

it("starts caller deadline before dispatch and abandons a timed out request", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const abandon = vi.fn(async () => {});
  const client = new RendererAppServerRequestClient(abandon);
  const dispatch = vi.fn((_caller: CodexRendererRequestCaller) => new Promise<never>(() => {}));
  const pending = client.send("thread/resume", dispatch, { timeoutMs: 50 });
  const rejected = expect(pending).rejects.toThrow("Timeout");
  await Promise.resolve();
  const caller = dispatch.mock.calls[0]?.[0];
  expect(caller).toMatchObject({ timeoutMs: 50, expiresAtMs: 1050 });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(abandon).toHaveBeenCalledWith(expect.stringMatching(/^thread\/resume:/), "timeout");
  client[Symbol.dispose]();
});

it("keeps a late result after notifying unknown outcome exactly once", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const abandon = vi.fn(async () => {});
  const unknown = vi.fn();
  const client = new RendererAppServerRequestClient(abandon);
  const pending = client.send(
    "turn/start",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    {
      timeoutMs: 20,
      onOutcomeUnknown: unknown,
    },
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(unknown).toHaveBeenCalledOnce();
  expect(abandon).toHaveBeenCalledOnce();
  finish("accepted");
  await expect(pending).resolves.toBe("accepted");
  client[Symbol.dispose]();
  expect(abandon).toHaveBeenCalledOnce();
});

it("rejects new requests after scope disposal", async () => {
  const dispatch = vi.fn(async () => "unexpected");
  const client = new RendererAppServerRequestClient(async () => {});
  client[Symbol.dispose]();
  await expect(client.send("thread/read", dispatch)).rejects.toThrow("disposed");
  expect(dispatch).not.toHaveBeenCalled();
});

it("uses no response deadline by default and disposes pending callers", async () => {
  vi.useFakeTimers();
  const abandon = vi.fn(async () => {});
  const client = new RendererAppServerRequestClient(abandon);
  const pending = client.send("thread/read", async (caller) => {
    expect(caller.timeoutMs).toBe(0);
    expect(caller.expiresAtMs).toBeNull();
    return new Promise<never>(() => {});
  });
  const rejected = expect(pending).rejects.toThrow("disposed");
  await vi.advanceTimersByTimeAsync(180_001);
  expect(abandon).not.toHaveBeenCalled();
  client[Symbol.dispose]();
  await rejected;
  expect(abandon).toHaveBeenCalledOnce();
});

it("ordinary reads cannot opt into an uncertain mutation outcome", async () => {
  vi.useFakeTimers();
  const unknown = vi.fn();
  using client = new RendererAppServerRequestClient(async () => {});
  const pending = client.send(
    "thread/read",
    async (caller) => {
      expect(caller.retainResponse).toBe(false);
      return new Promise<never>(() => {});
    },
    { timeoutMs: 10, onOutcomeUnknown: unknown },
  );
  const rejected = expect(pending).rejects.toThrow("Timeout");
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(unknown).not.toHaveBeenCalled();
});

it("a late timed-out response cannot remove a later caller reusing its request ID", async () => {
  vi.useFakeTimers();
  let resolveFirst: ((value: string) => void) | undefined;
  using client = new RendererAppServerRequestClient(async () => {});
  const first = client.send(
    "thread/read",
    () =>
      new Promise<string>((resolve) => {
        resolveFirst = resolve;
      }),
    { requestId: "same", timeoutMs: 10 },
  );
  const firstRejected = expect(first).rejects.toThrow("Timeout");
  await vi.advanceTimersByTimeAsync(10);
  await firstRejected;
  const second = client.send("thread/read", () => new Promise<never>(() => {}), {
    requestId: "same",
  });
  const secondRejected = expect(second).rejects.toThrow("disposed");
  resolveFirst?.("late");
  await Promise.resolve();
  client[Symbol.dispose]();
  await secondRejected;
});

it("host retirement rejects retained outcomes and fences a reused ID from late completion", async () => {
  vi.useFakeTimers();
  const abandon = vi.fn(async () => {});
  using client = new RendererAppServerRequestClient(abandon);
  let finishOld!: (value: string) => void;
  let finishNew!: (value: string) => void;
  const pending = client.send(
    "turn/start",
    () =>
      new Promise<string>((resolve) => {
        finishOld = resolve;
      }),
    { requestId: "reused", timeoutMs: 10, onOutcomeUnknown: vi.fn() },
  );
  const rejected = expect(pending).rejects.toThrow("lifetime retired");
  await vi.advanceTimersByTimeAsync(10);
  client.retire();
  await rejected;
  const replacement = client.send(
    "turn/start",
    () =>
      new Promise<string>((resolve) => {
        finishNew = resolve;
      }),
    { requestId: "reused" },
  );
  finishOld("old result");
  await Promise.resolve();
  await expect(
    client.send("turn/start", async () => "duplicate", { requestId: "reused" }),
  ).rejects.toThrow("already pending");
  finishNew("current result");
  await expect(replacement).resolves.toBe("current result");
  expect(abandon.mock.calls).toEqual([
    ["reused", "timeout"],
    ["reused", "disposed"],
  ]);
});

it("fallback scheduling reserves the sixth slot for critical work", async () => {
  const client = new RendererAppServerRequestClient(async () => {}, "local", false);
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const dispatch = (name: string) => () => {
    started.push(name);
    return new Promise<string>((resolve) => releases.push(() => resolve(name)));
  };

  const interactive = Array.from({ length: 6 }, (_, index) =>
    client.send(`read/${index}`, dispatch(`interactive-${index}`), {
      requestId: `interactive-${index}`,
      priority: "interactive",
    }),
  );
  expect(started).toEqual([
    "interactive-0",
    "interactive-1",
    "interactive-2",
    "interactive-3",
    "interactive-4",
  ]);

  const critical = client.send("turn/start", dispatch("critical"), { requestId: "critical" });
  expect(started.at(-1)).toBe("critical");

  releases[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(started.at(-1)).toBe("interactive-5");

  for (const release of releases.slice(1)) release();
  await Promise.all([...interactive, critical]);
  client[Symbol.dispose]();
});

it("fallback scheduling caps background concurrency at three and yields before reusing it", async () => {
  vi.useFakeTimers();
  const client = new RendererAppServerRequestClient(async () => {}, "local", false);
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const dispatch = (name: string) => () => {
    started.push(name);
    return new Promise<string>((resolve) => releases.set(name, () => resolve(name)));
  };

  const requests = Array.from({ length: 4 }, (_, index) =>
    client.send("app/list", dispatch(`background-${index}`), {
      requestId: `background-${index}`,
      priority: "background",
    }),
  );
  expect(started).toEqual(["background-0", "background-1", "background-2"]);

  releases.get("background-0")?.();
  await Promise.resolve();
  expect(started).toEqual(["background-0", "background-1", "background-2"]);
  await vi.runAllTimersAsync();
  expect(started.at(-1)).toBe("background-3");

  for (const release of releases.values()) release();
  await vi.runAllTimersAsync();
  await Promise.all(requests);
  client[Symbol.dispose]();
});

it("fallback queue pressure reports the real queued count", async () => {
  const client = new RendererAppServerRequestClient(async () => {}, "local", false);
  const lifecycle = vi.fn();
  client.addRequestLifecycleListener(lifecycle);
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 69 }, (_, index) =>
    client.send(
      `read/${index}`,
      () => new Promise<string>((resolve) => releases.push(() => resolve(String(index)))),
      { requestId: `interactive-${index}`, priority: "interactive" },
    ),
  );
  expect(lifecycle).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "background-queue-full" }),
  );

  await expect(
    client.send("read/overflow", async () => "unexpected", {
      requestId: "overflow",
      priority: "interactive",
    }),
  ).rejects.toThrow("queue is full");
  expect(lifecycle).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "background-queue-full",
      priority: "interactive",
      queuedRequestCountAtEnqueue: 64,
    }),
  );

  client[Symbol.dispose]();
  await Promise.allSettled(pending);
});
