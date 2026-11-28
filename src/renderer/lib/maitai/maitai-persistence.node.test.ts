import { beforeEach, describe, expect, test } from "vite-plus/test";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../../shared/ipc-api";
import type { PersistedAtomTransport } from "../persisted-atom-store";
import {
  clearMaitaiPersistenceForTests,
  createMaitaiStore,
  disposeMaitaiStore,
  getConcretePersistedAtom,
  persistedAtom,
  preloadPersistedAtom,
  retryPersistedAtom,
  setMaitaiPersistenceTransport,
} from "./index";

class FakeTransport implements PersistedAtomTransport {
  snapshot: PersistedAtomSnapshot = { revision: 0, values: {} };
  readonly listeners = new Set<(event: PersistedAtomEvent) => void>();
  readonly mutations: PersistedAtomMutation[] = [];
  failNextMutation = false;
  failNextRead = false;
  readCount = 0;

  async readSnapshot(): Promise<PersistedAtomSnapshot> {
    this.readCount += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("read failed");
    }
    return this.snapshot;
  }

  async mutate(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent> {
    this.mutations.push(mutation);
    if (this.failNextMutation) {
      this.failNextMutation = false;
      throw new Error("write failed");
    }
    const event: PersistedAtomEvent = {
      ...mutation,
      revision: this.snapshot.revision + 1,
      originRendererId: "local",
    };
    this.snapshot = {
      revision: event.revision,
      values: { ...this.snapshot.values, [event.key]: event.value },
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: PersistedAtomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PersistedAtomEvent): void {
    this.snapshot = {
      revision: event.revision,
      values: { ...this.snapshot.values, [event.key]: event.value },
    };
    for (const listener of this.listeners) listener(event);
  }
}

beforeEach(() => clearMaitaiPersistenceForTests());

function createStringDefinition(sync: "cross-window" | "same-window" | "none" = "cross-window") {
  return persistedAtom({
    debugLabel: "draft",
    storageKey: "draft",
    defaultValue: "",
    hydration: "eager",
    synchronization: sync,
    decode: (value) => (typeof value === "string" ? value : ""),
  });
}

describe("Maitai persisted atoms", () => {
  test("holds a hydration error stable until an explicit retry", async () => {
    const transport = new FakeTransport();
    transport.failNextRead = true;
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    const concrete = getConcretePersistedAtom(store, definition);

    await preloadPersistedAtom(store, definition);
    expect(store.jotaiStore.get(concrete).status).toBe("error");
    getConcretePersistedAtom(store, definition);
    getConcretePersistedAtom(store, definition);
    await Promise.resolve();
    expect(transport.readCount).toBe(1);

    await retryPersistedAtom(store, definition);
    expect(transport.readCount).toBe(2);
    expect(store.jotaiStore.get(concrete).status).toBe("ready");
  });

  test("publishes a synchronous loadable and hydrates eagerly", async () => {
    const transport = new FakeTransport();
    transport.snapshot = { revision: 4, values: { draft: "stored" } };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    const concrete = getConcretePersistedAtom(store, definition);

    expect(store.jotaiStore.get(concrete)).toMatchObject({ status: "loading", value: "" });
    await preloadPersistedAtom(store, definition);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "ready",
      value: "stored",
      confirmedRevision: 4,
    });
  });

  test("keeps the newest optimistic value while writes are confirmed in order", async () => {
    const transport = new FakeTransport();
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    const first = store.jotaiStore.set(concrete, "W1");
    const second = store.jotaiStore.set(concrete, "W2");
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      value: "W2",
      pendingMutationCount: 0,
      localRevision: 2,
    });
    await Promise.all([first, second]);
    expect(transport.mutations.map((mutation) => mutation.value)).toEqual(["W1", "W2"]);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "ready",
      value: "W2",
      pendingMutationCount: 0,
    });
  });

  test("stale hydration cannot overwrite a newer subscription event", async () => {
    const transport = new FakeTransport();
    const resolveSnapshotRef: {
      current: ((snapshot: PersistedAtomSnapshot) => void) | null;
    } = { current: null };
    transport.readSnapshot = () =>
      new Promise((resolve) => {
        resolveSnapshotRef.current = resolve;
      });
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    const concrete = getConcretePersistedAtom(store, definition);
    transport.emit({
      key: "draft",
      value: "newer event",
      mutationId: "remote-2",
      revision: 2,
      originRendererId: "other",
    });
    resolveSnapshotRef.current?.({ revision: 1, values: { draft: "older snapshot" } });
    await preloadPersistedAtom(store, definition);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "ready",
      value: "newer event",
      confirmedRevision: 2,
    });
  });

  test("older acknowledgement cannot overwrite a newer pending write", async () => {
    const transport = new FakeTransport();
    const acknowledgements = new Map<string, (event: PersistedAtomEvent) => void>();
    transport.mutate = (mutation) =>
      new Promise((resolve) => {
        transport.mutations.push(mutation);
        acknowledgements.set(String(mutation.value), resolve);
      });
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    const first = store.jotaiStore.set(concrete, "W1");
    const second = store.jotaiStore.set(concrete, "W2");
    expect(transport.mutations.map((mutation) => mutation.value)).toEqual(["W1", "W2"]);
    const secondMutation = transport.mutations[1];
    const firstMutation = transport.mutations[0];
    if (!firstMutation || !secondMutation) throw new Error("Expected ordered mutations");
    acknowledgements.get("W2")?.({
      ...secondMutation,
      revision: 2,
      originRendererId: "local",
    });
    await Promise.resolve();
    expect(store.jotaiStore.get(concrete).value).toBe("W2");
    acknowledgements.get("W1")?.({
      ...firstMutation,
      revision: 1,
      originRendererId: "local",
    });
    await Promise.all([first, second]);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      value: "W2",
      confirmedRevision: 2,
      pendingMutationCount: 0,
    });
  });

  test("rebases a pending local write over a newer cross-window event", async () => {
    const transport = new FakeTransport();
    const resolveMutationRef: {
      current: ((event: PersistedAtomEvent) => void) | null;
    } = { current: null };
    transport.mutate = async (mutation) =>
      new Promise((resolve) => {
        transport.mutations.push(mutation);
        resolveMutationRef.current = resolve;
      });
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    const write = store.jotaiStore.set(concrete, "local");
    transport.emit({
      key: "draft",
      value: "remote",
      mutationId: "remote",
      revision: 1,
      originRendererId: "other",
    });
    expect(store.jotaiStore.get(concrete).value).toBe("local");
    const mutation = transport.mutations[0];
    if (!mutation) throw new Error("Expected mutation");
    resolveMutationRef.current?.({ ...mutation, revision: 2, originRendererId: "local" });
    await write;
    expect(store.jotaiStore.get(concrete).value).toBe("local");
  });

  test("rebases a remote write that arrives between two local writes", async () => {
    const transport = new FakeTransport();
    const acknowledgements: Array<(event: PersistedAtomEvent) => void> = [];
    transport.mutate = (mutation) =>
      new Promise((resolve) => {
        transport.mutations.push(mutation);
        acknowledgements.push(resolve);
      });
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    const first = store.jotaiStore.set(concrete, "W1");
    transport.emit({
      key: "draft",
      value: "remote-between",
      mutationId: "remote-between",
      revision: 1,
      originRendererId: "other",
    });
    const second = store.jotaiStore.set(concrete, "W2");
    expect(store.jotaiStore.get(concrete).value).toBe("W2");
    const firstMutation = transport.mutations[0];
    const secondMutation = transport.mutations[1];
    if (!firstMutation || !secondMutation) throw new Error("Expected two local mutations");
    acknowledgements[0]?.({ ...firstMutation, revision: 2, originRendererId: "local" });
    acknowledgements[1]?.({ ...secondMutation, revision: 3, originRendererId: "local" });
    await Promise.all([first, second]);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      value: "W2",
      confirmedRevision: 3,
      pendingMutationCount: 0,
    });
  });

  test("a reloaded renderer hydrates a main-persisted value before the original acknowledgement", async () => {
    const transport = new FakeTransport();
    const resolveMutationRef: { current: ((event: PersistedAtomEvent) => void) | null } = {
      current: null,
    };
    transport.mutate = (mutation) => {
      transport.mutations.push(mutation);
      transport.snapshot = {
        revision: 1,
        values: { draft: mutation.value },
      };
      return new Promise((resolve) => {
        resolveMutationRef.current = resolve;
      });
    };
    const definition = createStringDefinition();
    const firstStore = createMaitaiStore();
    setMaitaiPersistenceTransport(firstStore, transport);
    await preloadPersistedAtom(firstStore, definition);
    const firstConcrete = getConcretePersistedAtom(firstStore, definition);
    const pendingWrite = firstStore.jotaiStore.set(firstConcrete, "persisted-before-ack");

    const reloadedStore = createMaitaiStore();
    setMaitaiPersistenceTransport(reloadedStore, transport);
    await preloadPersistedAtom(reloadedStore, definition);
    const reloadedConcrete = getConcretePersistedAtom(reloadedStore, definition);
    expect(reloadedStore.jotaiStore.get(reloadedConcrete)).toMatchObject({
      status: "ready",
      value: "persisted-before-ack",
      confirmedRevision: 1,
    });

    const mutation = transport.mutations[0];
    if (!mutation) throw new Error("Expected persisted mutation");
    resolveMutationRef.current?.({ ...mutation, revision: 1, originRendererId: "original" });
    await pendingWrite;
  });

  test("same-window policy ignores unrelated remote events", async () => {
    const transport = new FakeTransport();
    transport.snapshot = { revision: 2, values: { draft: "baseline" } };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition("same-window");
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    transport.emit({
      key: "draft",
      value: "other window",
      mutationId: "remote",
      revision: 3,
      originRendererId: "other",
    });
    expect(store.jotaiStore.get(concrete).value).toBe("baseline");
  });

  test("none policy hydrates and writes without a live subscription", async () => {
    const transport = new FakeTransport();
    transport.snapshot = { revision: 2, values: { draft: "baseline" } };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition("none");
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);
    expect(transport.listeners.size).toBe(0);
    transport.emit({
      key: "draft",
      value: "remote",
      mutationId: "remote",
      revision: 3,
      originRendererId: "other",
    });
    expect(store.jotaiStore.get(concrete).value).toBe("baseline");
    await store.jotaiStore.set(concrete, "local");
    expect(store.jotaiStore.get(concrete).value).toBe("local");
  });

  test("retain-and-error keeps authored text after a write failure", async () => {
    const transport = new FakeTransport();
    transport.failNextMutation = true;
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);

    await expect(store.jotaiStore.set(concrete, "keep me")).rejects.toThrow("write failed");
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "error",
      value: "keep me",
      pendingMutationCount: 1,
    });
  });

  test("a failed older write cannot roll back a newer pending mutation", async () => {
    const transport = new FakeTransport();
    const resolveSecondRef: { current: ((event: PersistedAtomEvent) => void) | null } = {
      current: null,
    };
    let mutationIndex = 0;
    transport.mutate = (mutation) => {
      transport.mutations.push(mutation);
      mutationIndex += 1;
      if (mutationIndex === 1) return Promise.reject(new Error("W1 failed"));
      return new Promise((resolve) => {
        resolveSecondRef.current = resolve;
      });
    };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);
    const first = store.jotaiStore.set(concrete, "W1");
    void first.catch(() => undefined);
    const second = store.jotaiStore.set(concrete, "W2");
    await first.catch(() => undefined);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "error",
      value: "W2",
      pendingMutationCount: 2,
    });
    const secondMutation = transport.mutations[1];
    if (!secondMutation) throw new Error("Expected second mutation");
    resolveSecondRef.current?.({ ...secondMutation, revision: 2, originRendererId: "local" });
    await Promise.allSettled([first, second]);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "ready",
      value: "W2",
      pendingMutationCount: 0,
    });
  });

  test("retry republishes a retained failed mutation", async () => {
    const transport = new FakeTransport();
    transport.failNextMutation = true;
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);
    await expect(store.jotaiStore.set(concrete, "retry me")).rejects.toThrow("write failed");
    await retryPersistedAtom(store, definition);
    await Promise.resolve();
    expect(transport.mutations.map((mutation) => mutation.value)).toEqual(["retry me", "retry me"]);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "ready",
      value: "retry me",
      pendingMutationCount: 0,
    });
  });

  test("codec failures surface without replacing the visible fallback", async () => {
    const transport = new FakeTransport();
    transport.snapshot = { revision: 1, values: { broken: "invalid" } };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = persistedAtom({
      debugLabel: "broken-codec",
      storageKey: "broken",
      defaultValue: "fallback",
      decode: () => {
        throw new Error("decode failed");
      },
      encode: () => {
        throw new Error("encode failed");
      },
    });
    await preloadPersistedAtom(store, definition);
    const concrete = getConcretePersistedAtom(store, definition);
    expect(store.jotaiStore.get(concrete)).toMatchObject({
      status: "error",
      value: "fallback",
    });
    expect(() => store.jotaiStore.set(concrete, "new value")).toThrow("encode failed");
  });

  test("a declaration evaluated again by hot reload keeps its state and adopts the edited codec", async () => {
    const transport = new FakeTransport();
    transport.snapshot = { revision: 1, values: { draft: "stored" } };
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    const concrete = getConcretePersistedAtom(store, definition);
    await preloadPersistedAtom(store, definition);

    const reloaded = persistedAtom({
      debugLabel: "draft",
      storageKey: "draft",
      defaultValue: "",
      hydration: "eager",
      decode: (value) => (typeof value === "string" ? value.toUpperCase() : ""),
    });
    expect(reloaded).toBe(definition);
    expect(getConcretePersistedAtom(store, reloaded)).toBe(concrete);
    expect(store.jotaiStore.get(concrete)).toMatchObject({ status: "ready", value: "stored" });
    expect(transport.readCount).toBe(1);
    transport.emit({
      key: "draft",
      value: "from another window",
      mutationId: "remote",
      revision: 9,
      originRendererId: "remote",
    });
    expect(store.jotaiStore.get(concrete).value).toBe("FROM ANOTHER WINDOW");

    expect(() => createStringDefinition("none")).toThrow("draft changed its policies");
    expect(() =>
      persistedAtom({ debugLabel: "other", storageKey: "draft", defaultValue: 0, decode: Number }),
    ).toThrow("Duplicate persisted atom storage key: draft");
  });

  test("store disposal and test reset release persistence subscriptions", async () => {
    const transport = new FakeTransport();
    const store = createMaitaiStore();
    setMaitaiPersistenceTransport(store, transport);
    const definition = createStringDefinition();
    await preloadPersistedAtom(store, definition);
    expect(transport.listeners.size).toBe(1);
    disposeMaitaiStore(store);
    expect(transport.listeners.size).toBe(0);

    clearMaitaiPersistenceForTests();
    expect(() => createStringDefinition()).not.toThrow();
  });
});
