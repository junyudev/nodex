import { expect, it } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  DEFAULT_MODEL_POLICY,
  projectModelPolicyCatalog,
  setModelOn,
} from "../../shared/model-policy";
import {
  defaultAgentRuntimeModelSelection,
  requireAgentRuntimeModelSelection,
} from "./agent-runtime-model-selection";
const provider: AgentRuntimeOperations["providers.read"]["output"][number] = {
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-07T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    { slug: "sol", name: "Sol", isCustom: false, isDefault: true, capabilities: null },
    { slug: "luna", name: "Luna", isCustom: false, capabilities: null },
  ],
};
it("automatic composer defaults skip off models while saved exact defaults remain explicit refusals", () => {
  const providers = projectModelPolicyCatalog(
    [provider],
    setModelOn(DEFAULT_MODEL_POLICY, provider, "sol", false),
  );
  expect(defaultAgentRuntimeModelSelection(providers)?.model).toBe("luna");
  const saved = defaultAgentRuntimeModelSelection(providers, { model: "sol" });
  expect(saved?.model).toBe("sol");
  expect(() => requireAgentRuntimeModelSelection(providers, saved)).toThrow(
    "Sol on Codex is off in Settings → Models. Choose another model.",
  );
});
