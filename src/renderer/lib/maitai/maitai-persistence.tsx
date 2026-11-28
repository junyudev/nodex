import { atom, useAtomValue, useSetAtom, type WritableAtom } from "jotai";
import { getPersistedAtomTransport, type PersistedAtomTransport } from "../persisted-atom-store";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../../shared/ipc-api";
import { useMaitaiStore } from "./maitai-scope";
import { registerMaitaiStoreDisposer, type MaitaiStore } from "./maitai-store";

export type PersistedSynchronizationPolicy = "cross-window" | "same-window" | "none";
export type PersistedWriteFailurePolicy = "retain-and-error" | "rollback";

export interface PersistedLoadable<Value> {
  readonly status: "loading" | "ready" | "error";
  readonly value: Value;
  readonly confirmedRevision: number;
  readonly localRevision: number;
  readonly pendingMutationCount: number;
  readonly error: Error | null;
}

export interface PersistedAtomDefinition<Value> {
  readonly debugLabel: string;
  readonly storageKey: string;
  readonly defaultValue: Value;
  readonly hydration: "eager" | "lazy";
  readonly synchronization: PersistedSynchronizationPolicy;
  readonly optimistic: boolean;
  readonly writeFailure: PersistedWriteFailurePolicy;
  readonly decode: (value: unknown) => Value;
  readonly encode: (value: Value) => unknown;
}

export interface PersistedAtomOptions<Value> {
  readonly debugLabel: string;
  readonly storageKey: string;
  readonly defaultValue: Value;
  readonly decode: (value: unknown) => Value;
  readonly encode?: (value: Value) => unknown;
  readonly hydration?: "eager" | "lazy";
  readonly synchronization?: PersistedSynchronizationPolicy;
  readonly optimistic?: boolean;
  readonly writeFailure?: PersistedWriteFailurePolicy;
}

type PersistedUpdate<Value> = Value | ((previous: Value) => Value);
type ConcretePersistedAtom<Value> = WritableAtom<
  PersistedLoadable<Value>,
  [PersistedUpdate<Value>],
  Promise<void>
>;

interface PendingMutation<Value> {
  readonly mutation: PersistedAtomMutation;
  readonly localRevision: number;
  readonly value: Value;
  state: "queued" | "sending" | "failed";
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PersistedController<Value> {
  readonly definition: PersistedAtomDefinition<Value>;
  readonly store: MaitaiStore;
  readonly transport: PersistedAtomTransport;
  readonly baseAtom: ReturnType<typeof atom<PersistedLoadable<Value>>>;
  readonly atom: ConcretePersistedAtom<Value>;
  confirmedValue: Value;
  confirmedRevision: number;
  localRevision: number;
  hydrationRequestId: number | null;
  nextHydrationRequestId: number;
  hydrationPromise: Promise<void> | null;
  pending: PendingMutation<Value>[];
  status: "loading" | "ready" | "error";
  error: Error | null;
  unsubscribe: (() => void) | null;
}

const definitionsByKey = new Map<string, PersistedAtomDefinition<unknown>>();
const controllersByStore = new WeakMap<
  MaitaiStore,
  Map<PersistedAtomDefinition<unknown>, PersistedController<unknown>>
>();
const transportByStore = new WeakMap<MaitaiStore, PersistedAtomTransport>();
const controllersForTests = new Set<PersistedController<unknown>>();

/**
 * Declares the one definition that owns a storage key; declaring the key again throws.
 *
 * Development hot reload evaluates an edited module again, together with every module between it
 * and the nearest reload boundary, so their declarations run twice. In development a repeat with
 * the same label and policies therefore returns the existing definition, so each store's state
 * and pending writes carry over, and adopts the edited default and codec. A production build
 * evaluates each module once.
 */
export function persistedAtom<Value>(
  options: PersistedAtomOptions<Value>,
): PersistedAtomDefinition<Value> {
  const debugLabel = options.debugLabel.trim();
  const storageKey = options.storageKey.trim();
  if (!debugLabel) throw new Error("Persisted atom requires a debugLabel");
  if (!storageKey) throw new Error("Persisted atom requires a storageKey");
  const definition: PersistedAtomDefinition<Value> = {
    debugLabel,
    storageKey,
    defaultValue: options.defaultValue,
    hydration: options.hydration ?? "lazy",
    synchronization: options.synchronization ?? "cross-window",
    optimistic: options.optimistic ?? true,
    writeFailure: options.writeFailure ?? "retain-and-error",
    decode: options.decode,
    encode: options.encode ?? ((value: Value) => value),
  };
  const existing = definitionsByKey.get(storageKey) as PersistedAtomDefinition<Value> | undefined;
  if (!existing) {
    definitionsByKey.set(storageKey, definition as PersistedAtomDefinition<unknown>);
    return definition;
  }
  if (!import.meta.env.DEV || existing.debugLabel !== debugLabel) {
    throw new Error(`Duplicate persisted atom storage key: ${storageKey}`);
  }
  if (!samePolicies(existing, definition)) {
    throw new Error(
      `Persisted atom ${debugLabel} changed its policies; reload the window to apply them`,
    );
  }
  const { defaultValue, decode, encode } = definition;
  return Object.assign(existing, { defaultValue, decode, encode });
}

function samePolicies<Value>(
  left: PersistedAtomDefinition<Value>,
  right: PersistedAtomDefinition<Value>,
): boolean {
  return (
    left.hydration === right.hydration &&
    left.synchronization === right.synchronization &&
    left.optimistic === right.optimistic &&
    left.writeFailure === right.writeFailure
  );
}

export function setMaitaiPersistenceTransport(
  store: MaitaiStore,
  transport: PersistedAtomTransport,
): void {
  if (controllersByStore.get(store)?.size) {
    throw new Error("Configure Maitai persistence before resolving persisted atoms");
  }
  transportByStore.set(store, transport);
}

export function getConcretePersistedAtom<Value>(
  store: MaitaiStore,
  definition: PersistedAtomDefinition<Value>,
): ConcretePersistedAtom<Value> {
  const controller = getController(store, definition);
  if (definition.hydration === "eager") void ensureHydrated(controller);
  return controller.atom;
}

export function preloadPersistedAtom<Value>(
  store: MaitaiStore,
  definition: PersistedAtomDefinition<Value>,
): Promise<void> {
  return ensureHydrated(getController(store, definition));
}

export function preloadEagerPersistedAtoms(store: MaitaiStore): Promise<void> {
  return Promise.all(
    [...definitionsByKey.values()]
      .filter((definition) => definition.hydration === "eager")
      .map((definition) => ensureHydrated(getController(store, definition))),
  ).then(() => undefined);
}

export function retryPersistedAtom<Value>(
  store: MaitaiStore,
  definition: PersistedAtomDefinition<Value>,
): Promise<void> {
  const controller = getController(store, definition);
  for (const pending of controller.pending) {
    if (pending.state === "failed") pending.state = "queued";
  }
  controller.error = null;
  controller.status = "loading";
  publish(controller);
  pump(controller);
  return ensureHydrated(controller);
}

export function usePersistedAtomValue<Value>(
  definition: PersistedAtomDefinition<Value>,
): PersistedLoadable<Value> {
  const store = useMaitaiStore();
  return useAtomValue(getConcretePersistedAtom(store, definition));
}

export function useSetPersistedAtom<Value>(
  definition: PersistedAtomDefinition<Value>,
): (update: PersistedUpdate<Value>) => Promise<void> {
  const store = useMaitaiStore();
  return useSetAtom(getConcretePersistedAtom(store, definition));
}

function getController<Value>(
  store: MaitaiStore,
  definition: PersistedAtomDefinition<Value>,
): PersistedController<Value> {
  const controllers = controllersByStore.get(store) ?? new Map();
  controllersByStore.set(store, controllers);
  const existing = controllers.get(definition as PersistedAtomDefinition<unknown>);
  if (existing) return existing as PersistedController<Value>;

  const initial: PersistedLoadable<Value> = {
    status: "loading",
    value: definition.defaultValue,
    confirmedRevision: 0,
    localRevision: 0,
    pendingMutationCount: 0,
    error: null,
  };
  const baseAtom = atom(initial);
  baseAtom.debugLabel = `persisted:${definition.debugLabel}:state`;
  const controller: PersistedController<Value> = {
    definition,
    store,
    transport: transportByStore.get(store) ?? getPersistedAtomTransport(),
    baseAtom,
    atom: null as unknown as ConcretePersistedAtom<Value>,
    confirmedValue: definition.defaultValue,
    confirmedRevision: 0,
    localRevision: 0,
    hydrationRequestId: null,
    nextHydrationRequestId: 0,
    hydrationPromise: null,
    pending: [],
    status: "loading",
    error: null,
    unsubscribe: null,
  };
  baseAtom.onMount = () => {
    void ensureHydrated(controller);
    return () => undefined;
  };
  const concrete = atom(
    (get) => get(baseAtom),
    (_get, _set, update: PersistedUpdate<Value>) => writeLocal(controller, update),
  );
  concrete.debugLabel = `persisted:${definition.debugLabel}`;
  Reflect.set(controller, "atom", concrete);
  controllers.set(
    definition as PersistedAtomDefinition<unknown>,
    controller as PersistedController<unknown>,
  );
  const untypedController = controller as PersistedController<unknown>;
  controllersForTests.add(untypedController);
  registerMaitaiStoreDisposer(store, () => {
    controller.unsubscribe?.();
    controller.unsubscribe = null;
    controllers.delete(definition as PersistedAtomDefinition<unknown>);
    controllersForTests.delete(untypedController);
  });
  return controller;
}

function ensureSubscribed<Value>(controller: PersistedController<Value>): void {
  if (controller.unsubscribe || controller.definition.synchronization === "none") return;
  controller.unsubscribe = controller.transport.subscribe((event) => {
    if (event.key !== controller.definition.storageKey) return;
    applyEvent(controller, event);
  });
}

function ensureHydrated<Value>(controller: PersistedController<Value>): Promise<void> {
  if (controller.hydrationPromise) return controller.hydrationPromise;
  if (controller.status === "ready" && controller.hydrationRequestId === null) {
    return Promise.resolve();
  }
  if (controller.status === "error" && controller.hydrationRequestId === null) {
    return Promise.resolve();
  }
  ensureSubscribed(controller);
  controller.nextHydrationRequestId += 1;
  const requestId = controller.nextHydrationRequestId;
  controller.hydrationRequestId = requestId;
  controller.hydrationPromise = controller.transport
    .readSnapshot()
    .then((snapshot) => applyHydration(controller, requestId, snapshot))
    .catch((error: unknown) => {
      if (controller.hydrationRequestId !== requestId) return;
      controller.hydrationRequestId = null;
      controller.status = "error";
      controller.error = toError(error);
      publish(controller);
    })
    .finally(() => {
      if (controller.hydrationRequestId === requestId) controller.hydrationRequestId = null;
      controller.hydrationPromise = null;
    });
  return controller.hydrationPromise;
}

function applyHydration<Value>(
  controller: PersistedController<Value>,
  requestId: number,
  snapshot: PersistedAtomSnapshot,
): void {
  if (controller.hydrationRequestId !== requestId) return;
  if (snapshot.revision < controller.confirmedRevision) return;
  const rawValue = Object.prototype.hasOwnProperty.call(
    snapshot.values,
    controller.definition.storageKey,
  )
    ? snapshot.values[controller.definition.storageKey]
    : controller.definition.defaultValue;
  try {
    controller.confirmedValue = controller.definition.decode(rawValue);
    controller.confirmedRevision = snapshot.revision;
    controller.status = "ready";
    controller.error = null;
  } catch (error) {
    controller.status = "error";
    controller.error = toError(error);
  }
  publish(controller);
  pump(controller);
}

function writeLocal<Value>(
  controller: PersistedController<Value>,
  update: PersistedUpdate<Value>,
): Promise<void> {
  const previous = visibleValue(controller);
  const value =
    typeof update === "function" ? (update as (previous: Value) => Value)(previous) : update;
  controller.localRevision += 1;
  const localRevision = controller.localRevision;
  const mutation: PersistedAtomMutation = {
    key: controller.definition.storageKey,
    value: controller.definition.encode(value),
    mutationId: createMutationId(),
  };
  const promise = new Promise<void>((resolve, reject) => {
    controller.pending.push({
      mutation,
      localRevision,
      value,
      state: "queued",
      resolve,
      reject,
    });
  });
  if (controller.definition.optimistic) publish(controller);
  void ensureHydrated(controller);
  pump(controller);
  return promise;
}

function pump<Value>(controller: PersistedController<Value>): void {
  const queued = controller.pending.filter((pending) => pending.state === "queued");
  for (const next of queued) {
    next.state = "sending";
    void controller.transport
      .mutate(next.mutation)
      .then((event) => {
        applyEvent(controller, event);
        next.resolve();
      })
      .catch((error: unknown) => {
        const normalized = toError(error);
        const stillPending = controller.pending.includes(next);
        next.reject(normalized);
        if (!stillPending) return;
        if (controller.definition.writeFailure === "rollback") {
          controller.pending = controller.pending.filter((pending) => pending !== next);
        } else {
          next.state = "failed";
        }
        controller.status = "error";
        controller.error = normalized;
        publish(controller);
      });
  }
}

function applyEvent<Value>(
  controller: PersistedController<Value>,
  event: PersistedAtomEvent,
): void {
  const matching = controller.pending.find(
    (pending) => pending.mutation.mutationId === event.mutationId,
  );
  if (!matching && controller.definition.synchronization !== "cross-window") return;
  if (event.revision > controller.confirmedRevision) {
    try {
      controller.confirmedValue = controller.definition.decode(event.value);
      controller.confirmedRevision = event.revision;
    } catch (error) {
      controller.status = "error";
      controller.error = toError(error);
      publish(controller);
      return;
    }
  }
  if (matching) {
    controller.pending = controller.pending.filter(
      (pending) => pending.localRevision > matching.localRevision,
    );
  }
  controller.status = "ready";
  controller.error = null;
  publish(controller);
}

function visibleValue<Value>(controller: PersistedController<Value>): Value {
  return controller.pending.at(-1)?.value ?? controller.confirmedValue;
}

function publish<Value>(controller: PersistedController<Value>): void {
  controller.store.jotaiStore.set(controller.baseAtom, {
    status: controller.status,
    value: visibleValue(controller),
    confirmedRevision: controller.confirmedRevision,
    localRevision: controller.localRevision,
    pendingMutationCount: controller.pending.length,
    error: controller.error,
  });
}

function createMutationId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `mutation:${Date.now()}:${Math.random()}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function clearMaitaiPersistenceForTests(): void {
  for (const controller of controllersForTests) {
    controller.unsubscribe?.();
    controller.unsubscribe = null;
  }
  controllersForTests.clear();
  definitionsByKey.clear();
}
