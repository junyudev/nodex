import { Fragment, StrictMode, useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  MaitaiProvider,
  ScopeProvider,
  ScopeContextBridge,
  appScope,
  createMaitaiStore,
  defineScope,
  getMaitaiDebugSnapshot,
  scopedAtom,
  scopedAtomWithInitializer,
  scopedDerivedAtom,
  useScopeHandle,
  useScopedAtomValue,
  useSetScopedAtom,
  type ScopeHandle,
} from "./index";

const threadScope = defineScope({
  debugLabel: "ThreadScope",
  parent: appScope,
  retain: { max: 20 },
  getKey: (descriptor: { stableKey: string; label: string }) => descriptor.stableKey,
});

const routeScope = defineScope({
  debugLabel: "RouteScope",
  parent: threadScope,
  retain: { max: 20 },
  getKey: (descriptor: { route: string }) => descriptor.route,
});

const composerScope = defineScope({
  debugLabel: "ComposerScope",
  parent: routeScope,
  retain: { max: 100 },
  getKey: (descriptor: { identity: string }) => descriptor.identity,
});

const countAtom = scopedAtom(threadScope, 0, { debugLabel: "count" });
const labelAtom = scopedDerivedAtom(
  threadScope,
  (get) => `${get.scope(threadScope).label}:${get(countAtom)}`,
  { debugLabel: "label" },
);
const routeValueAtom = scopedAtom(routeScope, "empty", { debugLabel: "route-value" });
const composerValueAtom = scopedAtom(composerScope, "empty", { debugLabel: "composer-value" });

function ThreadProbe({ onHandle }: { onHandle(handle: ScopeHandle): void }) {
  const handle = useScopeHandle(threadScope);
  const label = useScopedAtomValue(labelAtom);
  const setCount = useSetScopedAtom(countAtom);

  useLayoutEffect(() => {
    onHandle(handle);
  }, [handle, onHandle]);

  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {label}
    </button>
  );
}

describe("Maitai scoped lifecycle", () => {
  test("an overlay borrows one retained owner, pins it across route changes, and releases on close", async () => {
    const store = createMaitaiStore();
    const scope = defineScope({
      debugLabel: "OverlayOwner",
      parent: appScope,
      retain: { max: 1 },
      getKey: (descriptor: { key: string }) => descriptor.key,
    });
    const state = scopedAtom(scope, 0, { debugLabel: "overlay-owner-state" });
    let owner: ScopeHandle | null = null;
    function Capture() {
      const handle = useScopeHandle(scope);
      useLayoutEffect(() => {
        owner ??= handle;
      }, [handle]);
      return null;
    }
    function Detail() {
      return <output aria-label="Borrowed state">{useScopedAtomValue(state)}</output>;
    }
    const tree = (key: string, bridge: boolean) => (
      <StrictMode>
        <MaitaiProvider store={store}>
          <ScopeProvider scope={scope} descriptor={{ key }}>
            <Capture />
          </ScopeProvider>
          {bridge && owner ? (
            <ScopeContextBridge handle={owner}>
              <Detail />
            </ScopeContextBridge>
          ) : null}
        </MaitaiProvider>
      </StrictMode>
    );
    const view = render(tree("parent", false));
    const parent = owner as ScopeHandle | null;
    if (!parent) throw new Error("Expected captured owner");
    await act(async () => {
      parent.set(state, 7);
    });
    view.rerender(tree("parent", true));
    expect(view.getByLabelText("Borrowed state").textContent).toBe("7");
    view.rerender(tree("other", true));
    expect(view.getByLabelText("Borrowed state").textContent).toBe("7");
    expect(parent.get(state)).toBe(7);
    expect(
      getMaitaiDebugSnapshot(store).find((entry) => entry.path === parent.path)?.eligible,
    ).toBe(false);
    view.rerender(tree("other", false));
    expect(() => parent.get(state)).toThrow(/disposed/i);
    expect(store.cleanupErrors).toEqual([]);
    view.unmount();
  });

  test("an overlay cannot borrow a scope from another renderer store", () => {
    const firstStore = createMaitaiStore();
    let owner: ScopeHandle | null = null;
    function Capture() {
      const handle = useScopeHandle(threadScope);
      useLayoutEffect(() => {
        owner = handle;
      }, [handle]);
      return null;
    }
    const first = render(
      <MaitaiProvider store={firstStore}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "parent", label: "Parent" }}>
          <Capture />
        </ScopeProvider>
      </MaitaiProvider>,
    );
    const parent = owner as ScopeHandle | null;
    if (!parent) throw new Error("Expected captured owner");
    expect(() =>
      render(
        <MaitaiProvider store={createMaitaiStore()}>
          <ScopeContextBridge handle={parent}>
            <span>Other store</span>
          </ScopeContextBridge>
        </MaitaiProvider>,
      ),
    ).toThrow("A scope context must belong to the current Maitai store");
    first.unmount();
  });

  test("initializes lazy signal values once per renderer store", () => {
    let initializationCount = 0;
    const initializedAtom = scopedAtomWithInitializer(
      appScope,
      () => {
        initializationCount += 1;
        return initializationCount;
      },
      { debugLabel: "initialized-on-bind" },
    );
    const observed: number[] = [];

    function Probe() {
      observed.push(useScopedAtomValue(initializedAtom));
      return null;
    }

    const firstStore = createMaitaiStore();
    const firstView = render(
      <MaitaiProvider store={firstStore}>
        <Probe />
      </MaitaiProvider>,
    );
    firstView.rerender(
      <MaitaiProvider store={firstStore}>
        <Probe />
      </MaitaiProvider>,
    );
    render(
      <MaitaiProvider store={createMaitaiStore()}>
        <Probe />
      </MaitaiProvider>,
    );

    expect(initializationCount).toBe(2);
    expect(observed[0]).toBe(1);
    expect(observed.at(-1)).toBe(2);
    expect(observed.every((value) => value === 1 || value === 2)).toBe(true);
  });

  test("same-key descriptor updates preserve signals and invalidate derived values", () => {
    const store = createMaitaiStore();
    const handleRef: { current: ScopeHandle | null } = { current: null };
    const onHandle = (next: ScopeHandle) => {
      handleRef.current = next;
    };

    const view = render(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
          <ThreadProbe onHandle={onHandle} />
        </ScopeProvider>
      </MaitaiProvider>,
    );

    expect(view.getByRole("button").textContent).toBe("A:0");
    act(() => view.getByRole("button").click());
    expect(view.getByRole("button").textContent).toBe("A:1");
    const firstConcrete = handleRef.current?.resolve(countAtom);
    const firstDerivedConcrete = handleRef.current?.resolve(labelAtom);

    view.rerender(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
          <ThreadProbe onHandle={onHandle} />
        </ScopeProvider>
      </MaitaiProvider>,
    );
    expect(handleRef.current?.resolve(countAtom)).toBe(firstConcrete);
    expect(handleRef.current?.resolve(labelAtom)).toBe(firstDerivedConcrete);

    view.rerender(
      <MaitaiProvider store={store}>
        <ScopeProvider
          scope={threadScope}
          descriptor={{ stableKey: "session:a", label: "A renamed" }}
        >
          <ThreadProbe onHandle={onHandle} />
        </ScopeProvider>
      </MaitaiProvider>,
    );

    expect(view.getByRole("button").textContent).toBe("A renamed:1");
    expect(handleRef.current?.resolve(countAtom)).toBe(firstConcrete);
    expect(handleRef.current?.resolve(labelAtom)).not.toBe(firstDerivedConcrete);
    expect(
      getMaitaiDebugSnapshot(store).find((entry) => entry.path.endsWith("session:a"))
        ?.contextVersion,
    ).toBe(1);
  });

  test("equal route keys below different thread parents are isolated", () => {
    const store = createMaitaiStore();
    const handles: ScopeHandle[] = [];

    function RouteProbe() {
      const handle = useScopeHandle(routeScope);
      useLayoutEffect(() => {
        handles.push(handle);
      }, [handle]);
      return null;
    }

    const view = render(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
          <ScopeProvider scope={routeScope} descriptor={{ route: "/thread" }}>
            <RouteProbe />
          </ScopeProvider>
        </ScopeProvider>
      </MaitaiProvider>,
    );

    view.rerender(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:b", label: "B" }}>
          <ScopeProvider scope={routeScope} descriptor={{ route: "/thread" }}>
            <RouteProbe />
          </ScopeProvider>
        </ScopeProvider>
      </MaitaiProvider>,
    );

    expect(handles).toHaveLength(2);
    handles[0]?.set(routeValueAtom, "A route");
    handles[1]?.set(routeValueAtom, "B route");
    expect(handles[0]?.get(routeValueAtom)).toBe("A route");
    expect(handles[1]?.get(routeValueAtom)).toBe("B route");
    expect(handles[0]?.resolve(routeValueAtom)).not.toBe(handles[1]?.resolve(routeValueAtom));
  });

  test("StrictMode effect replay leaves one active lease", () => {
    const store = createMaitaiStore();
    const view = render(
      <StrictMode>
        <MaitaiProvider store={store}>
          <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
            <ThreadProbe onHandle={() => undefined} />
          </ScopeProvider>
        </MaitaiProvider>
      </StrictMode>,
    );

    expect(
      getMaitaiDebugSnapshot(store).find((entry) => entry.path.endsWith("session:a"))?.mountedCount,
    ).toBe(1);
    view.unmount();
    expect(
      getMaitaiDebugSnapshot(store).find((entry) => entry.path.endsWith("session:a"))?.mountedCount,
    ).toBe(0);
  });

  test("ThreadScope retains exactly 20 unmounted entries and finalizes an evicted handle", () => {
    const store = createMaitaiStore();
    const handles: ScopeHandle[] = [];

    const renderThread = (index: number) => (
      <MaitaiProvider store={store}>
        <ScopeProvider
          scope={threadScope}
          descriptor={{ stableKey: `session:${index}`, label: `Thread ${index}` }}
        >
          <ThreadProbe
            onHandle={(handle) => {
              handles[index] = handle;
            }}
          />
        </ScopeProvider>
      </MaitaiProvider>
    );

    const view = render(renderThread(0));
    for (let index = 1; index <= 20; index += 1) {
      view.rerender(renderThread(index));
    }

    const retainedThreads = getMaitaiDebugSnapshot(store).filter(
      (entry) => entry.definitionLabel === "ThreadScope",
    );
    expect(retainedThreads).toHaveLength(20);
    expect(retainedThreads.some((entry) => entry.path.endsWith("session:0"))).toBe(false);
    expect(() => handles[0]?.get(countAtom)).toThrow(/disposed/i);
  });

  test("RouteScope retains exactly 20 entries independently below each ThreadScope", () => {
    const store = createMaitaiStore();
    const renderRoute = (thread: "a" | "b", routeIndex: number) => (
      <MaitaiProvider store={store}>
        <ScopeProvider
          scope={threadScope}
          descriptor={{ stableKey: `session:${thread}`, label: thread.toUpperCase() }}
        >
          <ScopeProvider scope={routeScope} descriptor={{ route: `/route/${routeIndex}` }}>
            <Fragment />
          </ScopeProvider>
        </ScopeProvider>
      </MaitaiProvider>
    );
    const view = render(renderRoute("a", 0));
    for (let index = 1; index <= 20; index += 1) view.rerender(renderRoute("a", index));
    for (let index = 0; index <= 20; index += 1) view.rerender(renderRoute("b", index));

    const routes = getMaitaiDebugSnapshot(store).filter(
      (entry) => entry.definitionLabel === "RouteScope",
    );
    expect(routes.filter((entry) => entry.path.includes("ThreadScope:session:a/"))).toHaveLength(
      20,
    );
    expect(routes.filter((entry) => entry.path.includes("ThreadScope:session:b/"))).toHaveLength(
      20,
    );
  });

  test("ComposerScope retains exactly 100 entries below its RouteScope", () => {
    const store = createMaitaiStore();
    const handles: ScopeHandle[] = [];
    function ComposerProbe({ index }: { index: number }) {
      const handle = useScopeHandle(composerScope);
      useLayoutEffect(() => {
        handles[index] = handle;
      }, [handle, index]);
      return null;
    }
    const renderComposer = (index: number) => (
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
          <ScopeProvider scope={routeScope} descriptor={{ route: "/thread" }}>
            <ScopeProvider scope={composerScope} descriptor={{ identity: `composer:${index}` }}>
              <ComposerProbe index={index} />
            </ScopeProvider>
          </ScopeProvider>
        </ScopeProvider>
      </MaitaiProvider>
    );
    const view = render(renderComposer(0));
    for (let index = 1; index <= 100; index += 1) view.rerender(renderComposer(index));

    expect(
      getMaitaiDebugSnapshot(store).filter((entry) => entry.definitionLabel === "ComposerScope"),
    ).toHaveLength(100);
    expect(() => handles[0]?.get(composerValueAtom)).toThrow(/disposed/i);
  });

  test("remount-before-trim-preserves-the-reused-node-and-evicts-the-older-sibling", () => {
    const scope = defineScope({
      debugLabel: "RemountScope",
      parent: appScope,
      retain: { max: 2 },
      getKey: (value: string) => value,
    });
    const valueAtom = scopedAtom(scope, 0, { debugLabel: "value" });
    const handles: Record<string, ScopeHandle> = {};
    const store = createMaitaiStore();
    function Probe({ scopeKey }: { scopeKey: string }) {
      const handle = useScopeHandle(scope);
      useLayoutEffect(() => {
        handles[scopeKey] = handle;
      }, [handle, scopeKey]);
      return null;
    }
    const tree = (scopeKey: string) => (
      <MaitaiProvider store={store}>
        <ScopeProvider scope={scope} descriptor={scopeKey}>
          <Probe scopeKey={scopeKey} />
        </ScopeProvider>
      </MaitaiProvider>
    );
    const view = render(tree("a"));
    handles.a?.set(valueAtom, 7);
    const concreteA = handles.a?.resolve(valueAtom);
    view.rerender(tree("b"));
    view.rerender(tree("a"));
    expect(handles.a?.resolve(valueAtom)).toBe(concreteA);
    view.rerender(tree("c"));

    expect(handles.a?.get(valueAtom)).toBe(7);
    expect(() => handles.b?.get(valueAtom)).toThrow(/disposed/i);
  });

  test("retention maps are isolated by child ScopeDefinition", () => {
    const firstScope = defineScope({
      debugLabel: "FirstChildScope",
      parent: threadScope,
      retain: { max: 1 },
      getKey: (value: string) => value,
    });
    const secondScope = defineScope({
      debugLabel: "SecondChildScope",
      parent: threadScope,
      retain: { max: 1 },
      getKey: (value: string) => value,
    });
    const store = createMaitaiStore();
    const tree = (firstKey: string, secondKey: string) => (
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor={{ stableKey: "session:a", label: "A" }}>
          <ScopeProvider scope={firstScope} descriptor={firstKey}>
            <Fragment />
          </ScopeProvider>
          <ScopeProvider scope={secondScope} descriptor={secondKey}>
            <Fragment />
          </ScopeProvider>
        </ScopeProvider>
      </MaitaiProvider>
    );
    const view = render(tree("a", "a"));
    view.rerender(tree("b", "b"));
    const snapshot = getMaitaiDebugSnapshot(store);
    expect(snapshot.filter((entry) => entry.definitionLabel === "FirstChildScope")).toHaveLength(1);
    expect(snapshot.filter((entry) => entry.definitionLabel === "SecondChildScope")).toHaveLength(
      1,
    );
  });
});
