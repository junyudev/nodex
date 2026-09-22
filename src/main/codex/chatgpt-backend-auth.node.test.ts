import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  CodexExecutionHostAuthState,
  live as authStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { describe, expect, test } from "vite-plus/test";
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
      }),
    ).toBe("https://workspace.example/backend-api/transcribe?x=1");
    expect(headers.get("X-OpenAI-Account-Routing-Override")).toBe("us");
    expect(headers.has("X-OpenAI-Fedramp")).toBe(false);
    routeChatGptBackendRequest("https://chatgpt.com/backend-api/transcribe", headers, {
      identity: { ...identity, isFedramp: true },
      token: "unused",
      routing: { kind: "legacy" },
      planType: "plus",
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
    const cases = [
      { version: "0.155.0", account: input.account, success: true, calls: 1 },
      { version: "0.154.0", account: input.account, success: true, calls: 0 },
      { version: "0.156.0", account: input.account, success: false, calls: 0 },
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
          Effect.succeed(method === "account/read" ? example.account : input.requirements),
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
      expect(calls).toBe(example.calls);
    }
  }).pipe(Effect.scoped),
);
