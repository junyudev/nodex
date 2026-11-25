import { PROVIDER_SLUG_MAX_CHARS } from "@nodex/agent-runtime/contracts";
import { providerKeyRuntimeInstanceId } from "../../shared/provider-keys";
import { expect, it } from "vite-plus/test";
import { presentProviderKeys, readStoredProviderKeys } from "./provider-key-storage";

it("keeps legacy Claude connections and explicitly saved Codex connections on their original Agent", () => {
  const legacy = {
    id: "legacy",
    target: { preset: "deepseek", endpoint: "international" },
    displayName: "DeepSeek",
    enabled: true,
    models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }],
    keyHint: "",
    secretRef: "17cf7bd8-a2c9-4e8e-b706-3569ad860c50",
  };
  const codex = {
    ...legacy,
    id: "codex",
    target: { ...legacy.target, agent: "codex" },
  };
  expect(presentProviderKeys(readStoredProviderKeys([legacy, codex])).connections).toMatchObject([
    { id: "legacy", agent: "claudeAgent", models: legacy.models },
    { id: "codex", agent: "codex", models: codex.models },
  ]);
});
it("skips saved connections whose runtime ID or name is invalid, including disabled connections", () => {
  const preset = "deepseek";
  const longestId = "a".repeat(
    PROVIDER_SLUG_MAX_CHARS - providerKeyRuntimeInstanceId({ id: "", preset }).length,
  );
  const connection = {
    id: longestId,
    displayName: "  DeepSeek  ",
    target: { preset, endpoint: "international", agent: "codex" },
    enabled: false,
    models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }],
    keyHint: "",
    secretRef: "17cf7bd8-a2c9-4e8e-b706-3569ad860c50",
  };
  const stored = readStoredProviderKeys([
    { ...connection, id: `${longestId}a` },
    { ...connection, displayName: " \t\n " },
    connection,
  ]);
  expect(stored).toHaveLength(1);
  expect(presentProviderKeys(stored).connections[0]).toMatchObject({
    id: longestId,
    displayName: "DeepSeek",
    enabled: false,
  });
});
