import { describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CODEX_APP_SERVER_DEVELOPMENT_CAPABILITY_FLAGS,
  createCodexAppServerCapabilitySnapshot,
  extractCodexAppServerVersion,
  make,
  type CodexAppServerCapability,
} from "./CodexAppServerCapabilities";
import { CodexEndpoint } from "./CodexEndpoint";
import { CodexEndpointMap } from "./CodexEndpointMap";
import { CodexThreadHostResolver } from "./CodexGateway";

describe("Codex app-server capability policy", () => {
  test("recognizes the server version after the initialize client's originator prefix", () => {
    for (const originator of ["nodex", "codex_vscode", "my_remote_client"]) {
      const snapshot = createCodexAppServerCapabilitySnapshot({
        hostId: "local",
        generation: 1,
        userAgent: `${originator}/0.147.0 (Mac OS 26.6.1; arm64) unknown (${originator}; 0.5.0)`,
      });
      expect(snapshot.version).toBe("0.147.0");
      expect(snapshot.flags.paginatedHistory).toBe(true);
      expect(snapshot.flags.threadRevert).toBe(false);
    }
  });

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
    {
      capability: "subagentAncestorFilter",
      below: "0.150.0-alpha.12.1",
      minimum: "0.150.0-alpha.12.2",
    },
    {
      capability: "multiAgentV2Protocol",
      below: "0.150.0-alpha.12.1",
      minimum: "0.150.0-alpha.12.2",
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
      subagentAncestorFilter: false,
      multiAgentV2Protocol: false,
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
        subagentAncestorFilter: false,
        multiAgentV2Protocol: false,
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

  it.effect("projects and fences the exact physical session generation", () =>
    Effect.gen(function* () {
      let generation = 7;
      let userAgent = "Codex Desktop/0.147.0 (test)";
      const endpoint = CodexEndpoint.of({
        hostId: "remote-a",
        sourceEpoch: "endpoint-epoch-a",
        session: Effect.sync(
          () =>
            ({
              hostId: "remote-a",
              generation,
              pid: 42,
              client: null,
              initialize: { userAgent },
              termination: Effect.never,
            }) as never,
        ),
      } as unknown as CodexEndpoint["Service"]);
      const endpoints = CodexEndpointMap.of({
        localHostId: "local",
        endpoint: () => Effect.succeed(endpoint),
      } as unknown as CodexEndpointMap["Service"]);
      const threadHosts = CodexThreadHostResolver.of({
        resolve: () => Effect.succeed("remote-a"),
      });
      const service = yield* make.pipe(
        Effect.provideService(CodexEndpointMap, endpoints),
        Effect.provideService(CodexThreadHostResolver, threadHosts),
      );

      const first = yield* service.forThread("thread-a");
      expect(first).toMatchObject({
        hostId: "remote-a",
        generation: 7,
        sourceEpoch: "endpoint-epoch-a",
        version: "0.147.0",
        flags: { paginatedHistory: true, threadRevert: false },
      });
      expect(yield* service.isCurrent(first)).toBe(true);

      generation = 8;
      userAgent = "Codex Desktop/0.148.0-alpha.13 (test)";
      expect(yield* service.isCurrent(first)).toBe(false);
      expect(yield* service.forHost("remote-a")).toMatchObject({
        generation: 8,
        flags: { threadRevert: true },
      });
    }),
  );
});
