import { expect, it } from "vite-plus/test";
import { modelPolicyCatalog } from "./model-policy-catalog";
import { DEFAULT_MODEL_POLICY, automaticModelCatalog, setModelOn } from "../../shared/model-policy";
import { projectAgentCatalog } from "../mobile-gateway/catalog";
import { inboxAgentCandidates } from "../inbox-application/inbox-agent-candidates";
import { selectPageTextRewriteModel } from "../page-text-rewrite/rewrite-model";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
const alice = {
  issuer: "https://clerk.nodex.jyu.app",
  subject: "alice",
  email: null,
  name: null,
  imageUrl: null,
};
const native: AgentRuntimeOperations["providers.read"]["output"][number] = {
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
  supportsTextGeneration: true,
  models: [
    { slug: "off", name: "Off", isDefault: true, isCustom: false, capabilities: null },
    { slug: "on", name: "On", isCustom: false, capabilities: null },
  ],
};
const choice = { instanceId: "missing", model: null, reasoningEffort: null, serviceTier: null };
it("keeps Nodex inventory when managed processes are absent and preserves model policy across accounts", () => {
  const policy = setModelOn(
    DEFAULT_MODEL_POLICY,
    { instanceId: "unused", driver: "codex", source: "nodex" },
    "gpt-6.1-sol",
    false,
  );
  const first = modelPolicyCatalog([], policy, alice);
  const second = modelPolicyCatalog([], policy, { ...alice, subject: "bob" });
  expect(first).toHaveLength(2);
  expect(second.map((provider) => provider.instanceId)).not.toEqual(
    first.map((provider) => provider.instanceId),
  );
  for (const providers of [first, second])
    expect(
      providers
        .find((provider) => provider.driver === "codex")
        ?.models.find((model) => model.slug === "gpt-6.1-sol")?.policy,
    ).toEqual({ on: false, switchOn: false, spendsCredit: true });
});
it("planner, Mobile and Refine automatic paths skip credit and disabled model defaults", () => {
  const policy = setModelOn(DEFAULT_MODEL_POLICY, native, "off", false);
  const providers = modelPolicyCatalog([native], policy, alice);
  expect(
    automaticModelCatalog(providers).flatMap((provider) =>
      provider.models.map((model) => model.slug),
    ),
  ).toEqual(["on"]);
  expect(projectAgentCatalog(providers, choice).defaultChoice).toEqual({
    providerInstanceId: "codex",
    model: "on",
  });
  expect(
    inboxAgentCandidates(providers, { now: 0, useModelGuide: false }).flatMap((provider) =>
      provider.models.map((model) => model.model),
    ),
  ).toEqual(["on"]);
  expect(selectPageTextRewriteModel(providers, { suggestionAgent: choice })?.model).toBe("on");
  const onlyCredit = providers.filter((provider) => provider.source === "nodex");
  expect(projectAgentCatalog(onlyCredit, choice).defaultChoice).toBeNull();
  expect(inboxAgentCandidates(onlyCredit, { now: 0, useModelGuide: false })).toEqual([]);
  expect(selectPageTextRewriteModel(onlyCredit, { suggestionAgent: choice })).toBeNull();
});
