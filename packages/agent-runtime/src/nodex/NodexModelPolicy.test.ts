import { withWorkspaceEnvironment } from "@t3tools/provider-core/server/ExecutionHost";
import { fallbackTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { constrainProviderCatalog, nodexCreditFailure } from "./NodexModelPolicy.ts";

describe("Nodex model policy", () => {
  it("constrains every catalog consumer to the declared models", () => {
    const snapshot = {
      instanceId: "nodex_codex_account",
      models: [{ slug: "gpt-6.1-sol" }, { slug: "unapproved" }],
      updateRequiredModels: [{ slug: "unapproved" }],
    } as unknown as ServerProvider;
    const result = constrainProviderCatalog(snapshot, {
      driver: "codex",
      source: "nodex",
      modelAllowlist: ["gpt-6.1-sol"],
    } as unknown as ProviderInstanceConfig);
    expect(result.models.map((model) => model.slug)).toEqual(["gpt-6.1-sol"]);
    expect(result.updateRequiredModels).toEqual([]);
    expect(result.source).toBe("nodex");
  });
  it("leaves user catalogs and failure messages intact", () => {
    const snapshot = { models: [{ slug: "native" }] } as unknown as ServerProvider;
    expect(constrainProviderCatalog(snapshot, { driver: "codex" } as ProviderInstanceConfig)).toBe(
      snapshot,
    );
    const failure = makeProviderFailure({
      message: "Insufficient balance",
      code: "insufficient_balance",
    });
    expect(nodexCreditFailure("codex", failure)).toBe(failure);
  });
  it.each([
    { code: "INSUFFICIENT_BALANCE", message: "Insufficient account balance" },
    {
      code: null,
      message: '403 {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}',
    },
    { code: null, message: "API Error: 403 insufficient balance" },
  ])("points only confirmed gateway exhaustion to Top up: %s", (failure) => {
    const result = nodexCreditFailure("nodex_claude_account", makeProviderFailure(failure));
    expect(result.message).toBe(
      "Nodex credit is exhausted. Top up in Settings → Account, then retry.",
    );
    expect(result.retryable).toBe(false);
    expect(nodexCreditFailure("nodex_claude_account", result)).toEqual(result);
  });
  it.each([
    ["insufficient_quota", "You exceeded your current quota"],
    [null, "Your credit balance is too low to access the Anthropic API"],
    ["payment_required", "Upstream payment required"],
    [null, "No available accounts"],
    [null, "429 Too many requests"],
    [null, "503 Service unavailable"],
    [null, "Network failure"],
    [null, "Insufficient account balance"],
  ])("keeps platform failure %s separate from the user's wallet", (code, message) => {
    const result = nodexCreditFailure(
      "nodex_codex_account",
      makeProviderFailure({ code, message }),
    );
    expect(result.message).toBe("Nodex models are temporarily unavailable. Try again later.");
    expect(result.retryable).toBe(true);
    expect(nodexCreditFailure("nodex_codex_account", result)).toEqual(result);
  });
  it("keeps request-specific failures readable", () => {
    const failure = makeProviderFailure({
      code: "invalid_request_error",
      message: "prompt is too long: 250000 tokens > 200000 maximum",
    });
    expect(nodexCreditFailure("nodex_claude_account", failure)).toBe(failure);
  });
});

it("excludes managed providers from automatic utility defaults", () => {
  const id = "nodex_codex_account";
  const configured = {
    [id]: { driver: "codex", source: "nodex" },
  } as unknown as import("@t3tools/contracts").ServerSettings["providerInstances"];
  expect(
    fallbackTextGenerationModelSelection(configured, (candidate) => candidate === id, {
      includeConfiguredInstances: true,
    }),
  ).toBeNull();
});

it("workspace setup preserves managed routing and homes while applying project variables", () => {
  const managed = {
    HOME: "/managed",
    CLAUDE_CONFIG_DIR: "/managed/claude",
    ANTHROPIC_AUTH_TOKEN: "managed-key",
    ANTHROPIC_BASE_URL: "https://api.jyu.app",
  };
  const workspace = {
    set: {
      HOME: "/user",
      CLAUDE_CONFIG_DIR: "/user/.claude",
      ANTHROPIC_AUTH_TOKEN: "native-key",
      ANTHROPIC_API_KEY: "native-api-key",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/project/bin",
      PROJECT_FLAG: "yes",
    },
    exclude: ["ANTHROPIC_AUTH_TOKEN"],
  };
  const result = withWorkspaceEnvironment(managed, workspace, true);
  expect(result).toMatchObject({ ...managed, PATH: "/project/bin", PROJECT_FLAG: "yes" });
  expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  expect(withWorkspaceEnvironment(managed, workspace).ANTHROPIC_AUTH_TOKEN).toBe("native-key");
});
