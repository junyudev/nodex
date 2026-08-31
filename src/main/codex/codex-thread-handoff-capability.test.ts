import { describe, expect, test } from "vite-plus/test";
import {
  evaluateCodexThreadHandoffCapability,
  supportsCodexThreadHandoffRuntimeVersion,
  type CodexThreadHandoffCapabilityInput,
} from "./codex-thread-handoff-capability";

function capableInput(
  overrides: Partial<CodexThreadHandoffCapabilityInput> = {},
): CodexThreadHandoffCapabilityInput {
  return {
    runtimeVersion: "0.146.0",
    appServer: {
      threadSettingsUpdate: true,
      threadResumeLocation: true,
      rolloutPathConsistency: true,
    },
    coreAtomicExecutionLocation: true,
    sourceHost: { available: true, transactionEffects: true },
    destinationHost: { available: true, transactionEffects: true },
    crossHost: false,
    crossHostTransfer: false,
    ...overrides,
  };
}

describe("Codex thread handoff capability", () => {
  test("accepts the pinned runtime and later compatible versions", () => {
    expect(supportsCodexThreadHandoffRuntimeVersion("0.145.9")).toBe(false);
    expect(supportsCodexThreadHandoffRuntimeVersion("0.146.0")).toBe(true);
    expect(supportsCodexThreadHandoffRuntimeVersion("codex-app-server 0.147.0")).toBe(true);
    expect(supportsCodexThreadHandoffRuntimeVersion(null)).toBe(false);
    expect(supportsCodexThreadHandoffRuntimeVersion("development")).toBe(false);
  });

  test("requires app-server, Core, and both host transaction boundaries", () => {
    expect(evaluateCodexThreadHandoffCapability(capableInput())).toEqual({
      status: "available",
      mode: "local",
    });
    expect(
      evaluateCodexThreadHandoffCapability(
        capableInput({
          runtimeVersion: null,
          appServer: {
            threadSettingsUpdate: false,
            threadResumeLocation: false,
            rolloutPathConsistency: false,
          },
          coreAtomicExecutionLocation: false,
          sourceHost: { available: false, transactionEffects: false },
          destinationHost: { available: false, transactionEffects: false },
        }),
      ),
    ).toEqual({
      status: "unavailable",
      mode: "local",
      reasons: [
        "app-server-version-unsupported",
        "app-server-settings-update-unavailable",
        "app-server-resume-location-unavailable",
        "app-server-rollout-consistency-unavailable",
        "core-atomic-location-unavailable",
        "source-host-unavailable",
        "destination-host-unavailable",
        "host-transaction-unavailable",
      ],
    });
  });

  test("adds transfer capability only for cross-host movement", () => {
    expect(
      evaluateCodexThreadHandoffCapability(
        capableInput({
          crossHost: true,
          crossHostTransfer: false,
        }),
      ),
    ).toMatchObject({
      status: "unavailable",
      mode: "cross-host",
      reasons: ["cross-host-transfer-unavailable"],
    });
    expect(
      evaluateCodexThreadHandoffCapability(
        capableInput({
          crossHost: true,
          crossHostTransfer: true,
        }),
      ),
    ).toEqual({ status: "available", mode: "cross-host" });
  });
});
