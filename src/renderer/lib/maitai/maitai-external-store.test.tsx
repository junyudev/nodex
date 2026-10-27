import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  MaitaiProvider,
  ScopeProvider,
  appScope,
  atomWithExternalStore,
  createMaitaiStore,
  defineScope,
  useScopedAtomValue,
} from "./index";

const threadScope = defineScope({
  debugLabel: "ExternalThreadScope",
  parent: appScope,
  retain: { max: 20 },
  getKey: (value: string) => value,
});

describe("Maitai external-store bridge", () => {
  test("observes a synchronous snapshot change when the bridge mounts", async () => {
    let snapshot = "before subscription";
    const externalAtom = atomWithExternalStore(appScope, {
      debugLabel: "mount-snapshot",
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        snapshot = "after subscription";
        listener();
        return () => undefined;
      },
    });
    function Probe() {
      return <output>{useScopedAtomValue(externalAtom)}</output>;
    }
    const view = render(
      <MaitaiProvider store={createMaitaiStore()}>
        <Probe />
      </MaitaiProvider>,
    );
    try {
      expect(await view.findByText("after subscription")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  test("subscribes once per concrete bridge and releases on React unmount", () => {
    let snapshot = 1;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const listeners = new Set<() => void>();
    const externalAtom = atomWithExternalStore(threadScope, {
      debugLabel: "external-count",
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        subscribeCount += 1;
        listeners.add(listener);
        return () => {
          unsubscribeCount += 1;
          listeners.delete(listener);
        };
      },
    });

    function Probe() {
      return <output>{useScopedAtomValue(externalAtom)}</output>;
    }

    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor="thread-a">
          <Probe />
          <Probe />
        </ScopeProvider>
      </MaitaiProvider>,
    );
    expect(view.getAllByText("1")).toHaveLength(2);
    expect(subscribeCount).toBe(1);

    act(() => {
      snapshot = 2;
      for (const listener of listeners) listener();
    });
    expect(view.getAllByText("2")).toHaveLength(2);
    view.unmount();
    expect(unsubscribeCount).toBe(1);
  });

  test("uses the configured equality before publishing a snapshot", () => {
    let snapshot = { revision: 1, value: "same" };
    const listeners = new Set<() => void>();
    let renderCount = 0;
    const externalAtom = atomWithExternalStore(threadScope, {
      debugLabel: "equal-external-value",
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      equality: (left, right) => left.value === right.value,
    });
    function Probe() {
      renderCount += 1;
      return <output>{useScopedAtomValue(externalAtom).value}</output>;
    }
    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <ScopeProvider scope={threadScope} descriptor="thread-a">
          <Probe />
        </ScopeProvider>
      </MaitaiProvider>,
    );
    const initialRenderCount = renderCount;
    act(() => {
      snapshot = { revision: 2, value: "same" };
      for (const listener of listeners) listener();
    });
    expect(view.getByText("same")).toBeTruthy();
    expect(renderCount).toBe(initialRenderCount);
  });
});
