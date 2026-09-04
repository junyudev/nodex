import { describe, expect, test } from "vite-plus/test";
import type { ReadyRegisteredOwnedBlockDocumentDescriptor } from "./owned-block-document";
import type { CanvasSceneBinding } from "./canvas-scene-binding";
import type { CanvasBinaryFileResolver } from "./canvas-assets";
import type { CanvasSceneProvider } from "./canvas-scene-provider";
import type { CanvasPresenceController } from "./canvas-presence-controller";
import {
  createCanvasSceneSurfaceRegistry,
  makeCanvasSceneSurfaceKey,
} from "./canvas-scene-surface-runtime";

const descriptor = {
  documentId: "document-1",
  storeEpoch: "epoch-1",
  generation: 1,
  headSeq: 0,
  sync: { kind: "canvas_scene" },
} as unknown as ReadyRegisteredOwnedBlockDocumentDescriptor;

const deferred = () => {
  let resolve = (): void => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const runtimeDependencies = (input: {
  ownerBlockId?: string;
  durable?: Promise<void>;
  committed?: Promise<void>;
  closeError?: Error;
  recoveryError?: Error;
  status?: {
    readonly phase: "ready" | "saving" | "offline";
    readonly connected: boolean;
    readonly pendingMutationCount: number;
    readonly writeFrozen: boolean;
  };
}) => {
  const calls: string[] = [];
  const binding = {
    persistDurable: async () => {
      calls.push("persist");
      await (input.durable ?? Promise.resolve());
    },
    flushCommitted: async () => {
      calls.push("flush");
      await (input.committed ?? Promise.resolve());
    },
    submitLocalScene: () => ({
      durable: Promise.resolve(),
      committed: Promise.resolve(),
    }),
    destroy: () => {
      calls.push("destroy-binding");
    },
  } as unknown as CanvasSceneBinding;
  const provider = {
    checkpointRecovery: async () => {
      calls.push("preserve-recovery");
      if (input.recoveryError) throw input.recoveryError;
    },
    connect: async () => {
      calls.push("connect");
    },
    getStatus: () =>
      input.status ?? {
        phase: "ready",
        connected: true,
        pendingMutationCount: 0,
        writeFrozen: false,
      },
    close: async () => {
      calls.push("close-provider");
      if (input.closeError) throw input.closeError;
    },
  } as unknown as CanvasSceneProvider;
  const fileResolver = {
    destroy: () => {
      calls.push("destroy-files");
    },
  } as unknown as CanvasBinaryFileResolver;
  const presence = {
    close: async () => {
      calls.push("close-presence");
    },
  } as unknown as CanvasPresenceController;
  return {
    calls,
    input: {
      descriptor: {
        ...descriptor,
        ownerBlockId: input.ownerBlockId ?? "canvas-1",
      },
      provider,
      presence,
      binding,
      fileResolver,
      disposeSubscriptions: () => {
        calls.push("dispose-subscriptions");
      },
    },
  };
};

describe("CanvasSceneSurfaceRegistry", () => {
  test("retains the only draft and blocks a replacement when recovery cannot be persisted", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const first = runtimeDependencies({
      durable: Promise.reject(new Error("durability unavailable")),
      recoveryError: new Error("recovery unavailable"),
    });
    const runtime = registry.acquire({ key: "surface", ...first.input });
    await expect(registry.release("surface", runtime)).rejects.toThrow("recovery unavailable");
    expect(runtime.isClosed()).toBe(false);
    expect(first.calls).not.toContain("destroy-binding");
    await expect(registry.persistAllDurable()).rejects.toThrow("durability unavailable");
    const second = runtimeDependencies({});
    const replacement = registry.acquire({ key: "surface", ...second.input });
    await expect(replacement.connect()).rejects.toThrow("recovery unavailable");
    expect(second.calls).not.toContain("connect");
  });
  test("uses Window Session, Project Session, and tab identity", () => {
    expect(makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1")).not.toBe(
      makeCanvasSceneSurfaceKey("window-2", "session-1", "tab-1"),
    );
    expect(makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1")).not.toBe(
      makeCanvasSceneSurfaceKey("window-1", "session-2", "tab-1"),
    );
  });

  test("keeps an unmounted runtime observable until local durability settles", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const durable = deferred();
    const dependencies = runtimeDependencies({ durable: durable.promise });
    const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    const runtime = registry.acquire({ key, ...dependencies.input });

    let released = false;
    const releasing = registry.release(key, runtime).then(() => {
      released = true;
    });
    const appClosing = registry.persistAllDurable();
    await Promise.resolve();

    expect(released).toBe(false);
    expect(dependencies.calls.filter((call) => call === "persist").length).toBeGreaterThanOrEqual(
      1,
    );
    durable.resolve();
    await Promise.all([releasing, appClosing]);
    expect(dependencies.calls).toEqual(
      expect.arrayContaining([
        "close-presence",
        "close-provider",
        "dispose-subscriptions",
        "destroy-files",
        "destroy-binding",
      ]),
    );
  });

  test("does not connect a replacement until its predecessor closes", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const durable = deferred();
    const first = runtimeDependencies({ durable: durable.promise });
    const second = runtimeDependencies({});
    const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    registry.acquire({ key, ...first.input });
    const replacement = registry.acquire({ key, ...second.input });

    let connected = false;
    const connecting = replacement.connect().then(() => {
      connected = true;
    });
    await Promise.resolve();
    expect(connected).toBe(false);
    expect(second.calls).not.toContain("connect");

    durable.resolve();
    await connecting;
    expect(second.calls).toContain("connect");
  });

  test("uses the committed barrier only for explicit maintenance", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const dependencies = runtimeDependencies({});
    const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    registry.acquire({ key, ...dependencies.input });

    await registry.flushAllCommitted();

    expect(dependencies.calls).toEqual(["flush"]);
  });

  test("flushes only runtimes for the requested public Canvas owner", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const first = runtimeDependencies({ ownerBlockId: "canvas-1" });
    const second = runtimeDependencies({ ownerBlockId: "canvas-2" });
    registry.acquire({ key: "surface-1", ...first.input });
    registry.acquire({ key: "surface-2", ...second.input });

    await registry.flushOwnerCommitted("canvas-1");

    expect(first.calls).toEqual(["flush"]);
    expect(second.calls).toEqual([]);
  });

  test("runs best-effort maintenance before closing an idle provider", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const dependencies = runtimeDependencies({});
    const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    const runtime = registry.acquire({
      key,
      ...dependencies.input,
      maintainIfIdle: async () => {
        dependencies.calls.push("maintain");
      },
    });

    await registry.release(key, runtime);

    expect(dependencies.calls).toEqual([
      "persist",
      "maintain",
      "close-presence",
      "close-provider",
      "dispose-subscriptions",
      "destroy-files",
      "destroy-binding",
    ]);
  });

  test("skips maintenance with pending work and still closes after maintenance failure", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const pending = runtimeDependencies({
      status: {
        phase: "saving",
        connected: true,
        pendingMutationCount: 1,
        writeFrozen: false,
      },
    });
    const pendingKey = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    const pendingRuntime = registry.acquire({
      key: pendingKey,
      ...pending.input,
      maintainIfIdle: async () => {
        pending.calls.push("maintain");
      },
    });
    await registry.release(pendingKey, pendingRuntime);
    expect(pending.calls).not.toContain("maintain");

    const failing = runtimeDependencies({});
    const failingKey = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-2");
    const failingRuntime = registry.acquire({
      key: failingKey,
      ...failing.input,
      maintainIfIdle: async () => {
        failing.calls.push("maintain");
        throw new Error("maintenance unavailable");
      },
    });
    await expect(registry.release(failingKey, failingRuntime)).resolves.toBeUndefined();
    expect(failing.calls).toEqual(
      expect.arrayContaining(["maintain", "close-provider", "destroy-binding"]),
    );
  });

  test("preserves recovery before releasing a failed close and lets a replacement connect", async () => {
    const registry = createCanvasSceneSurfaceRegistry();
    const first = runtimeDependencies({
      durable: Promise.reject(new Error("durability unavailable")),
      closeError: new Error("provider close unavailable"),
    });
    const second = runtimeDependencies({});
    const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
    const runtime = registry.acquire({ key, ...first.input });

    await expect(registry.release(key, runtime)).rejects.toThrow("durability unavailable");
    expect(first.calls).toEqual(
      expect.arrayContaining([
        "persist",
        "close-presence",
        "close-provider",
        "dispose-subscriptions",
        "destroy-files",
        "destroy-binding",
      ]),
    );

    await registry.flushAllCommitted();
    expect(first.calls).not.toContain("flush");

    const replacement = registry.acquire({ key, ...second.input });
    await expect(replacement.connect()).resolves.toBeUndefined();
    expect(second.calls).toContain("connect");
  });
});
