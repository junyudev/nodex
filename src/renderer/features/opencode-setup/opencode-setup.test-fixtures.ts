import { vi } from "vite-plus/test";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import type { OpenCodeSetupRuntime } from "../../lib/opencode-setup-runtime";

export const OPENCODE_INSTALL_COMMAND = "curl -fsSL https://opencode.ai/v2/install | /bin/bash";

export const setupState = (
  revision: number,
  patch: Partial<Omit<OpenCodeSetupState, "revision">> = {},
): OpenCodeSetupState => ({
  revision,
  supported: true,
  command: OPENCODE_INSTALL_COMMAND,
  executable: { status: "missing" },
  installation: { phase: "idle" },
  ...patch,
});

export const readyExecutable = (version = "2.0.18") =>
  ({
    status: "ready",
    binaryPath: "/Users/me/.opencode/bin/opencode",
    version,
  }) as const;

/** Main stand-in: commands resolve to the current state; `emit` publishes a change event. */
export function fakeSetupRuntime(initial: OpenCodeSetupState) {
  let current = initial;
  const listeners = new Set<(state: OpenCodeSetupState) => void>();
  const runtime = {
    read: vi.fn<OpenCodeSetupRuntime["read"]>(async () => current),
    install: vi.fn<OpenCodeSetupRuntime["install"]>(async () => current),
    cancel: vi.fn<OpenCodeSetupRuntime["cancel"]>(async () => current),
    subscribe: vi.fn<OpenCodeSetupRuntime["subscribe"]>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies OpenCodeSetupRuntime;
  return {
    runtime,
    listeners,
    /** Sets the state commands return without announcing it. */
    set: (state: OpenCodeSetupState) => {
      current = state;
    },
    emit: (state: OpenCodeSetupState) => {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}
