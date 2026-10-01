import { expect, test } from "vite-plus/test";
import type { ApplicationNetworkRequirements } from "@nodex/codex-app-server-protocol/v2/ApplicationNetworkRequirements";
import {
  resolveChatGptApplicationNetwork,
  resolveChatGptBackendRouting,
  routeChatGptBackendRequest,
  type ChatGptBackendRequestAuth,
  type ChatGptBackendRouting,
} from "./chatgpt-backend-routing";

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
      resolveChatGptApplicationNetwork({ requirements: requirements(invalid), version: "0.155.0" }),
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
      routeChatGptBackendRequest(original, deniedHeaders, auth(route, { enabled: true, domains })),
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
