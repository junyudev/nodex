import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_POLICY as defaults,
  ModelPolicySchema,
  canStartModel,
  isModelOn,
  isModelSwitchOn,
  setModelOn,
  setProviderOn,
  policyModelKey,
  modelPolicyFailure,
  projectModelPolicyCatalog,
  automaticModelCatalog,
  withFreeModelsOn,
} from "./model-policy";
const credit = { instanceId: "nodex_codex_alice", driver: "codex", source: "nodex" };
const native = { instanceId: "codex_work", driver: "codex" };
describe("Profile model policy", () => {
  it("starts OpenCode off, free models included, and every other provider on", () => {
    for (const driver of ["opencode", "opencode2"]) {
      expect(isModelOn(defaults, { ...native, driver }, "opencode/x-free")).toBe(false);
      expect(isModelOn(defaults, { ...native, driver }, "opencode/x")).toBe(false);
    }
    expect(isModelOn(defaults, credit, "new-model")).toBe(true);
  });
  it("turns on a provider's free models and nothing else", () => {
    const provider = {
      ...native,
      driver: "opencode",
      models: [{ slug: "opencode/x-free" }, { slug: "opencode/x" }],
    };
    const policy = withFreeModelsOn(defaults, provider);
    expect(isModelOn(policy, provider, "opencode/x-free")).toBe(true);
    expect(isModelOn(policy, provider, "opencode/x")).toBe(false);
    expect(
      automaticModelCatalog(projectModelPolicyCatalog([provider], defaults))[0]?.models,
    ).toEqual([]);
  });
  it("preserves individual exceptions through provider off/on and account changes", () => {
    const off = setModelOn(defaults, credit, "sol", false);
    const disabled = setProviderOn(off, credit, false);
    expect(isModelSwitchOn(disabled, credit, "sol")).toBe(false);
    expect(isModelSwitchOn(disabled, credit, "luna")).toBe(true);
    const bob = { ...credit, instanceId: "nodex_codex_bob" };
    expect(isModelOn(disabled, bob, "new-model")).toBe(false);
    expect(setProviderOn(disabled, bob, true)).toEqual(off);
    expect(policyModelKey(credit, "sol")).toEqual(policyModelKey(bob, "sol"));
    expect(policyModelKey(native, "sol")).not.toEqual(
      policyModelKey({ ...native, instanceId: "codex_personal" }, "sol"),
    );
    expect(policyModelKey(native, "sol")).not.toEqual(policyModelKey(native, "SOL"));
  });
  it.each(["person", "nodex-agent", "agent", "automatic"] as const)(
    "enforces the origin matrix for %s",
    (origin) => {
      expect(canStartModel(defaults, native, "sol", origin)).toBe(true);
      expect(canStartModel(defaults, credit, "sol", origin)).toBe(
        origin === "person" || origin === "nodex-agent",
      );
      expect(
        canStartModel({ ...defaults, agentsMayChooseCredit: true }, credit, "sol", origin),
      ).toBe(origin !== "automatic");
      expect(canStartModel(setModelOn(defaults, native, "sol", false), native, "sol", origin)).toBe(
        false,
      );
    },
  );
  it("names the exact model, refuses non-retryably and never widens off via origin", () => {
    expect(
      modelPolicyFailure(
        setModelOn(defaults, credit, "gpt-6.1-sol", false),
        credit,
        "gpt-6.1-sol",
        "person",
        "GPT-6.1 Sol",
      ),
    ).toEqual({
      code: "model_off",
      retryable: false,
      message: "GPT-6.1 Sol on Nodex is off in Settings → Models. Choose another model.",
    });
    expect(modelPolicyFailure(defaults, credit, "sol", "agent")?.code).toBe(
      "credit_requires_person",
    );
  });
  it("keeps all Settings rows while automatic resolution excludes credit and off models", () => {
    const policy = setModelOn(defaults, native, "sol", false);
    const providers = projectModelPolicyCatalog(
      [
        { ...native, models: [{ slug: "sol" }, { slug: "luna" }] },
        { ...credit, models: [{ slug: "sol" }] },
      ],
      policy,
    );
    expect(providers[0]?.models[0]?.policy).toEqual({
      on: false,
      switchOn: false,
      spendsCredit: false,
    });
    expect(
      automaticModelCatalog(providers).map((provider) =>
        provider.models.map((model) => model.slug),
      ),
    ).toEqual([["luna"]]);
  });
  it("rejects malformed policy without defaulting open", () => {
    expect(ModelPolicySchema.safeParse({ ...defaults, agentsMayChooseCredit: "yes" }).success).toBe(
      false,
    );
  });
});
