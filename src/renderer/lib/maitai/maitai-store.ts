import { atom, createStore, type Atom, type PrimitiveAtom, type WritableAtom } from "jotai";
import type { QueryClient } from "@tanstack/react-query";

export type ScopeKey = string | number | boolean | symbol | object | null | undefined;

export interface ScopeDefinition<Key, Descriptor = Key> {
  readonly debugLabel: string;
  readonly parent: ScopeDefinition<unknown, never> | null;
  readonly retain: { readonly max: number } | null;
  readonly getKey: (descriptor: Descriptor) => Key;
}

type AnyScopeDefinition = ScopeDefinition<unknown, never>;
type JotaiStore = ReturnType<typeof createStore>;

export interface ScopedGetter {
  <Value>(definition: ScopedAtom<Value>): Value;
  scope<Descriptor>(definition: ScopeDefinition<unknown, Descriptor>): Descriptor;
  readonly queryClient: QueryClient | null;
}

export interface ScopedSetter {
  <Value, Args extends unknown[], Result>(
    definition: ScopedWritableAtom<Value, Args, Result>,
    ...args: Args
  ): Result;
}

interface ScopedAtomBase<Value> {
  readonly scope: AnyScopeDefinition;
  readonly debugLabel: string;
  readonly readValue?: (get: ScopedGetter) => Value;
  readonly familyMetadata?: {
    readonly owner: object;
    readonly keyToken: unknown;
  };
}

export interface ScopedAtom<Value> extends ScopedAtomBase<Value> {
  readonly kind: "signal" | "derived" | "writable-derived" | "external";
}

export interface ScopedWritableAtom<
  Value,
  Args extends unknown[],
  Result,
> extends ScopedAtom<Value> {
  readonly writeValue?: (get: ScopedGetter, set: ScopedSetter, ...args: Args) => Result;
}

export type ScopedSignalAtom<Value> = ScopedWritableAtom<
  Value,
  [Value | ((previous: Value) => Value)],
  void
> &
  (
    | {
        readonly kind: "signal";
        readonly initialValue: Value;
        readonly initializeValue?: never;
      }
    | {
        readonly kind: "signal";
        readonly initialValue?: never;
        readonly initializeValue: () => Value;
      }
  );

export interface ScopedAtomOptions {
  readonly debugLabel: string;
}

export interface ScopedAtomFamily<Param, AtomType extends ScopedAtom<unknown>> {
  (param: Param): AtomType;
  remove(handle: ScopeHandle, param: Param): boolean;
}

interface ScopedExternalStoreAtom<Value> extends ScopedAtom<Value> {
  readonly kind: "external";
  readonly getSnapshot: () => Value;
  readonly subscribe: (listener: () => void) => () => void;
  readonly equality: (left: Value, right: Value) => boolean;
}

export interface MaitaiDebugEntry {
  readonly path: string;
  readonly definitionLabel: string;
  readonly key: unknown;
  readonly mountedCount: number;
  readonly retained: boolean;
  readonly eligible: boolean;
  readonly lastUsed: number;
  readonly childCount: number;
  readonly concreteBindingCount: number;
  readonly familyEntryCount: number;
  readonly contextVersion: number;
  readonly phase: ScopeNodePhase;
  readonly disposalReason: DisposalReason | null;
}

export type DisposalReason = "lru" | "parent-disposed" | "provider-unmounted" | "renderer-shutdown";
type ScopeNodePhase = "live" | "disposing" | "disposed";

type AnyScopedAtom = ScopedAtom<unknown>;
type AnyJotaiAtom = Atom<unknown>;
type AnyWritableJotaiAtom = WritableAtom<unknown, unknown[], unknown>;

export interface ScopeNode {
  readonly token: AnyScopeDefinition;
  readonly key: unknown;
  readonly keyToken: unknown;
  readonly parent: ScopeNode | null;
  readonly store: InternalMaitaiStore;
  readonly path: string;
  value: unknown;
  queryClient: QueryClient | null;
  readonly contextVersionAtom: PrimitiveAtom<number>;
  signalBindings: Map<AnyScopedAtom, AnyWritableJotaiAtom>;
  cachedBindings: Map<AnyScopedAtom, AnyJotaiAtom>;
  familyBindings: Map<unknown, Map<unknown, unknown>>;
  retainedScopeEntries: Map<AnyScopeDefinition, Map<unknown, RetainedScopeEntry>>;
  readonly externalDisposers: Set<() => void>;
  phase: ScopeNodePhase;
  disposalReason: DisposalReason | null;
}

export interface RetainedScopeEntry {
  readonly node: ScopeNode;
  readonly activeLeases: Set<symbol>;
  readonly contextLeases: Set<symbol>;
  lastUsed: number;
  committed: boolean;
}

export interface ScopeView {
  readonly node: ScopeNode;
  readonly parent: ScopeView | null;
  readonly descriptor: unknown;
  readonly cachedBindings: Map<AnyScopedAtom, AnyJotaiAtom>;
  usePreparedDescriptor: boolean;
}

export interface PreparedScope {
  readonly view: ScopeView;
  readonly entry: RetainedScopeEntry;
  readonly parent: ScopeView;
  readonly definition: AnyScopeDefinition;
  readonly keyToken: unknown;
  readonly isNew: boolean;
  readonly descriptorChanged: boolean;
}

export interface MaitaiStore {
  readonly jotaiStore: JotaiStore;
  readonly queryClient: QueryClient | null;
  readonly cleanupErrors: unknown[];
  readonly disposed: boolean;
}

interface InternalMaitaiStore extends MaitaiStore {
  readonly rootNode: ScopeNode;
  readonly rootView: ScopeView;
  accessSequence: number;
  disposed: boolean;
}

export interface ScopeHandle {
  readonly path: string;
  resolve<Value>(definition: ScopedAtom<Value>): Atom<Value>;
  get<Value>(definition: ScopedAtom<Value>): Value;
  set<Value, Args extends unknown[], Result>(
    definition: ScopedWritableAtom<Value, Args, Result>,
    ...args: Args
  ): Result;
  sub<Value>(definition: ScopedAtom<Value>, listener: () => void): () => void;
}

export const appScope = defineScope({
  debugLabel: "AppScope",
  parent: null,
  getKey: () => "app",
});

export function defineScope<Key, Descriptor = Key>(options: {
  readonly debugLabel: string;
  readonly parent: ScopeDefinition<unknown, never> | null;
  readonly retain?: { readonly max: number };
  readonly getKey: (descriptor: Descriptor) => Key;
}): ScopeDefinition<Key, Descriptor> {
  const debugLabel = options.debugLabel.trim();
  if (!debugLabel) throw new Error("Maitai ScopeDefinition requires a debugLabel");
  if (options.retain && (!Number.isInteger(options.retain.max) || options.retain.max < 0)) {
    throw new Error(`${debugLabel} retention max must be a non-negative integer`);
  }

  return Object.freeze({
    debugLabel,
    parent: options.parent,
    retain: options.retain ?? null,
    getKey: options.getKey,
  }) as ScopeDefinition<Key, Descriptor>;
}

export function scopedAtom<Value>(
  scope: AnyScopeDefinition,
  initialValue: Value,
  options: ScopedAtomOptions,
): ScopedSignalAtom<Value> {
  return Object.freeze({
    kind: "signal" as const,
    scope,
    debugLabel: requireDebugLabel(options.debugLabel),
    initialValue,
  });
}

export function scopedAtomWithInitializer<Value>(
  scope: AnyScopeDefinition,
  initializeValue: () => Value,
  options: ScopedAtomOptions,
): ScopedSignalAtom<Value> {
  return Object.freeze({
    kind: "signal" as const,
    scope,
    debugLabel: requireDebugLabel(options.debugLabel),
    initializeValue,
  });
}

export function scopedDerivedAtom<Value>(
  scope: AnyScopeDefinition,
  read: (get: ScopedGetter) => Value,
  options: ScopedAtomOptions,
): ScopedAtom<Value> {
  return Object.freeze({
    kind: "derived" as const,
    scope,
    debugLabel: requireDebugLabel(options.debugLabel),
    readValue: read,
  });
}

export function scopedWritableAtom<Value, Args extends unknown[], Result>(
  scope: AnyScopeDefinition,
  read: (get: ScopedGetter) => Value,
  write: (get: ScopedGetter, set: ScopedSetter, ...args: Args) => Result,
  options: ScopedAtomOptions,
): ScopedWritableAtom<Value, Args, Result> {
  return Object.freeze({
    kind: "writable-derived" as const,
    scope,
    debugLabel: requireDebugLabel(options.debugLabel),
    readValue: read,
    writeValue: write,
  });
}

export function scopedAtomFamily<Param, AtomType extends ScopedAtom<unknown>>(options: {
  readonly scope: AnyScopeDefinition;
  readonly debugLabel: string;
  readonly create: (param: Param) => AtomType;
  readonly key?: (param: Param) => unknown;
  readonly excludeFieldsFromKey?: readonly (keyof Param)[];
}): ScopedAtomFamily<Param, AtomType> {
  const debugLabel = requireDebugLabel(options.debugLabel);
  const owner = Object.freeze({ debugLabel });
  const memberCache = new Map<unknown, AtomType>();
  const resolveKey = (param: Param) =>
    normalizeFamilyParameter(
      options.key ? options.key(param) : param,
      options.key ? undefined : options.excludeFieldsFromKey,
    );

  const family = ((param: Param): AtomType => {
    const keyToken = resolveKey(param);
    const existing = memberCache.get(keyToken);
    if (existing) return existing;
    const inner = options.create(param);
    if (inner.scope !== options.scope) {
      throw new Error(`${debugLabel} member must belong to ${options.scope.debugLabel}`);
    }
    const member = Object.freeze({
      ...inner,
      debugLabel: `${debugLabel}:${formatDebugKey(keyToken)}`,
      familyMetadata: { owner, keyToken },
    }) as AtomType;
    memberCache.set(keyToken, member);
    return member;
  }) as ScopedAtomFamily<Param, AtomType>;

  family.remove = (handle, param) => {
    const view = scopeHandleViews.get(handle);
    if (!view) throw new Error("Unknown Maitai ScopeHandle");
    const target = findScopeView(view, options.scope);
    if (!target) throw new Error(`Missing scope ${options.scope.debugLabel}`);
    const keyToken = resolveKey(param);
    const bindings = target.node.familyBindings.get(owner);
    const binding = bindings?.get(keyToken) as
      | {
          definition: AnyScopedAtom;
        }
      | undefined;
    if (!binding) return false;
    target.node.signalBindings.delete(binding.definition);
    target.node.cachedBindings.delete(binding.definition);
    target.cachedBindings.delete(binding.definition);
    bindings?.delete(keyToken);
    if (bindings?.size === 0) target.node.familyBindings.delete(owner);
    memberCache.delete(keyToken);
    return true;
  };
  return family;
}

export function atomWithExternalStore<Value>(
  scope: AnyScopeDefinition,
  options: {
    readonly debugLabel: string;
    readonly getSnapshot: () => Value;
    readonly subscribe: (listener: () => void) => () => void;
    readonly equality?: (left: Value, right: Value) => boolean;
  },
): ScopedAtom<Value> {
  return Object.freeze({
    kind: "external" as const,
    scope,
    debugLabel: requireDebugLabel(options.debugLabel),
    getSnapshot: options.getSnapshot,
    subscribe: options.subscribe,
    equality: options.equality ?? Object.is,
  });
}

function requireDebugLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new Error("Maitai atom requires a debugLabel");
  return label;
}

function createScopeNode(options: {
  store: InternalMaitaiStore;
  definition: AnyScopeDefinition;
  key: unknown;
  keyToken: unknown;
  parent: ScopeNode | null;
  descriptor: unknown;
  queryClient: QueryClient | null;
}): ScopeNode {
  const parentPath = options.parent?.path;
  const segment = `${options.definition.debugLabel}:${formatDebugKey(options.key)}`;
  return {
    token: options.definition,
    key: options.key,
    keyToken: options.keyToken,
    parent: options.parent,
    store: options.store,
    path: parentPath ? `${parentPath}/${segment}` : segment,
    value: options.descriptor,
    queryClient: options.queryClient,
    contextVersionAtom: atom(0),
    signalBindings: new Map(),
    cachedBindings: new Map(),
    familyBindings: new Map(),
    retainedScopeEntries: new Map(),
    externalDisposers: new Set(),
    phase: "live",
    disposalReason: null,
  };
}

export function createMaitaiStore(options: { queryClient?: QueryClient | null } = {}): MaitaiStore {
  const jotaiStore = createStore();
  const store = {
    jotaiStore,
    rootNode: null as unknown as ScopeNode,
    rootView: null as unknown as ScopeView,
    queryClient: options.queryClient ?? null,
    cleanupErrors: [],
    accessSequence: 0,
    disposed: false,
  } satisfies InternalMaitaiStore;
  const rootNode = createScopeNode({
    store,
    definition: appScope,
    key: "app",
    keyToken: "app",
    parent: null,
    descriptor: {},
    queryClient: store.queryClient,
  });
  const rootView: ScopeView = {
    node: rootNode,
    parent: null,
    descriptor: rootNode.value,
    cachedBindings: rootNode.cachedBindings,
    usePreparedDescriptor: false,
  };
  Reflect.set(store, "rootNode", rootNode);
  Reflect.set(store, "rootView", rootView);
  return store;
}

export function prepareScope<Descriptor>(
  parent: ScopeView,
  definition: ScopeDefinition<unknown, Descriptor>,
  descriptor: Descriptor,
  provisional: PreparedScope | null,
): PreparedScope {
  assertStoreLive(parent.node.store);
  const expectedParent = findScopeView(parent, definition.parent);
  if (!expectedParent || expectedParent !== parent) {
    throw new Error(
      `Missing parent scope ${definition.parent?.debugLabel ?? "<root>"} for ${definition.debugLabel}`,
    );
  }

  const key = definition.getKey(descriptor);
  const keyToken = normalizeMapKey(key);
  const retainedMap = parent.node.retainedScopeEntries.get(definition);
  const existing = retainedMap?.get(keyToken);

  if (existing) {
    assertNodeLive(existing.node);
    const descriptorChanged = !deepEqual(existing.node.value, descriptor);
    const cachedBindings = descriptorChanged
      ? new Map<AnyScopedAtom, AnyJotaiAtom>()
      : existing.node.cachedBindings;
    return {
      view: {
        node: existing.node,
        parent,
        descriptor,
        cachedBindings,
        usePreparedDescriptor: descriptorChanged,
      },
      entry: existing,
      parent,
      definition,
      keyToken,
      isNew: false,
      descriptorChanged,
    };
  }

  if (
    provisional &&
    provisional.isNew &&
    provisional.parent.node === parent.node &&
    provisional.definition === definition &&
    Object.is(provisional.keyToken, keyToken) &&
    provisional.entry.node.phase === "live"
  ) {
    return provisional;
  }

  const node = createScopeNode({
    store: parent.node.store,
    definition,
    key,
    keyToken,
    parent: parent.node,
    descriptor,
    queryClient: parent.node.queryClient,
  });
  const entry: RetainedScopeEntry = {
    node,
    activeLeases: new Set(),
    contextLeases: new Set(),
    lastUsed: 0,
    committed: false,
  };
  return {
    view: {
      node,
      parent,
      descriptor,
      cachedBindings: node.cachedBindings,
      usePreparedDescriptor: true,
    },
    entry,
    parent,
    definition,
    keyToken,
    isNew: true,
    descriptorChanged: false,
  };
}

export function commitPreparedDescriptor(prepared: PreparedScope): void {
  const { entry, view } = prepared;
  assertNodeLive(entry.node);
  if (!prepared.descriptorChanged) {
    view.usePreparedDescriptor = false;
    return;
  }

  entry.node.value = view.descriptor;
  entry.node.cachedBindings = view.cachedBindings;
  entry.node.queryClient = prepared.parent.node.queryClient;
  entry.node.store.jotaiStore.set(entry.node.contextVersionAtom, (version) => version + 1);
  view.usePreparedDescriptor = false;
}

export function publishPreparedScope(prepared: PreparedScope): void {
  if (!prepared.isNew || prepared.entry.committed) return;
  const { definition, entry, keyToken, parent } = prepared;
  if (!definition.retain) {
    entry.committed = true;
    return;
  }

  const entries =
    parent.node.retainedScopeEntries.get(definition) ?? new Map<unknown, RetainedScopeEntry>();
  const existing = entries.get(keyToken);
  if (existing && existing.node !== entry.node) {
    throw new Error(
      `Duplicate committed scope ${definition.debugLabel} at ${entry.node.path}; existing ${existing.node.path}`,
    );
  }
  entries.set(keyToken, entry);
  parent.node.retainedScopeEntries.set(definition, entries);
  entry.committed = true;
}

export function acquirePreparedScope(prepared: PreparedScope): () => void {
  const { entry, definition, parent } = prepared;
  assertNodeLive(entry.node);
  if (entry.activeLeases.size > 0) {
    throw new Error(`Duplicate mounted scope provider: ${entry.node.path}`);
  }
  const lease = Symbol("scope-mount");
  entry.activeLeases.add(lease);
  touchEntry(entry);
  trimRetainedSiblings(parent.node, definition);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (entry.node.phase !== "live") return;
    const removed = entry.activeLeases.delete(lease);
    if (!removed) {
      throw new Error(`Scope lease was not owned by this mount: ${entry.node.path}`);
    }
    touchEntry(entry);
    if (!definition.retain) {
      disposeScopeNode(entry.node, "provider-unmounted");
      return;
    }
    trimRetainedSiblings(parent.node, definition);
  };
}

function touchEntry(entry: RetainedScopeEntry): void {
  entry.node.store.accessSequence += 1;
  entry.lastUsed = entry.node.store.accessSequence;
}

export function trimRetainedSiblings(parent: ScopeNode, childDefinition: AnyScopeDefinition): void {
  const max = childDefinition.retain?.max;
  if (max === undefined) return;
  const entries = parent.retainedScopeEntries.get(childDefinition);
  if (!entries) return;

  while (entries.size > max) {
    let candidate: [unknown, RetainedScopeEntry] | null = null;
    for (const pair of entries) {
      const entry = pair[1];
      if (entry.activeLeases.size > 0 || entry.contextLeases.size > 0) continue;
      if (!candidate || entry.lastUsed < candidate[1].lastUsed) candidate = pair;
    }
    if (!candidate) return;
    entries.delete(candidate[0]);
    disposeScopeNode(candidate[1].node, "lru");
  }
}

export function disposeMaitaiStore(store: MaitaiStore): void {
  const internal = asInternalStore(store);
  if (internal.disposed) return;
  for (const childMap of [...internal.rootNode.retainedScopeEntries.values()]) {
    for (const entry of [...childMap.values()]) {
      disposeScopeNode(entry.node, "renderer-shutdown", true);
    }
  }
  internal.rootNode.retainedScopeEntries.clear();
  internal.rootNode.signalBindings.clear();
  internal.rootNode.cachedBindings.clear();
  internal.rootNode.familyBindings.clear();
  for (const dispose of [...internal.rootNode.externalDisposers]) {
    try {
      dispose();
    } catch (error) {
      internal.cleanupErrors.push(error);
    }
  }
  internal.rootNode.externalDisposers.clear();
  internal.rootNode.phase = "disposed";
  internal.rootNode.disposalReason = "renderer-shutdown";
  internal.disposed = true;
}

export function getMaitaiRootView(store: MaitaiStore): ScopeView {
  return asInternalStore(store).rootView;
}

export function registerMaitaiStoreDisposer(store: MaitaiStore, dispose: () => void): () => void {
  return registerScopeDisposer(asInternalStore(store).rootView, dispose);
}

export function disposeScopeNode(node: ScopeNode, reason: DisposalReason, force = false): void {
  if (node.phase !== "live") return;
  if (!force && findActiveLeaseCount(node) > 0) {
    node.store.cleanupErrors.push(new Error(`Cannot dispose mounted scope ${node.path}`));
    return;
  }
  node.phase = "disposing";
  node.disposalReason = reason;

  const childMaps = [...node.retainedScopeEntries.values()];
  node.retainedScopeEntries.clear();
  for (const childMap of childMaps) {
    for (const entry of childMap.values()) {
      disposeScopeNode(entry.node, "parent-disposed", force);
    }
    childMap.clear();
  }

  for (const dispose of [...node.externalDisposers]) {
    try {
      dispose();
    } catch (error) {
      node.store.cleanupErrors.push(error);
    }
  }
  node.externalDisposers.clear();
  node.signalBindings.clear();
  node.cachedBindings.clear();
  node.familyBindings.clear();
  node.phase = "disposed";
}

function findActiveLeaseCount(node: ScopeNode): number {
  if (!node.parent) return 0;
  const entry = node.parent.retainedScopeEntries.get(node.token)?.get(node.keyToken);
  return entry?.node === node ? entry.activeLeases.size + entry.contextLeases.size : 0;
}

export function createScopeHandle(view: ScopeView): ScopeHandle {
  const assertHandleLive = () => {
    assertNodeLive(view.node);
  };

  const handle: ScopeHandle = {
    path: view.node.path,
    resolve<Value>(definition: ScopedAtom<Value>): Atom<Value> {
      assertHandleLive();
      return resolveConcreteAtom(view, definition);
    },
    get<Value>(definition: ScopedAtom<Value>): Value {
      assertHandleLive();
      return view.node.store.jotaiStore.get(resolveConcreteAtom(view, definition));
    },
    set<Value, Args extends unknown[], Result>(
      definition: ScopedWritableAtom<Value, Args, Result>,
      ...args: Args
    ): Result {
      assertHandleLive();
      const concrete = resolveConcreteAtom(view, definition) as WritableAtom<Value, Args, Result>;
      return view.node.store.jotaiStore.set(concrete, ...args);
    },
    sub<Value>(definition: ScopedAtom<Value>, listener: () => void): () => void {
      assertHandleLive();
      const unsubscribe = view.node.store.jotaiStore.sub(
        resolveConcreteAtom(view, definition),
        listener,
      );
      let active = true;
      const ownedUnsubscribe = () => {
        if (!active) return;
        active = false;
        view.node.externalDisposers.delete(ownedUnsubscribe);
        unsubscribe();
      };
      view.node.externalDisposers.add(ownedUnsubscribe);
      return ownedUnsubscribe;
    },
  };
  scopeHandleViews.set(handle, view);
  return handle;
}

const scopeHandleViews = new WeakMap<object, ScopeView>();

export function getScopeContextView(handle: ScopeHandle, store: MaitaiStore): ScopeView {
  const view = scopeHandleViews.get(handle);
  if (!view) throw new Error("Unknown Maitai ScopeHandle");
  assertNodeLive(view.node);
  if (view.node.store !== asInternalStore(store)) {
    throw new Error("A scope context must belong to the current Maitai store");
  }
  return view;
}

/** Borrow retained context without creating a second state owner or changing its descriptor. */
export function acquireScopeContext(view: ScopeView): () => void {
  const entries: RetainedScopeEntry[] = [];
  let node = view.node;
  while (node.parent) {
    const entry = node.parent.retainedScopeEntries.get(node.token)?.get(node.keyToken);
    if (!entry || entry.node !== node) {
      throw new Error(`A scope context requires a committed retained owner: ${node.path}`);
    }
    assertNodeLive(node);
    entries.push(entry);
    node = node.parent;
  }
  const lease = Symbol("scope-context");
  for (const entry of entries) entry.contextLeases.add(lease);
  return () => {
    for (const entry of entries) {
      if (!entry.contextLeases.delete(lease) || entry.node.phase !== "live") continue;
      touchEntry(entry);
      if (entry.node.parent) trimRetainedSiblings(entry.node.parent, entry.node.token);
    }
  };
}

export function registerScopeDisposer(view: ScopeView, dispose: () => void): () => void {
  assertNodeLive(view.node);
  let active = true;
  const ownedDispose = () => {
    if (!active) return;
    active = false;
    view.node.externalDisposers.delete(ownedDispose);
    dispose();
  };
  view.node.externalDisposers.add(ownedDispose);
  return ownedDispose;
}

export function registerScopeDisposerForTests(
  handle: ScopeHandle,
  dispose: () => void,
): () => void {
  const view = scopeHandleViews.get(handle);
  if (!view) throw new Error("Unknown Maitai ScopeHandle");
  return registerScopeDisposer(view, dispose);
}

export function resolveConcreteAtom<Value>(
  view: ScopeView,
  definition: ScopedAtom<Value>,
): Atom<Value> {
  const target = findScopeView(view, definition.scope);
  if (!target) {
    throw new Error(
      `Missing scope ${definition.scope.debugLabel} while resolving ${definition.debugLabel}`,
    );
  }
  assertNodeLive(target.node);

  const familyMetadata = definition.familyMetadata;
  if (familyMetadata) {
    const familyBindings =
      target.node.familyBindings.get(familyMetadata.owner) ?? new Map<unknown, unknown>();
    const existingFamilyBinding = familyBindings.get(familyMetadata.keyToken) as
      | {
          concrete: Atom<Value>;
        }
      | undefined;
    if (existingFamilyBinding) return existingFamilyBinding.concrete;
    const concrete = resolveConcreteAtomCore(target, definition);
    familyBindings.set(familyMetadata.keyToken, { definition, concrete });
    target.node.familyBindings.set(familyMetadata.owner, familyBindings);
    return concrete;
  }
  return resolveConcreteAtomCore(target, definition);
}

function resolveConcreteAtomCore<Value>(
  target: ScopeView,
  definition: ScopedAtom<Value>,
): Atom<Value> {
  if (definition.kind === "signal") {
    const existing = target.node.signalBindings.get(definition as AnyScopedAtom);
    if (existing) return existing as unknown as Atom<Value>;
    const signal = definition as ScopedSignalAtom<Value>;
    const concrete = atom(signal.initializeValue ? signal.initializeValue() : signal.initialValue);
    concrete.debugLabel = `${target.node.path}/${definition.debugLabel}`;
    target.node.signalBindings.set(
      definition as AnyScopedAtom,
      concrete as unknown as AnyWritableJotaiAtom,
    );
    return concrete;
  }

  const existing = target.cachedBindings.get(definition as AnyScopedAtom);
  if (existing) return existing as Atom<Value>;
  if (definition.kind === "external") {
    const external = definition as ScopedExternalStoreAtom<Value>;
    const baseAtom = atom(external.getSnapshot());
    baseAtom.onMount = (setValue) => {
      let current = external.getSnapshot();
      setValue(current);
      let active = true;
      const unsubscribe = external.subscribe(() => {
        if (!active) return;
        const next = external.getSnapshot();
        if (external.equality(current, next)) return;
        current = next;
        setValue(next);
      });
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    };
    const concrete = atom((get) => get(baseAtom));
    concrete.debugLabel = `${target.node.path}/${definition.debugLabel}`;
    target.cachedBindings.set(definition as AnyScopedAtom, concrete);
    return concrete;
  }
  const concrete =
    definition.kind === "derived"
      ? atom((get) => definition.readValue?.(createScopedGetter(target, get)) as Value)
      : atom(
          (get) => definition.readValue?.(createScopedGetter(target, get)) as Value,
          (get, set, ...args: unknown[]) => {
            const writable = definition as ScopedWritableAtom<Value, unknown[], unknown>;
            return writable.writeValue?.(
              createScopedGetter(target, get),
              createScopedSetter(target, get, set),
              ...args,
            );
          },
        );
  concrete.debugLabel = `${target.node.path}/${definition.debugLabel}`;
  target.cachedBindings.set(definition as AnyScopedAtom, concrete as Atom<unknown>);
  return concrete as Atom<Value>;
}

function createScopedGetter(
  view: ScopeView,
  get: <Value>(atom: Atom<Value>) => Value,
): ScopedGetter {
  const scopedGet = (<Value>(definition: ScopedAtom<Value>): Value =>
    get(resolveConcreteAtom(view, definition))) as ScopedGetter;
  scopedGet.scope = <Descriptor>(definition: ScopeDefinition<unknown, Descriptor>): Descriptor => {
    const target = findScopeView(view, definition);
    if (!target) throw new Error(`Missing scope ${definition.debugLabel}`);
    const descriptors: unknown[] = [];
    let cursor: ScopeView | null = target;
    while (cursor) {
      get(cursor.node.contextVersionAtom);
      const descriptor = cursor.usePreparedDescriptor ? cursor.descriptor : cursor.node.value;
      descriptors.push(descriptor);
      cursor = cursor.parent;
    }
    return mergeScopeDescriptors(descriptors.reverse()) as Descriptor;
  };
  Object.defineProperty(scopedGet, "queryClient", {
    enumerable: true,
    get: () => view.node.queryClient,
  });
  return scopedGet;
}

function createScopedSetter(
  view: ScopeView,
  get: <Value>(atom: Atom<Value>) => Value,
  set: <Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
    ...args: Args
  ) => Result,
): ScopedSetter {
  return (<Value, Args extends unknown[], Result>(
    definition: ScopedWritableAtom<Value, Args, Result>,
    ...args: Args
  ): Result => {
    const concrete = resolveConcreteAtom(view, definition) as WritableAtom<Value, Args, Result>;
    return set(concrete, ...args);
  }) as ScopedSetter;
}

function mergeScopeDescriptors(descriptors: readonly unknown[]): unknown {
  let merged: unknown = {};
  for (const descriptor of descriptors) {
    if (isPlainObject(merged) && isPlainObject(descriptor)) {
      Object.assign(merged, descriptor);
      continue;
    }
    merged = isPlainObject(descriptor) ? { ...descriptor } : descriptor;
  }
  return merged;
}

export function findScopeView(
  view: ScopeView,
  definition: AnyScopeDefinition | null,
): ScopeView | null {
  if (!definition) return null;
  let cursor: ScopeView | null = view;
  while (cursor) {
    if (cursor.node.token === definition) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

export function getMaitaiDebugSnapshot(store: MaitaiStore): MaitaiDebugEntry[] {
  const internal = asInternalStore(store);
  const snapshots: MaitaiDebugEntry[] = [];
  const visit = (node: ScopeNode, entry: RetainedScopeEntry | null) => {
    let childCount = 0;
    for (const childMap of node.retainedScopeEntries.values()) childCount += childMap.size;
    let familyEntryCount = 0;
    for (const familyMap of node.familyBindings.values()) familyEntryCount += familyMap.size;
    snapshots.push({
      path: node.path,
      definitionLabel: node.token.debugLabel,
      key: node.key,
      mountedCount:
        entry?.activeLeases.size ?? (node === internal.rootNode && !internal.disposed ? 1 : 0),
      retained: node.token.retain !== null,
      eligible: Boolean(entry && entry.activeLeases.size === 0 && entry.contextLeases.size === 0),
      lastUsed: entry?.lastUsed ?? 0,
      childCount,
      concreteBindingCount: node.signalBindings.size + node.cachedBindings.size,
      familyEntryCount,
      contextVersion:
        node.phase === "disposed" ? 0 : internal.jotaiStore.get(node.contextVersionAtom),
      phase: node.phase,
      disposalReason: node.disposalReason,
    });
    for (const childMap of node.retainedScopeEntries.values()) {
      for (const childEntry of childMap.values()) visit(childEntry.node, childEntry);
    }
  };
  visit(internal.rootNode, null);
  return snapshots;
}

function assertStoreLive(store: MaitaiStore): void {
  if (store.disposed) throw new Error("Disposed Maitai store cannot recreate state");
}

function asInternalStore(store: MaitaiStore): InternalMaitaiStore {
  if (!("rootNode" in store) || !("rootView" in store)) {
    throw new Error("Unknown Maitai store implementation");
  }
  return store as InternalMaitaiStore;
}

function assertNodeLive(node: ScopeNode): void {
  assertStoreLive(node.store);
  if (node.phase !== "live") throw new Error(`Disposed scope handle: ${node.path}`);
}

function formatDebugKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "symbol") return key.description ?? "symbol";
  if (key === null) return "null";
  if (key === undefined) return "undefined";
  if (typeof key === "object") return stableSerialize(key);
  return String(key);
}

export function normalizeMapKey(value: unknown): unknown {
  if (Array.isArray(value) || isPlainObject(value)) return stableSerialize(value);
  return value;
}

function normalizeFamilyParameter<Param>(
  value: unknown,
  excludeFields: readonly (keyof Param)[] | undefined,
): unknown {
  if (!excludeFields || !isPlainObject(value)) return normalizeMapKey(value);
  const excluded = new Set<PropertyKey>(excludeFields as readonly PropertyKey[]);
  const included = Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
  return normalizeMapKey(included);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "symbol") return `symbol:${value.description ?? ""}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "function") return `function:${value.name}`;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
