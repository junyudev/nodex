import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_POLICY,
  setModelOn,
  setProviderOn,
  type PolicyProvider,
} from "../../shared/model-policy";
import { creditWorkStoppedBy } from "./model-policy-stopped-work";

const codex = {
  instanceId: "nodex_codex_a",
  driver: "codex",
  source: "nodex",
  models: [
    { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { slug: "gpt-6-luna", name: "GPT-6 Luna" },
  ],
};
const claude = {
  instanceId: "nodex_claude_a",
  driver: "claudeAgent",
  source: "nodex",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ],
};
const providers = [codex, claude];
const onCodex = (rootThreadId: string, model = "gpt-6.1-sol") => ({
  rootThreadId,
  instanceId: codex.instanceId,
  model,
});
const onClaude = (rootThreadId: string, model: string) => ({
  rootThreadId,
  instanceId: claude.instanceId,
  model,
});
const stopped = (
  work: Parameters<typeof creditWorkStoppedBy>[0]["work"],
  next: typeof DEFAULT_MODEL_POLICY,
) => creditWorkStoppedBy({ work, providers, current: DEFAULT_MODEL_POLICY, next });
const off = (provider: PolicyProvider, model: string) =>
  setModelOn(DEFAULT_MODEL_POLICY, provider, model, false);

describe("creditWorkStoppedBy", () => {
  it("has nothing to ask when no chat is running on what turns off", () => {
    expect(stopped([], setProviderOn(DEFAULT_MODEL_POLICY, codex, false))).toBeNull();
    expect(stopped([onCodex("a", "gpt-6-luna")], off(codex, "gpt-6.1-sol"))).toBeNull();
  });

  it("stops work on the model that turns off", () => {
    expect(stopped([onCodex("a")], off(codex, "gpt-6.1-sol"))).toEqual({
      chats: 1,
      models: ["GPT-6.1 Sol"],
      stopsAllowedModels: false,
    });
  });

  it("stops everything when Nodex turns off and counts a chat's subagents once", () => {
    expect(
      stopped(
        [onCodex("a"), onCodex("a", "gpt-6-luna"), onClaude("b", "claude-opus-5-5")],
        setProviderOn(DEFAULT_MODEL_POLICY, codex, false),
      ),
    ).toEqual({
      chats: 2,
      models: ["GPT-6.1 Sol", "GPT-6 Luna", "Claude Opus 5.5"],
      stopsAllowedModels: false,
    });
  });

  it("includes Claude chats on allowed models, because narrowing restarts that instance", () => {
    expect(stopped([onClaude("a", "claude-sonnet-5-5")], off(claude, "claude-opus-5-5"))).toEqual({
      chats: 1,
      models: ["Claude Sonnet 5.5"],
      stopsAllowedModels: true,
    });
  });

  it("leaves other chats alone when a Codex model turns off", () => {
    expect(stopped([onClaude("a", "claude-sonnet-5-5")], off(codex, "gpt-6.1-sol"))).toBeNull();
  });

  it("stops nothing when a model turns back on", () => {
    expect(
      creditWorkStoppedBy({
        work: [onClaude("a", "claude-sonnet-5-5")],
        providers,
        current: off(claude, "claude-opus-5-5"),
        next: DEFAULT_MODEL_POLICY,
      }),
    ).toBeNull();
  });
});
