import { describe, expect, it } from "vite-plus/test";
import {
  initialProviderKeyDraft,
  parseTypedModels,
  providerKeyConnectInput,
  providerKeyDraftProblem,
  providerKeyEndpoint,
  providerKeyFailureField,
} from "./provider-key-form-model";
import { providerKeyDetail, providerKeysSummary } from "./provider-keys-model";

describe("API key form", () => {
  it("starts a two-region provider on the region matching the app's language", () => {
    const kimi = initialProviderKeyDraft("moonshot");
    expect(providerKeyEndpoint(kimi, "zh-CN")?.id).toBe("china");
    expect(providerKeyEndpoint(kimi, "en-US")?.id).toBe("international");
    expect(providerKeyEndpoint({ ...kimi, endpoints: { moonshot: "china" } }, "en-US")?.id).toBe(
      "china",
    );
    expect(providerKeyEndpoint(initialProviderKeyDraft("deepseek"), "zh-CN")?.id).toBe(
      "international",
    );
    expect(providerKeyEndpoint(initialProviderKeyDraft("custom"), "en")).toBeNull();
  });

  it("names the field that keeps a draft from being sent", () => {
    expect(providerKeyDraftProblem(initialProviderKeyDraft())?.field).toBe("apiKey");
    expect(
      providerKeyDraftProblem({ ...initialProviderKeyDraft(), apiKey: "sk 1" })?.message
        .defaultMessage,
    ).toContain("no spaces");
    const custom = { ...initialProviderKeyDraft("custom"), apiKey: "sk-1" };
    expect(providerKeyDraftProblem(custom)?.field).toBe("baseUrl");
    expect(providerKeyDraftProblem({ ...custom, baseUrl: "http://example.com" })?.field).toBe(
      "baseUrl",
    );
    expect(providerKeyDraftProblem({ ...custom, baseUrl: "https://gw.example.com" })).toBeNull();
  });

  it("sends a preset's endpoint, or a custom URL with any typed models", () => {
    expect(
      providerKeyConnectInput({ ...initialProviderKeyDraft("zhipu"), apiKey: " k1 " }, "zh"),
    ).toEqual({ target: { preset: "zhipu", endpoint: "china" }, apiKey: "k1" });
    expect(
      providerKeyConnectInput(
        {
          ...initialProviderKeyDraft("custom"),
          baseUrl: "https://gw.example.com/anthropic",
          apiKey: "k2",
          modelsText: "qwen3-coder-plus\n\nqwen3-coder-plus, glm-5.3",
        },
        "en",
      ),
    ).toEqual({
      target: { preset: "custom", baseUrl: "https://gw.example.com/anthropic" },
      apiKey: "k2",
      models: [
        { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
        { id: "glm-5.3", name: "GLM 5.3" },
      ],
    });
    expect(parseTypedModels("custom", " \n")).toEqual([]);
  });

  it("points a failure at the field that fixes it", () => {
    expect(providerKeyFailureField("rejected", "deepseek")).toBe("apiKey");
    expect(providerKeyFailureField("no-models", "custom")).toBe("models");
    expect(providerKeyFailureField("unreachable", "custom")).toBe("baseUrl");
    expect(providerKeyFailureField("unreachable", "deepseek")).toBeNull();
  });
});

describe("API key connections", () => {
  const connection = {
    id: "c1",
    preset: "moonshot",
    endpoint: "china",
    baseUrl: null,
    displayName: "Kimi",
    enabled: true,
    models: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    ],
    keyHint: "9x1z",
  } as const;

  it("describes what a connection offers and where it sends requests", () => {
    expect(providerKeyDetail(connection)).toBe("2 models · ••••9x1z · China");
    expect(
      providerKeyDetail({
        ...connection,
        preset: "custom",
        endpoint: null,
        baseUrl: "https://gw.example.com:8443/anthropic",
        keyHint: "",
        models: [{ id: "m", name: "M" }],
      }),
    ).toBe("1 model · gw.example.com:8443");
  });

  it("summarizes the card by provider until there are many", () => {
    expect(providerKeysSummary(null)).toBeNull();
    expect(providerKeysSummary([])).toBe("Not set up");
    expect(providerKeysSummary([connection])).toBe("Kimi");
    expect(providerKeysSummary([connection, { ...connection, id: "c2", displayName: "GLM" }])).toBe(
      "Kimi, GLM",
    );
    expect(
      providerKeysSummary([connection, { ...connection, id: "c2" }, { ...connection, id: "c3" }]),
    ).toBe("3 keys");
    expect(providerKeysSummary([{ ...connection, enabled: false }])).toBe("Off");
  });
});
