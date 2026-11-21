import { expect, it } from "vite-plus/test";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type ServerProvider,
} from "@nodex/runtime-contracts";
import {
  antigravityModelPolicyIdentity,
  antigravitySuffixedModel,
} from "./antigravityModelSelection.ts";

const provider: Pick<ServerProvider, "driver" | "models"> = {
  driver: ProviderDriverKind.make("antigravity"),
  models: [
    {
      slug: "gemini-3.8-flash",
      name: "Gemini Flash",
      isCustom: false,
      aliases: [ANTIGRAVITY_DEFAULT_MODEL],
      capabilities: {
        optionDescriptors: [
          {
            id: "thought_level",
            type: "select",
            role: "reasoning",
            label: "Thinking",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};
it("resolves native thinking suffixes only against advertised reasoning choices", () => {
  expect(antigravitySuffixedModel(provider, "gemini-3.8-flash-high")).toEqual({
    model: "gemini-3.8-flash",
    thinking: { id: "thought_level", value: "high" },
  });
  expect(antigravitySuffixedModel(provider, "gemini-3.8-flash-unknown")).toBeUndefined();
  expect(antigravitySuffixedModel(provider, "gemini-3.8-flash")).toBeUndefined();
  expect(
    antigravitySuffixedModel(
      { ...provider, driver: ProviderDriverKind.make("acpRegistry") },
      "gemini-3.8-flash-high",
    ),
  ).toBeUndefined();
  expect(
    antigravitySuffixedModel(
      {
        ...provider,
        models: [
          ...provider.models,
          {
            slug: "gemini-3.8-flash-high",
            name: "Explicit model",
            isCustom: true,
            capabilities: null,
          },
        ],
      },
      "gemini-3.8-flash-high",
    ),
  ).toBeUndefined();
});

it("uses the advertised Antigravity model as the policy identity for default and legacy IDs", () => {
  expect(antigravityModelPolicyIdentity(provider, ANTIGRAVITY_DEFAULT_MODEL)).toBe(
    "gemini-3.8-flash",
  );
  expect(antigravityModelPolicyIdentity(provider, "gemini-3.8-flash-high")).toBe(
    "gemini-3.8-flash",
  );
  expect(antigravityModelPolicyIdentity(provider, "gemini-pro")).toBe("gemini-pro");
});
