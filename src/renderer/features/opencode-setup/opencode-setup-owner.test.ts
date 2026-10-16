import { describe, expect, test, vi } from "vite-plus/test";
import { createOpenCodeSetupOwner } from "./opencode-setup-owner";
import { fakeSetupRuntime, readyExecutable, setupState } from "./opencode-setup.test-fixtures";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const running = (revision: number, progress: number | null = null) =>
  setupState(revision, {
    installation: { phase: "running", log: { lines: ["Installing"], progress } },
  });

describe("OpenCode setup owner", () => {
  test("reads only once observed and stops listening when the last observer leaves", async () => {
    const main = fakeSetupRuntime(setupState(1));
    const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
    expect(main.runtime.read).not.toHaveBeenCalled();
    const stop = owner.subscribe(() => {});
    await flush();
    expect(main.runtime.read).toHaveBeenCalledOnce();
    expect(owner.getSnapshot().state?.revision).toBe(1);
    stop();
    expect(main.listeners.size).toBe(0);
  });

  test("a late read cannot replace newer progress from an event", async () => {
    const main = fakeSetupRuntime(setupState(1));
    let answer!: () => void;
    main.runtime.read.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(setupState(1)))),
    );
    const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
    owner.subscribe(() => {});
    main.emit(running(2, 0.4));
    answer();
    await flush();
    expect(owner.getSnapshot().state).toEqual(running(2, 0.4));
  });

  test("counts readiness only when observed changing, not when first read", async () => {
    const main = fakeSetupRuntime(setupState(1, { executable: readyExecutable() }));
    const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
    owner.subscribe(() => {});
    await flush();
    expect(owner.getSnapshot().readyEpoch).toBe(0);
    main.emit(setupState(2));
    main.emit(setupState(3, { executable: readyExecutable() }));
    expect(owner.getSnapshot().readyEpoch).toBe(1);
  });

  test("keeps a rejected install request retryable without inventing Main state", async () => {
    const main = fakeSetupRuntime(setupState(1));
    main.runtime.install.mockRejectedValueOnce(new Error("Main is unavailable"));
    const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
    owner.subscribe(() => {});
    await flush();
    await owner.install();
    expect(owner.getSnapshot()).toMatchObject({
      state: setupState(1),
      request: null,
      requestError: { request: "install", message: "Main is unavailable" },
    });
  });

  test("announces an outcome only for an installation started here with no open view", async () => {
    const main = fakeSetupRuntime(setupState(1));
    const announce = vi.fn();
    const owner = createOpenCodeSetupOwner(main.runtime, announce);
    owner.subscribe(() => {});
    await flush();

    // Another window's installation is not this window's to report.
    main.emit(running(2));
    main.emit(setupState(3, { executable: { status: "missing" } }));
    expect(announce).not.toHaveBeenCalled();

    // A mounted progress view already shows the outcome.
    main.set(running(4));
    const release = owner.retainViewer();
    await owner.install();
    main.emit(
      setupState(5, {
        installation: {
          phase: "failed",
          log: { lines: [], progress: null },
          reason: "timeout",
          message: "OpenCode installation timed out.",
        },
      }),
    );
    expect(announce).not.toHaveBeenCalled();
    release();

    // Once dismissed, a finished installation is reported once.
    main.set(running(6));
    await owner.install();
    const ready = setupState(7, {
      executable: readyExecutable(),
      installation: { phase: "succeeded", log: { lines: [], progress: 1 } },
    });
    main.emit(ready);
    main.emit(setupState(8, { executable: readyExecutable() }));
    expect(announce).toHaveBeenCalledExactlyOnceWith(ready);
  });

  test("an installation that finds an executable it must not replace still finishes", async () => {
    const main = fakeSetupRuntime(running(1));
    const announce = vi.fn();
    const owner = createOpenCodeSetupOwner(main.runtime, announce);
    owner.subscribe(() => {});
    await owner.install();
    const outdated = setupState(2, {
      executable: {
        status: "incompatible",
        binaryPath: "/opt/homebrew/bin/opencode",
        version: "1.10.2",
        minimumVersion: "1.14.19",
      },
    });
    main.emit(outdated);
    expect(announce).toHaveBeenCalledExactlyOnceWith(outdated);
  });

  test("cancelling marks the request and adopts Main's idle answer without an announcement", async () => {
    const main = fakeSetupRuntime(running(1));
    const announce = vi.fn();
    const owner = createOpenCodeSetupOwner(main.runtime, announce);
    owner.subscribe(() => {});
    await owner.install();
    main.set(setupState(2));
    const cancelled = owner.cancel();
    expect(owner.getSnapshot().request).toBe("cancel");
    await cancelled;
    expect(owner.getSnapshot()).toMatchObject({ request: null, state: setupState(2) });
    expect(announce).not.toHaveBeenCalled();
  });
});
