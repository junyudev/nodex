import { describe, expect, it } from "vitest";
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
      ]),
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
    expect(providerKeyBaseUrl({ preset: "moonshot", endpoint: "international" })).toBe(
      "https://api.moonshot.ai/anthropic",
    );
    expect(providerKeyBaseUrl({ preset: "custom", baseUrl: " https://gw.example.com/v1/ " })).toBe(
      "https://gw.example.com/v1",
    );
    expect(providerKeyDefaultName({ preset: "custom", baseUrl: "https://api.example.com/a" })).toBe(
      "example.com",
    );
    expect(providerKeyBaseUrlProblem("http://localhost:3000/anthropic")).toBeNull();
    expect(providerKeyBaseUrlProblem("example.com/anthropic")).toBe("invalid");
    expect(providerKeyBaseUrlProblem("http://example.com")).toBe("insecure");
    expect(providerKeyBaseUrlProblem("https://user:pw@example.com")).toBe("credentials");
    expect(providerKeyBaseUrlProblem("https://example.com/path?query=value")).toBe("query");
    expect(providerKeyBaseUrlProblem("https://example.com/path#fragment")).toBe("query");
    expect(
      ProviderKeyConnectInputSchema.safeParse({
        target: { preset: "deepseek", endpoint: "china" },
        apiKey: "sk-123",
      }).success,
    ).toBe(false);
    expect(
      ProviderKeyConnectInputSchema.safeParse({
        target: { preset: "zhipu", endpoint: "china" },
        apiKey: "sk-123",
      }).success,
    ).toBe(true);
  });
});
