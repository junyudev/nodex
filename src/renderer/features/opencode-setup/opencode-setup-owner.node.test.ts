import { describe, expect, test, vi } from "vite-plus/test";
import type { AgentEnvironmentVariable } from "../../../shared/agent-environment";
import { openCodeProfile } from "../../../shared/agents/profile.test-fixtures";
import type { OpenCodeInstallFailureReason } from "../../../shared/opencode-setup";
import {
  openCodeExecutableStatusAction,
  openCodeInstallView,
  dependsOnHostOpenCode,
  openCodeInstallationReadiness,
  usesHostOpenCodeExecutable,
  type OpenCodeSetupInstance,
} from "./opencode-setup-model";
import {
  EMPTY_OPENCODE_SETUP_SNAPSHOT,
  type OpenCodeSetupSnapshot,
  createOpenCodeSetupOwner,
} from "./opencode-setup-owner";
import { readyExecutable, setupState, fakeSetupRuntime } from "./opencode-setup.test-fixtures";

describe("opencode setup model", () => {
  const snapshot = (patch: Partial<OpenCodeSetupSnapshot>): OpenCodeSetupSnapshot => ({
    ...EMPTY_OPENCODE_SETUP_SNAPSHOT,
    ...patch,
  });
  const hostProfile: OpenCodeSetupInstance = {
    binding: { driver: "opencode" },
    enabled: true,
    usesHostExecutable: true,
  };
  const missing = snapshot({ state: setupState(1) });
  const failed = (reason: OpenCodeInstallFailureReason, executable = setupState(0).executable) =>
    snapshot({
      state: setupState(2, {
        executable,
        installation: {
          phase: "failed",
          log: { lines: ["curl: (6) Could not resolve host"], progress: null },
          reason,
          message: "Installation failed.",
        },
      }),
    });

  describe("profiles that depend on host setup", () => {
    test("only a local profile resolving the bare default executable through the host", () => {
      const base = {
        binaryPath: openCodeProfile().binaryPath,
        serverUrl: null,
        environment: [] as readonly { name: string }[],
      };
      // Saved variables keep their full shape; the predicate reads only their names.
      const explicitPath: AgentEnvironmentVariable = {
        name: "PATH",
        value: "/opt/opencode/bin",
        sensitive: false,
      };
      const providerKey: AgentEnvironmentVariable = {
        name: "OPENROUTER_API_KEY",
        value: null,
        sensitive: true,
      };
      expect(usesHostOpenCodeExecutable(base)).toBe(true);
      expect(usesHostOpenCodeExecutable({ ...base, binaryPath: " opencode " })).toBe(true);
      expect(usesHostOpenCodeExecutable({ ...base, binaryPath: "/opt/bin/opencode" })).toBe(false);
      expect(usesHostOpenCodeExecutable({ ...base, serverUrl: "http://127.0.0.1:4096" })).toBe(
        false,
      );
      expect(usesHostOpenCodeExecutable({ ...base, environment: [explicitPath] })).toBe(false);
      expect(usesHostOpenCodeExecutable({ ...base, environment: [providerKey] })).toBe(true);
      // Unsaved editor rows are trimmed when saved, so a padded draft name already owns PATH.
      expect(usesHostOpenCodeExecutable({ ...base, environment: [{ name: " PATH " }] })).toBe(
        false,
      );
    });
  });

  describe("host installation facts", () => {
    test("only enabled profiles using the host executable depend on installation", () => {
      expect(dependsOnHostOpenCode([hostProfile])).toBe(true);
      expect(dependsOnHostOpenCode([{ ...hostProfile, enabled: false }])).toBe(false);
      expect(dependsOnHostOpenCode([{ ...hostProfile, usesHostExecutable: false }])).toBe(false);
    });

    test("preserves whether the installer can retry", () => {
      expect(openCodeInstallationReadiness(openCodeInstallView(failed("timeout")))).toMatchObject({
        problem: { kind: "installation-failed", retry: "manual" },
      });
      expect(openCodeInstallationReadiness(openCodeInstallView(missing))).toMatchObject({
        problem: { kind: "not-installed" },
      });
    });
  });

  describe("installation view", () => {
    test("offers retry only for failures another attempt can fix", () => {
      const retryable = (reason: OpenCodeInstallFailureReason) => {
        const view = openCodeInstallView(failed(reason));
        return view.kind === "failed" && view.retryable;
      };
      expect(
        ["process", "timeout", "output-limit", "configuration"].map((reason) =>
          retryable(reason as OpenCodeInstallFailureReason),
        ),
      ).toEqual([true, true, true, true]);
      expect(
        ["existing-installation", "invalid-version", "unsupported-platform", "invalid-home"].map(
          (reason) => retryable(reason as OpenCodeInstallFailureReason),
        ),
      ).toEqual([false, false, false, false]);
    });

    test("a failed provider refresh stays failed although the executable is ready", () => {
      expect(openCodeInstallView(failed("configuration", readyExecutable()))).toMatchObject({
        kind: "failed",
        retryable: true,
      });
      expect(openCodeInstallView(failed("timeout", readyExecutable()))).toMatchObject({
        kind: "ready",
        version: "2.0.18",
      });
    });

    test("a rejected request is retryable, and a cancel error keeps showing progress", () => {
      expect(
        openCodeInstallView(
          snapshot({
            state: setupState(1),
            requestError: { request: "install", message: "Offline" },
          }),
        ),
      ).toMatchObject({ kind: "failed", message: "Offline", retryable: true });
      expect(
        openCodeInstallView(
          snapshot({
            state: setupState(2, {
              installation: { phase: "running", log: { lines: [], progress: null } },
            }),
            requestError: { request: "cancel", message: "Could not cancel" },
          }),
        ),
      ).toMatchObject({ kind: "running", cancelError: "Could not cancel" });
    });
  });

  describe("settings next step", () => {
    test("is at most one action, and none restarts installation without the dialog", () => {
      expect(openCodeExecutableStatusAction(openCodeInstallView(missing))).toEqual({
        kind: "dialog",
        label: "Install",
      });
      expect(
        openCodeExecutableStatusAction(
          openCodeInstallView(snapshot({ state: setupState(1, { supported: false }) })),
        ),
      ).toBeNull();
      for (const reason of ["process", "existing-installation"] as const)
        expect(openCodeExecutableStatusAction(openCodeInstallView(failed(reason)))).toEqual({
          kind: "dialog",
          label: "Show output",
        });
      expect(
        openCodeExecutableStatusAction(
          openCodeInstallView(snapshot({ loadError: "Main is unavailable" })),
        ),
      ).toEqual({ kind: "refresh", label: "Check again" });
      expect(
        openCodeExecutableStatusAction(
          openCodeInstallView(
            snapshot({ state: setupState(1, { executable: readyExecutable() }) }),
          ),
        ),
      ).toBeNull();
    });
  });
});

describe("opencode setup owner", () => {
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
      await Promise.resolve();
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
      await Promise.resolve();
      expect(owner.getSnapshot().state).toEqual(running(2, 0.4));
    });

    test("counts readiness only when observed changing, not when first read", async () => {
      const main = fakeSetupRuntime(setupState(1, { executable: readyExecutable() }));
      const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
      owner.subscribe(() => {});
      await Promise.resolve();
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
      await Promise.resolve();
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
      await Promise.resolve();

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
});
