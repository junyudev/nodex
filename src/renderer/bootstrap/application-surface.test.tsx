import { StrictMode, act, lazy, useState, type ComponentType, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  ApplicationReadinessRoot,
  ApplicationSurface,
  createApplicationReadiness,
  useApplicationReady,
} from "./application-surface";

function deferredSurface() {
  let resolve = (_module: { default: ComponentType }): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const module = new Promise<{ default: ComponentType }>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { View: lazy(() => module), resolve, reject };
}

function Workbench({
  ready = true,
  children,
}: {
  readonly ready?: boolean;
  readonly children: ReactNode;
}) {
  useApplicationReady(ready);
  return children;
}

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
}

function observeReadiness() {
  const readiness = createApplicationReadiness();
  const success = vi.fn();
  const failure = vi.fn();
  void readiness.ready.then(success, failure);
  return { readiness, success, failure };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "api");
});

describe("application surface readiness", () => {
  test("waits for the ordinary loading branch, including an empty Workbench", async () => {
    const { readiness, success } = observeReadiness();
    const view = render(
      <ApplicationReadinessRoot readiness={readiness}>
        <Workbench ready={false}>
          <span role="status">Loading</span>
        </Workbench>
      </ApplicationReadinessRoot>,
    );
    await act(async () => Promise.resolve());
    expect(success).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench>
            <button>Create project</button>
          </Workbench>
        </ApplicationReadinessRoot>,
      );
    });
    await expect(readiness.ready).resolves.toBeUndefined();
    expect(success).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
  });

  test("waits through nested lazy commits and StrictMode replay without resetting committed state", async () => {
    const outer = deferredSurface();
    const inner = deferredSurface();
    const { readiness, success, failure } = observeReadiness();
    render(
      <StrictMode>
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench>
            <Counter />
            <ApplicationSurface fallback={<span role="status">Opening route</span>}>
              <outer.View />
            </ApplicationSurface>
          </Workbench>
        </ApplicationReadinessRoot>
      </StrictMode>,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Count 0" }).click();
    });
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();

    await act(async () => {
      outer.resolve({
        default: () => (
          <ApplicationSurface fallback={<span role="status">Opening editor</span>}>
            <inner.View />
          </ApplicationSurface>
        ),
      });
    });
    expect(screen.getByRole("status").textContent).toBe("Opening editor");
    expect(success).not.toHaveBeenCalled();

    await act(async () => {
      inner.resolve({ default: () => <button>Edit page</button> });
    });
    await expect(readiness.ready).resolves.toBeUndefined();
    expect(screen.getByRole("button", { name: "Edit page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
    expect(success).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  test("rejects a failed initial lazy import while retaining an operable restart action", async () => {
    const route = deferredSurface();
    const error = new Error("route import failed");
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restartApplication = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "api", { configurable: true, value: { restartApplication } });
    const { readiness, success, failure } = observeReadiness();
    render(
      <ApplicationReadinessRoot readiness={readiness}>
        <Workbench>
          <ApplicationSurface>
            <route.View />
          </ApplicationSurface>
        </Workbench>
      </ApplicationReadinessRoot>,
    );
    await act(async () => route.reject(error));
    await expect(readiness.ready).rejects.toBe(error);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(error);
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Restart Nodex" }).click());
    expect(restartApplication).toHaveBeenCalledOnce();
    expect(
      loggedErrors.mock.calls.flat().some((entry) => String(entry).includes("not wrapped in act")),
    ).toBe(false);
  });

  test("contains later route failures without revisiting readiness or unmounting the Workbench", async () => {
    const route = deferredSurface();
    const { readiness, success, failure } = observeReadiness();
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Routes() {
      const [opened, setOpened] = useState(false);
      return (
        <Workbench>
          <Counter />
          <button onClick={() => setOpened(true)}>Open route</button>
          {opened ? (
            <ApplicationSurface fallback={<span role="status">Opening</span>}>
              <route.View />
            </ApplicationSurface>
          ) : null}
        </Workbench>
      );
    }
    render(
      <ApplicationReadinessRoot readiness={readiness}>
        <Routes />
      </ApplicationReadinessRoot>,
    );
    await act(async () => Promise.resolve());
    await expect(readiness.ready).resolves.toBeUndefined();
    await act(async () => {
      screen.getByRole("button", { name: "Count 0" }).click();
      screen.getByRole("button", { name: "Open route" }).click();
    });
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => route.reject(new Error("later import failed")));
    expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart Nodex" })).toBeTruthy();
    expect(success).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(
      loggedErrors.mock.calls.flat().some((entry) => String(entry).includes("not wrapped in act")),
    ).toBe(false);
  });

  test("rejects an unmounted pending root and does not retain work across another mount", async () => {
    const route = deferredSurface();
    const { readiness, success } = observeReadiness();
    const view = render(
      <StrictMode>
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench>
            <ApplicationSurface>
              <route.View />
            </ApplicationSurface>
          </Workbench>
        </ApplicationReadinessRoot>
      </StrictMode>,
    );
    await act(async () => view.unmount());
    await expect(readiness.ready).rejects.toThrow("unmounted before opening");
    await act(async () => route.resolve({ default: () => <button>Obsolete route</button> }));
    expect(success).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Obsolete route" })).toBeNull();

    const next = observeReadiness();
    render(
      <ApplicationReadinessRoot readiness={next.readiness}>
        <Workbench>
          <button>Welcome</button>
        </Workbench>
      </ApplicationReadinessRoot>,
    );
    await act(async () => Promise.resolve());
    await expect(next.readiness.ready).resolves.toBeUndefined();
  });

  test("also recovers errors outside a local Suspense boundary", async () => {
    const error = new Error("root render failed");
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { readiness } = observeReadiness();
    function BrokenWorkbench(): ReactNode {
      throw error;
    }
    render(
      <ApplicationReadinessRoot readiness={readiness}>
        <BrokenWorkbench />
      </ApplicationReadinessRoot>,
    );
    await act(async () => Promise.resolve());
    await expect(readiness.ready).rejects.toBe(error);
    expect(screen.getByRole("button", { name: "Restart Nodex" })).toBeTruthy();
    expect(
      loggedErrors.mock.calls.flat().some((entry) => String(entry).includes("not wrapped in act")),
    ).toBe(false);
  });
});
