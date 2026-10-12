import { beforeEach, describe, expect, test } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import {
  clearPersistedAtomStoreForTests,
  readAtom,
  subscribeAtom,
  writeAtom,
  getPersistedAtomTransport,
} from "./persisted-atom-store";

type BridgeListener = (...args: unknown[]) => void;

function clearWindowApi(): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

describe("persisted atom renderer store", () => {
  beforeEach(() => {
    clearPersistedAtomStoreForTests();
    clearWindowApi();
  });

  test("ordered delete receipts remove both related keys and cannot be revived by stale updates", async () => {
    let listener: BridgeListener | null = null;
    installWindowApi({
      invoke: async () => ({ revision: 0, values: { state: { selected: 1 }, interactions: {} } }),
      on: (channel: string, callback: BridgeListener) => {
        if (channel === "persisted-atom:updated") listener = callback;
        return () => {};
      },
    });
    await readAtom("state", null);
    const seen: unknown[] = [];
    const stop = subscribeAtom("state", (value) => seen.push(value));
    for (const [index, key] of ["state", "interactions"].entries())
      (listener as BridgeListener | null)?.({
        key,
        value: undefined,
        revision: index + 1,
        mutationId: "clear",
        originRendererId: null,
      });
    (listener as BridgeListener | null)?.({
      key: "state",
      value: { selected: 9 },
      revision: 1,
      mutationId: "stale",
      originRendererId: null,
    });
    expect(await getPersistedAtomTransport().readSnapshot()).toEqual({ revision: 2, values: {} });
    expect(seen).toEqual([undefined]);
    stop();
  });

  test("uses an in-memory fallback when the Electron bridge is unavailable", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeAtom("prompt-history", (value) => {
      seen.push(String(value));
    });

    expect(await readAtom("prompt-history", "fallback")).toBe("fallback");
    await writeAtom("prompt-history", "stored");

    expect(await readAtom("prompt-history", "fallback")).toBe("stored");
    expect(seen.join("|")).toBe("stored");
    unsubscribe();
  });

  test("uses the Electron IPC bridge and subscribes to atom update events", async () => {
    let revision = 0;
    let bridgeState: Record<string, unknown> = { alpha: "one" };
    const persistedAtomListenerRef: { current: BridgeListener | null } = { current: null };
    const invokedChannels: string[] = [];
    const seen: string[] = [];

    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        invokedChannels.push(channel);
        if (channel === "persisted-atom:sync-request") {
          return { revision, values: bridgeState };
        }
        if (channel === "persisted-atom:update") {
          const update = args[0] as { key: string; value: unknown; mutationId: string };
          revision += 1;
          bridgeState = {
            ...bridgeState,
            [update.key]: update.value,
          };
          return {
            ...update,
            revision,
            originRendererId: "renderer-1",
          };
        }
        return null;
      },
      on: (channel: string, listener: BridgeListener) => {
        if (channel !== "persisted-atom:updated") return () => {};
        persistedAtomListenerRef.current = listener;
        return () => {
          if (persistedAtomListenerRef.current === listener) {
            persistedAtomListenerRef.current = null;
          }
        };
      },
    });
    clearPersistedAtomStoreForTests();

    expect(await readAtom("alpha", "fallback")).toBe("one");

    const unsubscribe = subscribeAtom("gamma", (value) => {
      seen.push(String(value));
    });
    revision += 1;
    persistedAtomListenerRef.current?.({
      key: "gamma",
      value: "three",
      mutationId: "remote-1",
      revision,
      originRendererId: "renderer-2",
    });

    expect(seen.join("|")).toBe("three");
    await writeAtom("beta", "two");
    expect(await readAtom("beta", "fallback")).toBe("two");
    expect(invokedChannels.join("|")).toBe("persisted-atom:sync-request|persisted-atom:update");
    unsubscribe();
  });

  test("does not let an older hydration snapshot overwrite an intervening event", async () => {
    const resolveSyncRef: { current: ((value: unknown) => void) | null } = { current: null };
    const persistedAtomListenerRef: { current: BridgeListener | null } = { current: null };
    installWindowApi({
      invoke: (channel: string) => {
        if (channel !== "persisted-atom:sync-request") return Promise.resolve(null);
        return new Promise((resolve) => {
          resolveSyncRef.current = resolve;
        });
      },
      on: (channel: string, listener: BridgeListener) => {
        if (channel !== "persisted-atom:updated") return () => {};
        persistedAtomListenerRef.current = listener;
        return () => {
          persistedAtomListenerRef.current = null;
        };
      },
    });
    clearPersistedAtomStoreForTests();

    const pendingRead = readAtom("draft", "fallback");
    persistedAtomListenerRef.current?.({
      key: "draft",
      value: "newer broadcast",
      mutationId: "remote-2",
      revision: 2,
      originRendererId: "renderer-2",
    });
    resolveSyncRef.current?.({ revision: 1, values: { draft: "older hydration" } });

    await expect(pendingRead).resolves.toBe("newer broadcast");
    await expect(readAtom("draft", "fallback")).resolves.toBe("newer broadcast");
  });
});
