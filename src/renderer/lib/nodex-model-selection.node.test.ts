import { expect, it } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  agentRuntimeBinding,
  defaultAgentRuntimeModelSelection,
  requireAgentRuntimeModelSelection,
} from "./agent-runtime-model-selection";
import {
  agentRuntimeModelSelection,
  agentRuntimeProviderId,
} from "../../shared/agent-runtime-provider";
import { agentBindingKey, agentModelKey } from "./agent-model-selection";
import { AgentBackendBindingSchema } from "../../shared/schemas/agent-backend";

const id = `nodex_codex_${"a".repeat(32)}`;
const providers = [
  {
    instanceId: id,
    driver: "codex",
    source: "nodex",
    enabled: true,
    installed: true,
    status: "ready",
    models: [{ slug: "gpt-6.1-sol", isDefault: true }],
  },
] as unknown as AgentRuntimeOperations["providers.read"]["output"];
it("retains a managed Codex instance across picker keys, persistence and launch", () => {
  const binding = agentRuntimeBinding(id, [])!;
  expect(AgentBackendBindingSchema.parse(binding)).toEqual(binding);
  expect(agentRuntimeProviderId(binding)).toBe(id);
  expect(agentBindingKey(binding)).not.toBe(agentBindingKey({ kind: "codex" }));
  expect(agentModelKey(binding, "gpt-6.1-sol")).not.toBe(
    agentModelKey({ kind: "codex" }, "gpt-6.1-sol"),
  );
  expect(agentRuntimeModelSelection(binding, "gpt-6.1-sol")).toEqual({
    instanceId: id,
    model: "gpt-6.1-sol",
  });
});
it("retains a managed Claude instance while native configurations keep their own keys", () => {
  const instance = `nodex_claude_${"b".repeat(32)}`;
  const binding = agentRuntimeBinding(instance, [])!;
  expect(binding.kind).toBe("claude");
  expect(agentRuntimeProviderId(binding)).toBe(instance);
  expect(agentRuntimeProviderId({ kind: "claude", instanceConfigId: "local" })).not.toBe(instance);
});
it("never automatically selects prepaid models", () => {
  expect(defaultAgentRuntimeModelSelection(providers)).toBeNull();
  const native = { ...providers[0]!, source: undefined, instanceId: "codex" };
  expect(
    defaultAgentRuntimeModelSelection([providers[0]!, native] as typeof providers)?.instanceId,
  ).toBe("codex");
});
it("refuses unlisted models and retired instances without falling back", () => {
  expect(() =>
    requireAgentRuntimeModelSelection(providers, { instanceId: id, model: "unapproved" }),
  ).toThrow(/unavailable/u);
  expect(() =>
    requireAgentRuntimeModelSelection([], { instanceId: id, model: "gpt-6.1-sol" }),
  ).toThrow(/unavailable/u);
});
