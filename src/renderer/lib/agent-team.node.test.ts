import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_POLICY,
  projectModelPolicyCatalog,
  setModelOn,
} from "../../shared/model-policy";
import { providerKeyRuntimeInstanceId } from "../../shared/provider-keys";
import { agentRuntimeProviderFixture } from "../../shared/testing/agent-runtime-snapshot";
import { agentTeammate, newChatAgentTeam } from "./agent-team";

const model = {
  slug: "model",
  name: "Model",
  isDefault: true,
  isCustom: false,
  capabilities: null,
};
const codex = agentRuntimeProviderFixture({ models: [model] });
const claude = agentRuntimeProviderFixture({
  instanceId: "claude_work",
  driver: "claudeAgent",
  displayName: "Claude Code",
  models: [model],
});

describe("agentTeammate", () => {
  it("finds another harness and skips a second sign-in to the lead's harness", () => {
    const personalClaude = { ...claude, instanceId: "claude_personal" };
    expect(agentTeammate([claude, personalClaude, codex], claude.instanceId)).toBe(codex);
    expect(agentTeammate([claude, personalClaude], claude.instanceId)).toBeNull();
  });

  const [modelsOff] = projectModelPolicyCatalog(
    [claude],
    setModelOn(DEFAULT_MODEL_POLICY, claude, model.slug, false),
  );
  it.each([
    [
      "unavailable",
      agentRuntimeProviderFixture({
        ...claude,
        availability: "unavailable",
        enabled: false,
        installed: false,
      }),
    ],
    ["signed out", agentRuntimeProviderFixture({ ...claude, auth: { status: "unauthenticated" } })],
    ["all models off", modelsOff!],
    ["still being checked", agentRuntimeProviderFixture({ ...claude, checkPending: true })],
  ] as const)("skips an Agent that is %s", (_reason, candidate) => {
    expect(agentTeammate([codex, candidate], codex.instanceId)).toBeNull();
  });

  it("never offers an Agent that spends credits, even to a lead that runs on them", () => {
    const creditCodex = agentRuntimeProviderFixture({
      ...codex,
      instanceId: `nodex_codex_${"a".repeat(32)}`,
      source: "nodex",
    });
    const creditClaude = agentRuntimeProviderFixture({
      ...claude,
      instanceId: `nodex_claude_${"a".repeat(32)}`,
      source: "nodex",
    });
    expect(agentTeammate([claude, creditCodex], claude.instanceId)).toBeNull();
    expect(agentTeammate([creditClaude, creditCodex], creditClaude.instanceId)).toBeNull();
    expect(agentTeammate([creditClaude, codex], creditClaude.instanceId)).toBe(codex);
  });

  it("offers a managed API key to Claude Code even though both use the same driver", () => {
    const apiKey = agentRuntimeProviderFixture({
      ...claude,
      instanceId: providerKeyRuntimeInstanceId({ preset: "deepseek", id: "test-key" }),
      displayName: "DeepSeek",
    });
    expect(agentTeammate([claude, apiKey], claude.instanceId)).toBe(apiKey);
  });
});

describe("newChatAgentTeam", () => {
  it("starts on Codex by default and follows a remembered Agent choice", () => {
    const providers = [claude, codex];
    expect(newChatAgentTeam(providers)).toEqual({ lead: codex, teammate: claude });
    expect(
      newChatAgentTeam(providers, {
        remembered: {
          binding: { driver: claude.driver, instanceId: claude.instanceId },
          model: model.slug,
        },
      }),
    ).toEqual({ lead: claude, teammate: codex });
  });

  it("has no team while the chat would start on a model that is off", () => {
    const other = { ...model, slug: "other", isDefault: false };
    const [offCodex] = projectModelPolicyCatalog(
      [agentRuntimeProviderFixture({ models: [model, other] })],
      setModelOn(DEFAULT_MODEL_POLICY, codex, model.slug, false),
    );
    const remembered = {
      binding: { driver: codex.driver, instanceId: codex.instanceId },
      model: model.slug,
    };
    expect(newChatAgentTeam([offCodex!, claude], { remembered })).toBeNull();
    expect(newChatAgentTeam([offCodex!, claude])).toEqual({ lead: offCodex, teammate: claude });
  });

  it("has no team when only one Agent is connected", () => {
    expect(newChatAgentTeam([codex])).toBeNull();
  });
});
