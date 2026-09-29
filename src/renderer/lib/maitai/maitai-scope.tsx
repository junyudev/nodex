import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Provider, useAtomValue, useSetAtom } from "jotai";
import {
  acquirePreparedScope,
  acquireScopeContext,
  commitPreparedDescriptor,
  createScopeHandle,
  findScopeView,
  getMaitaiRootView,
  getScopeContextView,
  prepareScope,
  publishPreparedScope,
  resolveConcreteAtom,
  type MaitaiStore,
  type PreparedScope,
  type ScopeDefinition,
  type ScopeHandle,
  type ScopedAtom,
  type ScopedWritableAtom,
  type ScopeView,
} from "./maitai-store";

const MaitaiStoreContext = createContext<MaitaiStore | null>(null);
const ScopeViewContext = createContext<ScopeView | null>(null);

export function MaitaiProvider({
  store,
  children,
}: {
  readonly store: MaitaiStore;
  readonly children: ReactNode;
}) {
  const parentStore = useContext(MaitaiStoreContext);
  if (parentStore) throw new Error("MaitaiProvider cannot be nested");
  if (store.disposed) throw new Error("Cannot mount a disposed Maitai store");
  const rootView = getMaitaiRootView(store);
  return (
    <Provider store={store.jotaiStore}>
      <MaitaiStoreContext.Provider value={store}>
        <ScopeViewContext.Provider value={rootView}>{children}</ScopeViewContext.Provider>
      </MaitaiStoreContext.Provider>
    </Provider>
  );
}

export function ScopeProvider<Key, Descriptor>({
  scope,
  descriptor,
  children,
}: {
  readonly scope: ScopeDefinition<Key, Descriptor>;
  readonly descriptor: Descriptor;
  readonly children: ReactNode;
}) {
  const parent = useRequiredScopeView();
  const provisionalRef = useRef<PreparedScope | null>(null);
  const prepared = prepareScope(
    parent,
    scope as ScopeDefinition<unknown, Descriptor>,
    descriptor,
    provisionalRef.current,
  );
  provisionalRef.current = prepared;

  useLayoutEffect(() => {
    commitPreparedDescriptor(prepared);
  }, [prepared]);

  useLayoutEffect(() => {
    publishPreparedScope(prepared);
  }, [prepared]);

  useLayoutEffect(() => acquirePreparedScope(prepared), [prepared]);

  return <ScopeViewContext.Provider value={prepared.view}>{children}</ScopeViewContext.Provider>;
}

export function useMaitaiStore(): MaitaiStore {
  const store = useContext(MaitaiStoreContext);
  if (!store) throw new Error("Maitai hooks require MaitaiProvider");
  return store;
}

/** App-level overlays borrow their mounted caller's committed context until dismissal. */
export function ScopeContextBridge({
  handle,
  children,
}: {
  readonly handle: ScopeHandle;
  readonly children: ReactNode;
}) {
  const store = useMaitaiStore();
  const view = getScopeContextView(handle, store);
  useLayoutEffect(() => acquireScopeContext(view), [view]);
  return <ScopeViewContext.Provider value={view}>{children}</ScopeViewContext.Provider>;
}

export function useScopeHandle(definition: ScopeDefinition<unknown, never>): ScopeHandle {
  const view = useRequiredScopeView();
  const target = findScopeView(view, definition);
  if (!target) throw new Error(`Missing scope ${definition.debugLabel}`);
  return useMemo(() => createScopeHandle(target), [target]);
}

export function useScopedAtomValue<Value>(definition: ScopedAtom<Value>): Value {
  const view = useRequiredScopeView();
  const concrete = resolveConcreteAtom(view, definition);
  return useAtomValue(concrete);
}

export function useSetScopedAtom<Value, Args extends unknown[], Result>(
  definition: ScopedWritableAtom<Value, Args, Result>,
): (...args: Args) => Result {
  const view = useRequiredScopeView();
  const concrete = resolveConcreteAtom(view, definition);
  return useSetAtom(concrete as import("jotai").WritableAtom<Value, Args, Result>);
}

export function useScopedAtom<Value>(
  definition: ScopedWritableAtom<Value, [Value | ((previous: Value) => Value)], void>,
): readonly [Value, (update: Value | ((previous: Value) => Value)) => void] {
  return [useScopedAtomValue(definition), useSetScopedAtom(definition)] as const;
}

function useRequiredScopeView(): ScopeView {
  useMaitaiStore();
  const view = useContext(ScopeViewContext);
  if (!view) throw new Error("Maitai scope requires MaitaiProvider");
  return view;
}
