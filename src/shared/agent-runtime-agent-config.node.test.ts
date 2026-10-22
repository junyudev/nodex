import { expect, it } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { resolveAgentRuntimeAgentConfig } from "./agent-runtime-agent-config";

const providers = [
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      { slug: "default", name: "Default", isDefault: true, isCustom: false, capabilities: null },
      { slug: "chosen", name: "Chosen", isDefault: false, isCustom: false, capabilities: null },
    ],
  },
] satisfies AgentRuntimeOperations["providers.read"]["output"];
const base = {
  providers,
  modelSelection: { instanceId: "codex", model: "default" },
  interactionMode: "default" as const,
};

it("resolves a model and mode without requiring or manufacturing execution identity", () => {
  const message = {
    text: "Task",
    agentConfigs: [{ model: "chosen", mode: "plan" }],
    provenance: "editor",
  };
  const result = resolveAgentRuntimeAgentConfig({ ...base, message });
  expect(result).toEqual({
    hasConfig: true,
    message: {
      ...message,
      modelSelection: { instanceId: "codex", model: "chosen", options: [] },
      interactionMode: "plan",
    },
  });
  expect(result.message).not.toHaveProperty("messageId");
  expect(message).not.toHaveProperty("modelSelection");
});

it("parses raw config only when the structured config sidecar is absent", () => {
  const text = 'Task\n<agent-config model="chosen" />';
  expect(resolveAgentRuntimeAgentConfig({ ...base, message: { text } })).toMatchObject({
    hasConfig: true,
    message: { text: "Task", modelSelection: { instanceId: "codex", model: "chosen" } },
  });
  const message = { text, agentConfigs: [] };
  const result = resolveAgentRuntimeAgentConfig({ ...base, message });
  expect(result.hasConfig).toBe(false);
  expect(result.message).toBe(message);
});

it("refuses an unavailable configured model before changing the original message", () => {
  const message = { text: "Task", agentConfigs: [{ model: "removed" }] };
  expect(() => resolveAgentRuntimeAgentConfig({ ...base, message })).toThrow(
    "Agent model 'removed' is unavailable",
  );
  expect(message).toEqual({ text: "Task", agentConfigs: [{ model: "removed" }] });
});
