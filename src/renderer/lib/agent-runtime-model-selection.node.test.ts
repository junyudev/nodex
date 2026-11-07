import { describe, expect, it } from "vite-plus/test";
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

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

const speed = {
  id: "serviceTier",
  label: "Speed",
  type: "select" as const,
  options: [
    { id: "default", label: "Standard" },
    { id: "fast", label: "Fast" },
  ],
};
const provider: Provider = {
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
    {
      slug: "sol",
      name: "Sol",
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [speed] },
    },
    { slug: "luna", name: "Luna", isCustom: false, capabilities: null },
  ],
};
const claude: Provider = {
  ...provider,
  instanceId: "claude_work",
  driver: "claudeAgent",
  displayName: "Claude",
  models: [
    { slug: "opus", name: "Opus", isCustom: false, isDefault: true, capabilities: null },
    {
      slug: "sonnet",
      name: "Sonnet",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    },
  ],
};
const nodex: Provider = {
  ...provider,
  instanceId: `nodex_codex_${"a".repeat(32)}`,
  source: "nodex",
  displayName: "Nodex",
};

it("automatic composer defaults skip off models while a remembered off model remains an explicit refusal", () => {
  const providers = projectModelPolicyCatalog(
    [provider],
    setModelOn(DEFAULT_MODEL_POLICY, provider, "sol", false),
  );
  expect(defaultAgentRuntimeModelSelection(providers)?.model).toBe("luna");
  const remembered = defaultAgentRuntimeModelSelection(providers, {
    remembered: { binding: { kind: "codex" }, model: "sol" },
  });
  expect(remembered?.model).toBe("sol");
  expect(() => requireAgentRuntimeModelSelection(providers, remembered)).toThrow(
    "Sol on Codex is off in Settings → Models. Choose another model.",
  );
});

describe("the remembered new chat choice", () => {
  const sonnet = {
    binding: {
      kind: "claude" as const,
      instanceConfigId: "work",
      runtimeInstanceId: claude.instanceId,
    },
    model: "sonnet",
    options: [{ id: "effort", value: "max" }],
  };

  it("starts a new chat on its Agent, model and options rather than on Codex", () => {
    expect(defaultAgentRuntimeModelSelection([provider, claude], { remembered: sonnet })).toEqual({
      instanceId: claude.instanceId,
      model: "sonnet",
      options: sonnet.options,
    });
  });

  it("drops options the model no longer offers", () => {
    expect(
      defaultAgentRuntimeModelSelection([provider, claude], {
        remembered: { ...sonnet, options: [{ id: "effort", value: "retired" }] },
      }),
    ).toEqual({ instanceId: claude.instanceId, model: "sonnet" });
  });

  it("does not ask for a capability the account has since lost", () => {
    const withUltracode = (unavailableReason?: string): Provider => ({
      ...claude,
      models: [
        {
          slug: "sonnet",
          name: "Sonnet",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "ultracode",
                label: "Ultracode",
                type: "boolean",
                ...(unavailableReason ? { unavailableReason } : {}),
              },
            ],
          },
        },
      ],
    });
    const remembered = { ...sonnet, options: [{ id: "ultracode", value: true }] };
    expect(defaultAgentRuntimeModelSelection([withUltracode()], { remembered })?.options).toEqual(
      remembered.options,
    );
    expect(
      defaultAgentRuntimeModelSelection([withUltracode("Dynamic workflows are off")], {
        remembered,
      })?.options,
    ).toBeUndefined();
  });

  it("stays on its Agent's default when the Agent no longer offers the model", () => {
    expect(
      defaultAgentRuntimeModelSelection([provider, claude], {
        remembered: { ...sonnet, model: "retired" },
      }),
    ).toEqual({ instanceId: claude.instanceId, model: "opus" });
  });

  it.each([
    ["signed out or broken", [provider, { ...claude, status: "error" as const }]],
    ["turned off", [provider, { ...claude, enabled: false }]],
    ["no longer configured", [provider]],
  ])("starts on Codex while its Agent is %s", (_state, providers) => {
    expect(defaultAgentRuntimeModelSelection(providers, { remembered: sonnet })?.instanceId).toBe(
      "codex",
    );
  });

  it("takes native Codex's speed from the global preference, even when the model chose another", () => {
    const fast = [{ id: "serviceTier", value: "fast" }];
    expect(
      defaultAgentRuntimeModelSelection([provider], {
        remembered: { binding: { kind: "codex" }, model: "sol", options: fast },
        codexServiceTier: null,
      })?.options,
    ).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(
      defaultAgentRuntimeModelSelection([provider], { codexServiceTier: "fast" })?.options,
    ).toEqual(fast);
  });

  describe("on a credit model", () => {
    const credit = {
      binding: { kind: "codex" as const, runtimeInstanceId: nodex.instanceId },
      model: "sol",
      options: [{ id: "serviceTier", value: "fast" }],
    };

    it("starts a chat whose picker the person sees, at its own speed", () => {
      expect(
        defaultAgentRuntimeModelSelection([provider, nodex], {
          remembered: credit,
          codexServiceTier: null,
          attended: true,
        }),
      ).toEqual({ instanceId: nodex.instanceId, model: "sol", options: credit.options });
    });

    it("never starts a chat no one sees on its own", () => {
      expect(
        defaultAgentRuntimeModelSelection([provider, nodex], { remembered: credit })?.instanceId,
      ).toBe("codex");
    });

    it("falls back away from credit when the model or account is gone", () => {
      for (const providers of [[provider], [provider, { ...nodex, models: [] }]])
        expect(
          defaultAgentRuntimeModelSelection(providers, { remembered: credit, attended: true })
            ?.instanceId,
        ).toBe("codex");
      expect(
        defaultAgentRuntimeModelSelection([{ ...nodex, models: [nodex.models[1]!] }], {
          remembered: credit,
          attended: true,
        }),
      ).toBeNull();
    });
  });
});
