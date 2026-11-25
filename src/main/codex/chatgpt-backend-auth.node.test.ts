import { describe, expect, test } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { ApplicationNetworkRequirements } from "@nodex/codex-app-server-protocol/v2/ApplicationNetworkRequirements";
import {
  CodexExecutionHostAuthState,
  live as authStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  decodeChatGptBackendIdentity,
  resolveChatGptBackendRouting,
  routeChatGptBackendRequest,
  readChatGptBackendRequestAuth,
} from "./chatgpt-backend-auth";
import {
  resolveChatGptApplicationNetwork,
  resolveChatGptBackendRouting as resolveChatGptBackendRoutingchatgptbackendrouting,
  routeChatGptBackendRequest as routeChatGptBackendRequestchatgptbackendrouting,
  type ChatGptBackendRequestAuth,
  type ChatGptBackendRouting,
} from "./chatgpt-backend-routing";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { selectAppToolCatalog } from "../../shared/nodex-app-tools/catalog-selection";
import {
  DISABLED_DESKTOP_TOOL_REPL_CONFIG,
  buildCodexDesktopThreadFeatureConfig,
  buildCodexThreadConfig,
  CODEX_DESKTOP_THREAD_FEATURE_CONFIG,
} from "./codex-thread-config";
import { it as itthreadreadstateidentity } from "vitest";
import {
  readThreadStateIdentity,
  readThreadStateIdentityFromAccount,
  threadReadStateHostKeys,
  threadReadStateIdentityKey,
} from "./thread-read-state-identity";

describe("chatgpt-backend-auth", () => {
  const identity = { accountId: "account-a", userId: "user-a", isFedramp: false };
  const input = {
    identity,
    account: { account: { type: "chatgpt", planType: "plus" } },
    requirements: { requirements: null },
    version: "0.154.0",
  };
  const workspace = {
    chatgptAccountId: "account-a",
    backendOrigin: "https://workspace.example",
    accountRoutingOverride: "us" as const,
  };

  describe("ChatGPT backend routing", () => {
    test("permits legacy routing only in the verified version interval without residency constraints", () => {
      expect(resolveChatGptBackendRouting(input)).toEqual({ kind: "legacy" });
      for (const version of [null, "0.140.0", "0.155.0-alpha.5", "0.155.0"]) {
        expect(() => resolveChatGptBackendRouting({ ...input, version })).toThrow();
      }
      expect(() =>
        resolveChatGptBackendRouting({
          ...input,
          account: { ...input.account, workspaceRouting: null },
        }),
      ).toThrow();
      expect(() =>
        resolveChatGptBackendRouting({ ...input, identity: { ...identity, isFedramp: true } }),
      ).toThrow();
      for (const requirements of [
        { chatgptBaseUrl: "https://workspace.example" },
        { enforceResidency: "us" },
        { application: { network: {} } },
      ]) {
        expect(() =>
          resolveChatGptBackendRouting({ ...input, requirements: { requirements } }),
        ).toThrow();
      }
    });

    test("accepts only authenticated HTTPS workspace origins and removes stale routing headers", () => {
      const routing = resolveChatGptBackendRouting({
        ...input,
        version: "0.155.0",
        account: { ...input.account, workspaceRouting: workspace },
      });
      expect(routing).toEqual({ kind: "workspace", workspace });
      for (const invalid of [
        { ...workspace, chatgptAccountId: "account-b" },
        { ...workspace, backendOrigin: "http://workspace.example" },
        { ...workspace, backendOrigin: "https://workspace.example/path" },
      ]) {
        expect(() =>
          resolveChatGptBackendRouting({
            ...input,
            account: { ...input.account, workspaceRouting: invalid },
          }),
        ).toThrow();
      }
      const headers = new Headers({
        "X-OpenAI-Account-Routing-Override": "stale",
        "X-OpenAI-Fedramp": "true",
      });
      expect(
        routeChatGptBackendRequest("https://chatgpt.com/backend-api/transcribe?x=1", headers, {
          identity,
          token: "unused",
          signal: new AbortController().signal,
          routing,
          planType: "plus",
          network: null,
        }),
      ).toBe("https://workspace.example/backend-api/transcribe?x=1");
      expect(headers.get("X-OpenAI-Account-Routing-Override")).toBe("us");
      expect(headers.has("X-OpenAI-Fedramp")).toBe(false);
      routeChatGptBackendRequest("https://chatgpt.com/backend-api/transcribe", headers, {
        identity: { ...identity, isFedramp: true },
        token: "unused",
        routing: { kind: "legacy" },
        planType: "plus",
        network: null,
        signal: new AbortController().signal,
      });
      expect(headers.has("X-OpenAI-Account-Routing-Override")).toBe(false);
      expect(headers.get("X-OpenAI-Fedramp")).toBe("true");
    });

    test("validates token identity with exact claim fallback and FedRAMP semantics", () => {
      const token = (claims: unknown) =>
        `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
      expect(
        decodeChatGptBackendIdentity(
          token({
            exp: 123,
            "https://api.openai.com/auth": { account_id: "account-a", chatgpt_user_id: "user-a" },
          }),
        ),
      ).toEqual(identity);
      expect(
        decodeChatGptBackendIdentity(
          token({
            exp: 123,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "account-a",
              user_id: "user-a",
              chatgpt_account_is_fedramp: true,
            },
          }),
        ),
      ).toEqual({ ...identity, isFedramp: true });
      expect(decodeChatGptBackendIdentity("not-a-token")).toBeNull();
      expect(
        decodeChatGptBackendIdentity(
          token({
            exp: 0,
            "https://api.openai.com/auth": { account_id: "account-a", user_id: "user-a" },
          }),
        ),
      ).toBeNull();
    });
  });

  it.effect("uses the companion only for the verified public runtime's omitted extension", () =>
    Effect.gen(function* () {
      const token = `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId, user_id: identity.userId } })).toString("base64url")}.x`;
      const authState = Context.get(yield* Layer.build(authStateLive), CodexExecutionHostAuthState);
      const network = { enabled: true, domains: { "workspace.example": "allow" } } as const;
      const cases: ReadonlyArray<{
        readonly version: string;
        readonly account: unknown;
        readonly requirements?: unknown;
        readonly network?: ApplicationNetworkRequirements;
        readonly success: boolean;
        readonly calls: number;
      }> = [
        { version: "0.155.0", account: input.account, success: true, calls: 1 },
        { version: "0.154.0", account: input.account, success: true, calls: 0 },
        { version: "0.156.0", account: input.account, success: false, calls: 0 },
        {
          version: "0.155.0",
          account: input.account,
          requirements: { requirements: { application: { network } } },
          network,
          success: true,
          calls: 1,
        },
        {
          version: "0.155.0",
          account: input.account,
          requirements: {
            requirements: {
              application: { network: { enabled: false, domains: { "*": "allow" } } },
            },
          },
          success: false,
          calls: 0,
        },
        {
          version: "0.155.0",
          account: input.account,
          requirements: { requirements: {} },
          success: false,
          calls: 0,
        },
        {
          version: "0.155.0",
          account: { ...input.account, workspaceRouting: null },
          success: false,
          calls: 0,
        },
        {
          version: "0.155.0",
          account: {
            ...input.account,
            workspaceRouting: { ...workspace, chatgptAccountId: "other" },
          },
          success: false,
          calls: 0,
        },
        {
          version: "0.155.0",
          account: { ...input.account, workspaceRouting: {} },
          success: false,
          calls: 0,
        },
        { version: "0.155.0", account: { account: null }, success: false, calls: 0 },
      ];
      for (const example of cases) {
        let calls = 0;
        const capability = createCodexAppServerCapabilitySnapshot({
          hostId: "local",
          generation: 1,
          userAgent: `Codex Desktop/${example.version}`,
        });
        const gateway = {
          localHostId: "local",
          requestLocal: () => Effect.succeed({ authMethod: "chatgpt", authToken: token }),
          requestRawOnHost: (_host: string, method: string) =>
            Effect.succeed(
              method === "account/read"
                ? example.account
                : (example.requirements ?? input.requirements),
            ),
        } as unknown as CodexGateway["Service"];
        const result = yield* Effect.exit(
          readChatGptBackendRequestAuth(gateway).pipe(
            Effect.provideService(CodexExecutionHostAuthState, authState),
            Effect.provideService(CodexAppServerCapabilities, {
              forHost: () => Effect.succeed(capability),
              forThread: () => Effect.succeed(capability),
              isCurrent: () => Effect.succeed(true),
            }),
            Effect.provideService(CodexWorkspaceRouting, {
              discover: () =>
                Effect.sync(() => {
                  calls += 1;
                  return { kind: "workspace" as const, workspace };
                }),
            }),
          ),
        );
        expect(Exit.isSuccess(result)).toBe(example.success);
        if (Exit.isSuccess(result)) expect(result.value.network).toEqual(example.network ?? null);
        expect(calls).toBe(example.calls);
      }
    }).pipe(Effect.scoped),
  );
});

describe("chatgpt-backend-routing", () => {
  const resolveChatGptBackendRouting = resolveChatGptBackendRoutingchatgptbackendrouting;
  const routeChatGptBackendRequest = routeChatGptBackendRequestchatgptbackendrouting;
  const workspace = {
    chatgptAccountId: "account",
    backendOrigin: "https://workspace.example",
    accountRoutingOverride: "us" as const,
  };
  const identity = { accountId: "account", userId: "user", isFedramp: false };
  const requirements = (network: unknown) => ({ requirements: { application: { network } } });
  const auth = (
    routing: ChatGptBackendRouting,
    network: ApplicationNetworkRequirements | null,
  ): ChatGptBackendRequestAuth => ({
    routing,
    network,
    identity,
    token: "private",
    planType: "plus",
    signal: new AbortController().signal,
  });

  test("validates explicit network permissions and distinguishes absent from null policy", () => {
    const network = {
      enabled: true,
      domains: { "workspace.example": "allow", "blocked.example": "deny" },
    } as const;
    expect(
      resolveChatGptApplicationNetwork({ requirements: requirements(network), version: "0.155.0" }),
    ).toEqual(network);
    for (const value of [
      { requirements: null },
      { requirements: { application: null } },
      requirements(null),
    ]) {
      expect(
        resolveChatGptApplicationNetwork({ requirements: value, version: "0.155.0" }),
      ).toBeNull();
    }
    for (const version of ["0.141.0", "0.154.0", "0.155.0-alpha.4"]) {
      expect(
        resolveChatGptApplicationNetwork({ requirements: { requirements: {} }, version }),
      ).toBeNull();
    }
    for (const version of [null, "0.140.0", "0.155.0-alpha.5", "0.155.0"]) {
      expect(() =>
        resolveChatGptApplicationNetwork({ requirements: { requirements: {} }, version }),
      ).toThrow();
    }
  });

  test("rejects malformed policy even when restrictions are disabled", () => {
    for (const invalid of [
      undefined,
      {},
      { enabled: "false", domains: {} },
      { enabled: true },
      { domains: {} },
      { enabled: false, domains: null },
      { enabled: false, domains: [] },
      { enabled: false, domains: "workspace.example" },
      { enabled: false, domains: { "workspace.example": "unknown" } },
      { enabled: false, domains: { "*.example": "allow" } },
      { enabled: true, domains: { "Workspace.example": "allow" } },
      { enabled: true, domains: { "workspace.example.": "allow" } },
      { enabled: true, domains: { "https://workspace.example": "allow" } },
      { enabled: true, domains: { "workspace.example:443": "allow" } },
      { enabled: true, domains: { "-workspace.example": "allow" } },
      { enabled: true, domains: { [`${"x".repeat(64)}.example`]: "allow" } },
      {
        enabled: true,
        domains: {
          [`${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}`]: "allow",
        },
      },
    ]) {
      expect(() =>
        resolveChatGptApplicationNetwork({
          requirements: requirements(invalid),
          version: "0.155.0",
        }),
      ).toThrow();
    }
    expect(() =>
      resolveChatGptApplicationNetwork({ requirements: {}, version: "0.155.0" }),
    ).toThrow();
    expect(() =>
      resolveChatGptApplicationNetwork({
        requirements: { requirements: { application: {} } },
        version: "0.154.0",
      }),
    ).toThrow();
  });

  test("checks the routed destination before mutating or exposing request headers", () => {
    const original = "https://chatgpt.com/backend-api/dictation/stream?dictation_surface=global";
    const headers = new Headers({
      "X-OpenAI-Account-Routing-Override": "unchanged",
      "X-OpenAI-Fedramp": "unchanged",
    });
    const route = { kind: "workspace", workspace } as const;
    const allowed = { enabled: true, domains: { "workspace.example": "allow" } } as const;
    expect(routeChatGptBackendRequest(original, headers, auth(route, allowed))).toBe(
      "https://workspace.example/backend-api/dictation/stream?dictation_surface=global",
    );
    expect(headers.get("X-OpenAI-Account-Routing-Override")).toBe("us");
    for (const domains of [
      { "chatgpt.com": "allow" },
      { "workspace.example": "deny" },
      {},
    ] as const) {
      const deniedHeaders = new Headers({
        "X-OpenAI-Account-Routing-Override": "unchanged",
        "X-OpenAI-Fedramp": "unchanged",
      });
      expect(() =>
        routeChatGptBackendRequest(
          original,
          deniedHeaders,
          auth(route, { enabled: true, domains }),
        ),
      ).toThrow("Desktop network policy does not allow this destination");
      expect(deniedHeaders.get("X-OpenAI-Account-Routing-Override")).toBe("unchanged");
      expect(deniedHeaders.get("X-OpenAI-Fedramp")).toBe("unchanged");
    }
  });

  test("exact host permissions cover legacy HTTPS and WSS without granting subdomains or plaintext", () => {
    const authenticated = auth(
      { kind: "legacy" },
      { enabled: true, domains: { "chatgpt.com": "allow" } },
    );
    for (const url of [
      "https://chatgpt.com/backend-api/transcribe",
      "wss://CHATGPT.COM./backend-api/dictation/stream",
    ]) {
      expect(routeChatGptBackendRequest(url, new Headers(), authenticated)).toBe(url);
    }
    for (const url of [
      "https://sub.chatgpt.com",
      "https://chatgpt.com.evil.example",
      "https://other.example",
      "http://chatgpt.com",
      "ws://chatgpt.com",
    ]) {
      expect(() => routeChatGptBackendRequest(url, new Headers(), authenticated)).toThrow();
    }
    expect(
      routeChatGptBackendRequest(
        "http://localhost:8000/api/transcribe",
        new Headers(),
        auth({ kind: "legacy" }, { enabled: false, domains: {} }),
      ),
    ).toBe("http://localhost:8000/api/transcribe");
    expect(() =>
      routeChatGptBackendRequest("https://chatgpt.com", new Headers(), {
        ...authenticated,
        network: undefined,
      } as unknown as ChatGptBackendRequestAuth),
    ).toThrow("Application network requirements are unavailable");
  });

  test("legacy routing and destination policy stay independent from residency restrictions", () => {
    const input = {
      identity,
      account: { account: { type: "chatgpt" } },
      requirements: requirements({ enabled: true, domains: { "chatgpt.com": "allow" } }),
      version: "0.154.0",
    };
    expect(resolveChatGptBackendRouting(input)).toEqual({ kind: "legacy" });
    for (const patch of [
      { chatgptBaseUrl: "https://workspace.example" },
      { enforceResidency: "us" },
    ]) {
      expect(() =>
        resolveChatGptBackendRouting({
          ...input,
          requirements: { requirements: { ...input.requirements.requirements, ...patch } },
        }),
      ).toThrow();
    }
    expect(() =>
      resolveChatGptBackendRouting({ ...input, identity: { ...identity, isFedramp: true } }),
    ).toThrow();
  });
});

describe("codex-thread-config", () => {
  describe("Codex Desktop static feature defaults", () => {
    test("keeps the currently enabled Desktop wire features on by default", () => {
      expect(CODEX_DESKTOP_THREAD_FEATURE_CONFIG).toMatchObject({
        "features.guardianv2": { enabled: true },
        "features.recommended_plugins": true,
        "features.workspace_dependencies": true,
      });
    });

    test("keeps Desktop compatibility for older app-server versions", () => {
      const config = buildCodexDesktopThreadFeatureConfig("0.146.0");

      expect(config["features.guardianv2"]).toBe(true);
      expect(config).not.toHaveProperty("features.recommended_plugins");
      expect(config["features.workspace_dependencies"]).toBe(true);
    });

    test("treats the app-server development sentinel as current for wire compatibility", () => {
      expect(buildCodexDesktopThreadFeatureConfig("0.0.0")).toMatchObject({
        "features.guardianv2": { enabled: true },
        "features.recommended_plugins": true,
      });
    });
  });

  describe("Codex native app-tool visibility", () => {
    test.each(["session", "automation"] as const)(
      "%s uses the same catalog as native discovery while explicit config remains authoritative",
      (purpose) => {
        const config = buildCodexThreadConfig({
          nativeAppTools: true,
          purpose,
          overrides: {
            "mcp_servers.nodex_app.enabled_tools": ["removed_tool"],
            model_reasoning_effort: "high",
          },
        });
        expect(config["mcp_servers.nodex_app.enabled_tools"]).toEqual(["removed_tool"]);
        expect(selectAppToolCatalog({ nativeMcp: true, purpose })).toEqual(appToolCatalog);
        expect(config.model_reasoning_effort).toBe("high");
      },
    );

    test("system work disables inherited app tools without changing its other capabilities", () => {
      expect(
        buildCodexThreadConfig({
          nativeAppTools: true,
          purpose: "system",
          overrides: { "features.thread_tools": false },
        }),
      ).toEqual({
        "features.thread_tools": false,
        "mcp_servers.nodex_app.enabled_tools": [],
      });
    });

    test("an endpoint without the native bridge has no app tools or partial server definition", () => {
      expect(selectAppToolCatalog({ nativeMcp: false, purpose: "session" })).toEqual([]);
      expect(buildCodexThreadConfig({ nativeAppTools: false })).not.toHaveProperty(
        "mcp_servers.nodex_app.enabled_tools",
      );
    });

    test("normalizes optional nested configuration values at the request boundary", () => {
      const config = buildCodexThreadConfig({
        nativeAppTools: true,
        overrides: {
          provider: { optional: undefined, timeout: 0, fallback: null },
          omitted: undefined,
        },
      });
      expect(config.provider).toEqual({ timeout: 0, fallback: null });
      expect(config).not.toHaveProperty("omitted");
      expect(() =>
        buildCodexThreadConfig({ nativeAppTools: true, overrides: { invalid: () => undefined } }),
      ).toThrow("JSON values");
    });
  });

  describe("disabled Desktop Tool REPL", () => {
    test("disables the REPL with a complete server, since Codex rejects one without a transport", () => {
      const servers = Object.entries(DISABLED_DESKTOP_TOOL_REPL_CONFIG).filter(([key]) =>
        key.startsWith("mcp_servers."),
      );
      expect(servers).toEqual([
        ["mcp_servers.node_repl", { command: "node_repl", enabled: false }],
      ]);
    });
  });
});

describe("thread-read-state-identity", () => {
  const it = itthreadreadstateidentity;
  const token = (claims: Record<string, unknown>, exp: unknown = 1) =>
    `header.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
  it("derives stable account and user claims without retaining authentication material", () => {
    const identity = readThreadStateIdentity({
      authMethod: "chatgpt",
      authToken: token({
        chatgpt_account_id: "account",
        account_id: "fallback",
        user_id: "user",
        chatgpt_user_id: "fallback-user",
      }),
      requiresOpenaiAuth: true,
    });
    expect(identity).toEqual({ kind: "chatgpt", accountId: "account", userId: "user" });
    expect(
      readThreadStateIdentity({
        authMethod: "chatgpt",
        authToken: token({ chatgpt_account_id: "account" }),
        requiresOpenaiAuth: true,
      }),
    ).toBeNull();
    expect(
      readThreadStateIdentity({
        authMethod: "chatgpt",
        authToken: token({ chatgpt_account_id: "account", user_id: "user" }, 0),
        requiresOpenaiAuth: true,
      }),
    ).toBeNull();
    expect(threadReadStateIdentityKey(identity!)).not.toEqual(
      threadReadStateIdentityKey({ kind: "chatgpt", accountId: "account", userId: "other" }),
    );
  });
  it("distinguishes unauthenticated unavailable storage from explicitly unauthenticated execution storage", () => {
    expect(
      readThreadStateIdentity({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
    ).toBeNull();
    expect(
      readThreadStateIdentity({ authMethod: null, authToken: null, requiresOpenaiAuth: false }),
    ).toEqual({ kind: "execution-storage", authMode: "none" });
    expect(threadReadStateHostKeys([]).local).toMatch(/^local:[0-9a-f]{64}$/);
  });

  it("resolves storage-backed identities from account/read without legacy auth tokens", () => {
    expect(
      readThreadStateIdentityFromAccount({
        account: { type: "apiKey" },
        requiresOpenaiAuth: false,
      }),
    ).toEqual({ kind: "execution-storage", authMode: "apikey" });
    expect(
      readThreadStateIdentityFromAccount({ account: null, requiresOpenaiAuth: false }),
    ).toEqual({
      kind: "execution-storage",
      authMode: "none",
    });
    expect(
      readThreadStateIdentityFromAccount({
        account: {
          workspaceName: null,
          type: "chatgpt",
          email: "person@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      }),
    ).toBeNull();
  });

  it("keys SSH read state by the physical connection while ignoring product storage paths", () => {
    const host = {
      id: "remote",
      displayName: "Remote",
      kind: "ssh" as const,
      sshAlias: "devbox",
      port: null,
      managedRoot: "/worktrees",
      repositoryRoots: ["/repo"],
      codexBinary: null,
      codexHome: null,
      enabled: true,
    };
    const original = threadReadStateHostKeys([host]).remote;
    expect(
      threadReadStateHostKeys([{ ...host, codexHome: "/other", managedRoot: "/elsewhere" }]).remote,
    ).toBe(original);
    expect(threadReadStateHostKeys([{ ...host, sshAlias: "another" }]).remote).not.toBe(original);
    expect(threadReadStateHostKeys([{ ...host, port: 2222 }]).remote).not.toBe(original);
    expect(threadReadStateHostKeys([{ ...host, enabled: false }]).remote).toBeUndefined();
  });
});
