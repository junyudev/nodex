import { describe, expect, test, vi } from "vite-plus/test";
import { runSyncWithCleanup, runWithCleanup } from "./run-with-cleanup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asThenable<T>(promise: Promise<T>): Promise<T> {
  // oxlint-disable-next-line unicorn/no-thenable -- Exercise structural thenables rather than native Promises.
  return { then: promise.then.bind(promise) } as Promise<T>;
}

describe("runWithCleanup", () => {
  test("starts immediately and cleans up before returning the successful result", async () => {
    const action = deferred<boolean>();
    const operation = vi.fn(() => action.promise);
    const cleanup = vi.fn();
    const onError = vi.fn(() => false);
    const result = runWithCleanup(operation, { cleanup, onError });

    expect(operation).toHaveBeenCalledExactlyOnceWith();
    expect(cleanup).not.toHaveBeenCalled();
    action.resolve(true);

    expect(await result).toBe(true);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith();
    expect(onError).not.toHaveBeenCalled();
  });

  test("allows actions without cleanup or error recovery", async () => {
    expect(await runWithCleanup(async () => 42, {})).toBe(42);
    const failure = new Error("Action failed");
    await expect(runWithCleanup(() => Promise.reject(failure), {})).rejects.toBe(failure);
  });

  test.each(["throw", "reject"] as const)(
    "cleans up and preserves an unhandled action %s",
    async (mode) => {
      const failure = new Error("Action failed");
      const cleanup = vi.fn();
      const result = runWithCleanup(
        () => {
          if (mode === "throw") throw failure;
          return Promise.reject(failure);
        },
        { cleanup },
      );

      if (mode === "throw") expect(cleanup).toHaveBeenCalledExactlyOnceWith();
      await expect(result).rejects.toBe(failure);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith();
    },
  );

  test.each(["throw", "reject"] as const)(
    "recovers an action %s and cleans up in the same microtask as synchronous recovery",
    async (mode) => {
      const failure = new Error("Action failed");
      const events: string[] = [];
      const result = runWithCleanup(
        () => {
          if (mode === "throw") throw failure;
          return Promise.reject(failure);
        },
        {
          onError: (error) => {
            expect(error).toBe(failure);
            events.push("recovery");
            queueMicrotask(() => events.push("queued"));
            return false;
          },
          cleanup: () => {
            events.push("cleanup");
          },
        },
      ).then((value) => {
        events.push("resolved");
        return value;
      });

      if (mode === "throw") expect(events).toEqual(["recovery", "cleanup"]);
      expect(await result).toBe(false);
      expect(events).toEqual(["recovery", "cleanup", "queued", "resolved"]);
    },
  );

  test.each(["resolve", "reject"] as const)(
    "waits for asynchronous recovery to %s before cleanup",
    async (outcome) => {
      const failure = new Error("Action failed");
      const recoveryFailure = new Error("Recovery failed");
      const recovery = deferred<boolean>();
      const cleanup = vi.fn();
      const onError = vi.fn(() => recovery.promise);
      const result = runWithCleanup(() => Promise.reject(failure), { cleanup, onError });

      await Promise.resolve();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(cleanup).not.toHaveBeenCalled();

      if (outcome === "resolve") {
        recovery.resolve(false);
        expect(await result).toBe(false);
      } else {
        recovery.reject(recoveryFailure);
        await expect(result).rejects.toBe(recoveryFailure);
      }
      expect(cleanup).toHaveBeenCalledExactlyOnceWith();
    },
  );

  test("cleans up when synchronous recovery throws", async () => {
    const failure = new Error("Recovery failed");
    const cleanup = vi.fn();
    const result = runWithCleanup(() => Promise.reject(new Error("Action failed")), {
      cleanup,
      onError: () => {
        throw failure;
      },
    });

    await expect(result).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith();
  });

  test("synchronous cleanup does not delay resolution by another microtask", async () => {
    const events: string[] = [];
    const result = runWithCleanup(async () => "saved", {
      cleanup: () => {
        events.push("cleanup");
      },
    }).then((value) => {
      events.push("resolved");
      return value;
    });

    await Promise.resolve();
    expect(events).toEqual(["cleanup"]);
    queueMicrotask(() => events.push("queued"));
    expect(await result).toBe("saved");
    expect(events).toEqual(["cleanup", "resolved", "queued"]);
  });

  test.each(["resolve", "reject"] as const)(
    "waits for asynchronous cleanup before the action can %s",
    async (outcome) => {
      const failure = new Error("Action failed");
      const disposal = deferred<void>();
      const cleanup = vi.fn(() => disposal.promise);
      const events: string[] = [];
      const result = runWithCleanup(
        () => (outcome === "resolve" ? Promise.resolve("saved") : Promise.reject(failure)),
        { cleanup },
      ).then(
        (value) => {
          events.push("resolved");
          return value;
        },
        (error: unknown) => {
          events.push("rejected");
          throw error;
        },
      );

      await Promise.resolve();
      expect(cleanup).toHaveBeenCalledExactlyOnceWith();
      expect(events).toEqual([]);
      disposal.resolve();
      queueMicrotask(() => events.push("queued"));

      if (outcome === "resolve") expect(await result).toBe("saved");
      else await expect(result).rejects.toBe(failure);
      expect(events).toEqual(["queued", outcome === "resolve" ? "resolved" : "rejected"]);
    },
  );

  test.each(["throw", "reject"] as const)(
    "lets a cleanup %s replace the action failure",
    async (mode) => {
      const failure = new Error("Cleanup failed");
      const result = runWithCleanup(() => Promise.reject(new Error("Action failed")), {
        cleanup: () => {
          if (mode === "throw") throw failure;
          return Promise.reject(failure);
        },
      });

      await expect(result).rejects.toBe(failure);
    },
  );

  test("awaits non-Promise thenables returned by recovery and cleanup", async () => {
    const recovery = deferred<boolean>();
    const disposal = deferred<void>();
    const cleanup = vi.fn(() => asThenable(disposal.promise));
    const settled = vi.fn();
    const result = runWithCleanup(() => Promise.reject(new Error("Action failed")), {
      onError: () => asThenable(recovery.promise),
      cleanup,
    }).then(settled);

    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    recovery.resolve(false);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledExactlyOnceWith());
    expect(settled).not.toHaveBeenCalled();
    disposal.resolve();
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("runSyncWithCleanup", () => {
  test("cleans up before returning the operation result", () => {
    const events: string[] = [];
    const value = runSyncWithCleanup(
      () => {
        events.push("operation");
        return 42;
      },
      () => events.push("cleanup"),
    );

    expect(value).toBe(42);
    expect(events).toEqual(["operation", "cleanup"]);
  });

  test("cleans up before propagating an operation failure", () => {
    const failure = new Error("Action failed");
    const cleanup = vi.fn();

    expect(() =>
      runSyncWithCleanup(() => {
        throw failure;
      }, cleanup),
    ).toThrow(failure);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith();
  });

  test.each(["return", "throw"] as const)(
    "lets cleanup failure replace an operation %s",
    (outcome) => {
      const failure = new Error("Cleanup failed");

      expect(() =>
        runSyncWithCleanup(
          () => {
            if (outcome === "throw") throw new Error("Action failed");
            return 42;
          },
          () => {
            throw failure;
          },
        ),
      ).toThrow(failure);
    },
  );
});
