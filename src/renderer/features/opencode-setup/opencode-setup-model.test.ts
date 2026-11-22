import { describe, expect, test } from "vite-plus/test";
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
import { EMPTY_OPENCODE_SETUP_SNAPSHOT, type OpenCodeSetupSnapshot } from "./opencode-setup-owner";
import { readyExecutable, setupState } from "./opencode-setup.test-fixtures";

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
    expect(usesHostOpenCodeExecutable({ ...base, serverUrl: "http://127.0.0.1:4096" })).toBe(false);
    expect(usesHostOpenCodeExecutable({ ...base, environment: [explicitPath] })).toBe(false);
    expect(usesHostOpenCodeExecutable({ ...base, environment: [providerKey] })).toBe(true);
    // Unsaved editor rows are trimmed when saved, so a padded draft name already owns PATH.
    expect(usesHostOpenCodeExecutable({ ...base, environment: [{ name: " PATH " }] })).toBe(false);
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
        openCodeInstallView(snapshot({ state: setupState(1, { executable: readyExecutable() }) })),
      ),
    ).toBeNull();
  });
});
