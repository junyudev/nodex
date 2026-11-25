import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_POLICY as defaults,
  ModelPolicySchema,
  canStartModel,
  isModelOn,
  isModelSwitchOn,
  setModelOn,
  setNodexOn,
  isProviderOn,
  policyModelKey,
  modelPolicyFailure,
  projectModelPolicyCatalog,
  automaticModelCatalog,
  withFreeModelsOn,
} from "./model-policy";
import {
  ProviderKeyConnectInputSchema,
  isProviderKeyRuntimeInstanceId,
  providerKeyBaseUrl,
  providerKeyBaseUrlProblem,
  providerKeyClaudeModelEnvironment,
  providerKeyDefaultName,
  providerKeyModelName,
  providerKeyModels,
  providerKeyPresetOfInstanceId,
  providerKeyRuntimeInstanceId,
} from "./provider-keys";

describe("model policy", () => {
  const credit = { instanceId: "nodex_codex_alice", driver: "codex", source: "nodex" };
  const native = { instanceId: "codex_work", driver: "codex" };
  describe("Profile model policy", () => {
    it("starts OpenCode off, free models included, and every other provider on", () => {
      for (const driver of ["opencode", "opencode2"]) {
        expect(isModelOn(defaults, { ...native, driver }, "opencode/x-free")).toBe(false);
        expect(isModelOn(defaults, { ...native, driver }, "opencode/x")).toBe(false);
      }
      expect(isModelOn(defaults, credit, "new-model")).toBe(true);
      expect(isModelOn(defaults, { ...native, driver: "antigravity" }, "gemini")).toBe(true);
    });
    it("turns on a provider's free models and nothing else", () => {
      const provider = {
        ...native,
        driver: "opencode",
        models: [{ slug: "opencode/x-free" }, { slug: "opencode/x" }],
      };
      const policy = withFreeModelsOn(defaults, provider);
      expect(isModelOn(policy, provider, "opencode/x-free")).toBe(true);
      expect(isModelOn(policy, provider, "opencode/x")).toBe(false);
      expect(
        automaticModelCatalog(projectModelPolicyCatalog([provider], defaults))[0]?.models,
      ).toEqual([]);
    });
    it("preserves individual exceptions through provider off/on and account changes", () => {
      const off = setModelOn(defaults, credit, "sol", false);
      const disabled = setNodexOn(off, false);
      expect(isModelSwitchOn(disabled, credit, "sol")).toBe(false);
      expect(isModelSwitchOn(disabled, credit, "luna")).toBe(true);
      const bob = { ...credit, instanceId: "nodex_codex_bob" };
      expect(isModelOn(disabled, bob, "new-model")).toBe(false);
      expect(setNodexOn(disabled, true)).toEqual(off);
      // Only Nodex has a switch of its own; another provider is on while its Agent is.
      expect(isProviderOn(disabled, native)).toBe(true);
      expect(policyModelKey(credit, "sol")).toEqual(policyModelKey(bob, "sol"));
      expect(policyModelKey(native, "sol")).not.toEqual(
        policyModelKey({ ...native, instanceId: "codex_personal" }, "sol"),
      );
      expect(policyModelKey(native, "sol")).not.toEqual(policyModelKey(native, "SOL"));
    });
    it.each(["person", "nodex-agent", "agent", "automatic"] as const)(
      "enforces the origin matrix for %s",
      (origin) => {
        expect(canStartModel(defaults, native, "sol", origin)).toBe(true);
        expect(canStartModel(defaults, credit, "sol", origin)).toBe(
          origin === "person" || origin === "nodex-agent",
        );
        expect(
          canStartModel({ ...defaults, agentsMayChooseCredit: true }, credit, "sol", origin),
        ).toBe(origin !== "automatic");
        expect(
          canStartModel(setModelOn(defaults, native, "sol", false), native, "sol", origin),
        ).toBe(false);
      },
    );
    it("names the exact model, refuses non-retryably and never widens off via origin", () => {
      expect(
        modelPolicyFailure(
          setModelOn(defaults, credit, "gpt-6.1-sol", false),
          credit,
          "gpt-6.1-sol",
          "person",
          "GPT-6.1 Sol",
        ),
      ).toEqual({
        code: "model_off",
        retryable: false,
        message: "GPT-6.1 Sol on Nodex is off in Settings → Agents. Choose another model.",
      });
      expect(modelPolicyFailure(defaults, credit, "sol", "agent")?.code).toBe(
        "credit_requires_person",
      );
    });
    it("keeps all Settings rows while automatic resolution excludes credit and off models", () => {
      const policy = setModelOn(defaults, native, "sol", false);
      const providers = projectModelPolicyCatalog(
        [
          { ...native, models: [{ slug: "sol" }, { slug: "luna" }] },
          { ...credit, models: [{ slug: "sol" }] },
        ],
        policy,
      );
      expect(providers[0]?.models[0]?.policy).toEqual({
        on: false,
        switchOn: false,
        spendsCredit: false,
      });
      expect(
        automaticModelCatalog(providers).map((provider) =>
          provider.models.map((model) => model.slug),
        ),
      ).toEqual([["luna"]]);
    });
    it("rejects malformed policy without defaulting open", () => {
      expect(
        ModelPolicySchema.safeParse({ ...defaults, agentsMayChooseCredit: "yes" }).success,
      ).toBe(false);
    });
  });
});

describe("provider keys", () => {
  it("keeps a provider's chat models, known ones first", () => {
    expect(
      providerKeyModels("deepseek", [
        { id: "deepseek-flash" },
        { id: "deepseek-embedding" },
        { id: "deepseek-v4-flash-vision-exp" },
        { id: "deepseek-v4-pro", name: "" },
        { id: "deepseek-v5-preview" },
        { id: "deepseek-flash" },
      ]).map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
      { id: "deepseek-v5-preview", name: "DeepSeek V5 Preview" },
    ]);
    expect(providerKeyModels("moonshot", [{ id: "moonshot-v1-8k" }, { id: "kimi-k3" }])).toEqual([
      { id: "kimi-k3", name: "Kimi K3" },
    ]);
    expect(
      providerKeyModels("zhipu", [{ id: "glm-5.3" }, { id: "glm-5v-turbo" }, { id: "cogview-4" }]),
    ).toEqual([{ id: "glm-5.3", name: "GLM-5.3" }]);
    expect(
      providerKeyModels("custom", [
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { id: "text-embedding-3" },
      ]),
    ).toEqual([{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }]);
  });

  it("keeps what the provider says about a model over what Nodex knows", () => {
    expect(
      providerKeyModels("deepseek", [
        { id: "deepseek-flash", contextWindow: 524_288, images: false },
        { id: "deepseek-v5-preview", reasoningEfforts: ["low", "high"] },
      ]),
    ).toEqual([
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        contextWindow: 524_288,
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        images: false,
      },
      { id: "deepseek-v5-preview", name: "DeepSeek V5 Preview", reasoningEfforts: ["low", "high"] },
    ]);
  });

  it("names unlisted models readably", () => {
    expect(providerKeyModelName("minimax", "minimax-m4-pro")).toBe("MiniMax M4 Pro");
    expect(providerKeyModelName("custom", "qwen3-coder-plus")).toBe("Qwen3 Coder Plus");
    expect(providerKeyModelName("custom", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(providerKeyModelName("custom", "gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(providerKeyModels("custom", [{ id: "gpt-6-luna", name: "gpt-6-luna" }])).toEqual([
      { id: "gpt-6-luna", name: "GPT 6 Luna" },
    ]);
  });

  it("points Claude Code's own model names at the provider's models", () => {
    expect(
      providerKeyClaudeModelEnvironment([
        { id: "deepseek-v4-pro", name: "Pro" },
        { id: "deepseek-flash", name: "Flash" },
      ]),
    ).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
    });
    expect(providerKeyClaudeModelEnvironment([])).toEqual({});
  });

  it("round-trips runtime instance ids", () => {
    const id = providerKeyRuntimeInstanceId({ id: "3f2a-91", preset: "deepseek" });
    expect(isProviderKeyRuntimeInstanceId(id)).toBe(true);
    expect(providerKeyPresetOfInstanceId(id)).toBe("deepseek");
    expect(isProviderKeyRuntimeInstanceId("key_openai_x")).toBe(false);
    expect(providerKeyPresetOfInstanceId("claude_abc")).toBeNull();
  });

  it("resolves endpoints and validates custom ones", () => {
    expect(
      providerKeyBaseUrl({ preset: "moonshot", endpoint: "international", agent: "claudeAgent" }),
    ).toBe("https://api.moonshot.ai/anthropic");
    expect(
      providerKeyBaseUrl({ preset: "moonshot", endpoint: "international", agent: "codex" }),
    ).toBe("https://api.moonshot.ai/v1");
    expect(
      providerKeyBaseUrl({
        preset: "custom",
        baseUrl: " https://gw.example.com/v1/ ",
        agent: "codex",
      }),
    ).toBe("https://gw.example.com/v1");
    expect(
      providerKeyDefaultName({
        preset: "custom",
        baseUrl: "https://api.example.com/a",
        agent: "codex",
      }),
    ).toBe("example.com");
    expect(providerKeyBaseUrlProblem("http://localhost:3000/anthropic")).toBeNull();
    expect(providerKeyBaseUrlProblem("example.com/anthropic")).toBe("invalid");
    expect(providerKeyBaseUrlProblem("http://example.com")).toBe("insecure");
    expect(providerKeyBaseUrlProblem("https://user:pw@example.com")).toBe("credentials");
    expect(providerKeyBaseUrlProblem("https://example.com/path?query=value")).toBe("query");
    expect(providerKeyBaseUrlProblem("https://example.com/path#fragment")).toBe("query");
    expect(
      ProviderKeyConnectInputSchema.safeParse({
        target: { preset: "deepseek", endpoint: "china", agent: "codex" },
        apiKey: "sk-123",
      }).success,
    ).toBe(false);
    expect(
      ProviderKeyConnectInputSchema.safeParse({
        target: { preset: "zhipu", endpoint: "china", agent: "codex" },
        apiKey: "sk-123",
      }).success,
    ).toBe(true);
  });
});
