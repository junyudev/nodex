import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS,
  createCodexAppServerCapabilitySnapshot,
  extractCodexAppServerVersion,
  type CodexAppServerCapability,
} from "./CodexAppServerCapabilities";

describe("Codex app-server capability policy", () => {
  test("extracts a strict SemVer from supported app-server user-agent forms", () => {
    expect(
      extractCodexAppServerVersion("Codex Desktop/0.147.0 (Mac OS 26.6.1; arm64) ghostty/1.3.1"),
    ).toBe("0.147.0");
    expect(extractCodexAppServerVersion("codex-cli 0.148.0-alpha.13+local.2")).toBe(
      "0.148.0-alpha.13+local.2",
    );
    expect(extractCodexAppServerVersion("codex_cli_rs/v0.145.0-alpha.15")).toBe("0.145.0-alpha.15");
    expect(extractCodexAppServerVersion("0.146.0-alpha.8")).toBe("0.146.0-alpha.8");
  });

  test("does not mistake unrelated or malformed versions for the app-server version", () => {
    expect(extractCodexAppServerVersion("nodex-queue-parity-scenario")).toBeNull();
    expect(extractCodexAppServerVersion("Codex Desktop/latest (Mac OS 26.6.1)")).toBeNull();
    expect(extractCodexAppServerVersion("Mozilla/5.0 Chrome/147.0.0.0")).toBeNull();
    expect(extractCodexAppServerVersion("Codex Desktop/00.147.0 (Mac OS 26.6.1)")).toBeNull();
    expect(extractCodexAppServerVersion("Codex Desktop/0.147.0-alpha.01")).toBeNull();
    expect(extractCodexAppServerVersion(null)).toBeNull();
  });

  test.each<{
    capability: CodexAppServerCapability;
    below: string;
    minimum: string;
  }>([
    {
      capability: "forkLastTurnId",
      below: "0.143.0-alpha.31",
      minimum: "0.143.0-alpha.32",
    },
    {
      capability: "paginatedHistory",
      below: "0.145.0-alpha.14",
      minimum: "0.145.0-alpha.15",
    },
    {
      capability: "searchOccurrences",
      below: "0.145.0-alpha.23",
      minimum: "0.145.0-alpha.24",
    },
    {
      capability: "ephemeralFork",
      below: "0.146.0-alpha.6",
      minimum: "0.146.0-alpha.7",
    },
    {
      capability: "sideConversation",
      below: "0.146.0-alpha.7",
      minimum: "0.146.0-alpha.8",
    },
    {
      capability: "threadRevert",
      below: "0.148.0-alpha.12",
      minimum: "0.148.0-alpha.13",
    },
  ])("enables $capability exactly at its prerelease floor", ({ capability, below, minimum }) => {
    const belowSnapshot = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: `Codex Desktop/${below}`,
    });
    const minimumSnapshot = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: `Codex Desktop/${minimum}`,
    });

    expect(belowSnapshot.flags[capability]).toBe(false);
    expect(minimumSnapshot.flags[capability]).toBe(true);
  });

  test("implements SemVer prerelease precedence and ignores build metadata", () => {
    const alphaPatch = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: "Codex Desktop/0.145.0-alpha.15.1+private.9",
    });
    const beta = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: "Codex Desktop/0.145.0-beta.1",
    });
    const stable = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: "Codex Desktop/0.145.0+private.9",
    });
    const olderCore = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: "Codex Desktop/0.144.999",
    });

    expect(alphaPatch.flags.paginatedHistory).toBe(true);
    expect(beta.flags.paginatedHistory).toBe(true);
    expect(stable.flags.paginatedHistory).toBe(true);
    expect(olderCore.flags.paginatedHistory).toBe(false);
  });

  test("uses an explicit development policy for the 0.0.0 sentinel", () => {
    const snapshot = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 7,
      userAgent: "Codex Desktop/0.0.0 (development)",
    });

    expect(snapshot.version).toBe("0.0.0");
    expect(snapshot.flags).toEqual(CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS);
    expect(snapshot.flags).toEqual({
      forkLastTurnId: false,
      paginatedHistory: false,
      searchOccurrences: true,
      ephemeralFork: false,
      sideConversation: false,
      threadRevert: true,
    });
  });

  test("fails closed for unknown user agents and returns an immutable generation snapshot", () => {
    const snapshot = createCodexAppServerCapabilitySnapshot({
      hostId: " remote-a ",
      generation: 42,
      userAgent: "mock-codex-app-server",
    });

    expect(snapshot).toEqual({
      hostId: "remote-a",
      generation: 42,
      userAgent: "mock-codex-app-server",
      version: null,
      flags: {
        forkLastTurnId: false,
        paginatedHistory: false,
        searchOccurrences: false,
        ephemeralFork: false,
        sideConversation: false,
        threadRevert: false,
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.flags)).toBe(true);
  });

  test("rejects invalid host-generation identity", () => {
    expect(() =>
      createCodexAppServerCapabilitySnapshot({
        hostId: " ",
        generation: 1,
        userAgent: "Codex Desktop/0.148.0",
      }),
    ).toThrow(/hostId/u);
    expect(() =>
      createCodexAppServerCapabilitySnapshot({
        hostId: "local",
        generation: -1,
        userAgent: "Codex Desktop/0.148.0",
      }),
    ).toThrow(/generation/u);
  });
});
