import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { catalogModel } from "@/lib/agent-model-catalog.test-fixtures";
import { agentModelKey } from "@/lib/agent-model-selection";
import type {
  AgentIntelligenceDropdownProps,
  AgentNativeIntelligencePatch,
  AgentNativeIntelligencePresentation,
} from "./agent-intelligence-dropdown";
import type {
  AgentModelCatalogPresentation,
  AgentModelPickerEntry,
} from "./agent-model-catalog-presentation";
import {
  useAgentIntelligenceMenu,
  useAgentModelCatalog,
  type AgentIntelligenceMenu,
} from "./use-agent-intelligence-menu";

const CODEX = { driver: "codex", instanceId: "codex" } as const;
const CLAUDE = { driver: "claudeAgent", instanceId: "work" } as const;
const OPENCODE = { driver: "opencode", instanceId: "local" } as const;

function modelWithEffort(id: string) {
  return {
    ...catalogModel(id),
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Quick answers" },
      { reasoningEffort: "medium", description: "Medium" },
    ],
    defaultReasoningEffort: "medium",
  };
}

test("shares ordered model choices, availability and the off-model credit rules", async () => {
  const current = { binding: CODEX, model: "gpt" };
  const paid = { binding: CLAUDE, model: "opus" };
  const off = { binding: OPENCODE, model: "local/small" };
  const unavailable = { binding: CLAUDE, model: "sonnet" };
  const entry = (
    selection: typeof current | typeof paid | typeof off,
    label: string,
  ): AgentModelPickerEntry => ({
    selection,
    binding: selection.binding,
    label,
    model: catalogModel(selection.model, `${selection.model} display name`),
  });
  const failure = new Error("Could not choose model");
  const choose = vi.fn(async () => {
    throw failure;
  });
  const chooseOff = vi.fn(async () => {});
  const manageModels = vi.fn();
  const catalog: AgentModelCatalogPresentation = {
    entries: [
      entry(current, "Codex"),
      { ...entry(unavailable, "Work"), unavailableReason: "Sign in first" },
    ],
    selected: current,
    loading: true,
    error: "Some providers could not load",
    choose,
    manageModels,
    off: {
      entries: [entry(off, "Local"), { ...entry(paid, "Work"), spendsCredit: true }],
      count: 2,
      choose: chooseOff,
    },
  };
  const { result } = renderHook(() =>
    useAgentIntelligenceMenu({
      catalog,
      models: [],
      selection: { kind: "codex", model: "gpt", reasoningEffort: "default", serviceTier: null },
      onSelectionChange: () => {},
    }),
  );
  const { models, modelLabel } = result.current;
  expect(modelLabel).toBe("gpt display name");
  expect(models.loading).toBe(true);
  expect(models.error).toBe("Some providers could not load");
  const [first, second, third, fourth] = models.choices;
  expect(models.choices).toEqual([
    {
      key: agentModelKey(CODEX, "gpt"),
      binding: CODEX,
      label: "gpt display name",
      detail: null,
      tooltip: "gpt",
      searchText: "gpt display name gpt Codex codex",
      current: true,
      disabled: false,
      off: false,
      opensSettings: false,
    },
    expect.objectContaining({
      detail: "Work · Unavailable",
      tooltip: "Sign in first",
      disabled: true,
    }),
    expect.objectContaining({
      key: `off:${agentModelKey(OPENCODE, off.model)}`,
      detail: "Local · Off",
      off: true,
    }),
    expect.objectContaining({
      detail: "Work · Off",
      tooltip: "Turn on in Settings",
      opensSettings: true,
    }),
  ]);
  await models.choose(second!);
  expect(choose).not.toHaveBeenCalled();
  await expect(models.choose(first!)).rejects.toBe(failure);
  expect(choose).toHaveBeenCalledWith(current);
  await models.choose(third!);
  expect(chooseOff).toHaveBeenCalledExactlyOnceWith(off);
  await models.choose(fourth!);
  expect(manageModels).toHaveBeenCalledExactlyOnceWith("nodex");
});

test("uses Codex's default slider position and applies effort and speed to the selection", async () => {
  const model = {
    ...modelWithEffort("gpt"),
    serviceTiers: [
      { id: "priority", name: "Fast", description: "1.5x speed" },
      { id: "ultrafast", name: "Ultrafast", description: "" },
    ],
  };
  const onSelectionChange = vi.fn();
  const props = {
    models: [model],
    selection: { kind: "codex", model: model.id, reasoningEffort: "default", serviceTier: null },
    onSelectionChange,
  } satisfies AgentIntelligenceDropdownProps;
  const { result } = renderHook(() => {
    const catalog = useAgentModelCatalog(props);
    return useAgentIntelligenceMenu({ ...props, catalog });
  });
  const { effort, effortSlider, speed, fast, ultracode } = result.current;
  expect(effort?.label).toBe("");
  expect(effort?.choices).toEqual([
    { value: "low", label: "Light", description: "Quick answers", current: false },
    { value: "medium", label: "Medium", description: null, current: true },
  ]);
  expect(effortSlider?.isDefault).toBe(true);
  expect(speed?.value).toBeNull();
  expect(speed?.tiers).toEqual([
    { value: "fast", label: "Fast", description: "1.5x speed" },
    { value: "ultrafast", label: "Ultrafast", description: "" },
  ]);
  expect(fast).toBeNull();
  expect(ultracode).toBeNull();

  await effort!.choose("low");
  await speed!.choose("ultrafast");
  expect(onSelectionChange.mock.calls).toEqual([
    [{ ...props.selection, reasoningEffort: "low" }, "reasoningEffort"],
    [{ ...props.selection, serviceTier: "ultrafast" }, "serviceTier"],
  ]);
});

test.each([
  [OPENCODE, "variant"],
  [{ driver: "antigravity", instanceId: "work" } as const, "thinking_level"],
])(
  "projects %o's thought-level select from the same choices used in the footer",
  async (binding, optionId) => {
    const changeConfig = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useAgentIntelligenceMenu({
        catalog: {
          entries: [],
          selected: { binding, model: "model" },
          loading: false,
          choose: () => {},
          changeConfig,
          configOptions: [
            {
              id: "thought-toggle",
              type: "boolean",
              category: "thought_level",
              name: "Thinking",
              description: null,
              currentValue: true,
            },
            {
              id: optionId,
              type: "select",
              category: "thought_level",
              name: "Effort",
              description: null,
              currentValue: "deep",
              options: [
                {
                  group: "effort",
                  name: "Effort",
                  options: [
                    { value: "light", name: "Light", description: null },
                    { value: "deep", name: "Deep", description: "Think longer" },
                  ],
                },
              ],
            },
          ],
        },
        models: [],
        selection: {
          kind: binding.driver,
          model: "model",
          reasoningEffort: "none",
          serviceTier: null,
        },
        onSelectionChange: () => {},
      }),
    );
    const { effort, configOptions, fast, ultracode } = result.current;
    expect(effort?.choices).toEqual([
      { value: "light", label: "Light", description: null, current: false },
      { value: "deep", label: "Deep", description: "Think longer", current: true },
    ]);
    expect(configOptions[1]?.choices).toBe(effort?.choices);
    expect(fast).toBeNull();
    expect(ultracode).toBeNull();

    await effort!.choose("light");
    expect(changeConfig).toHaveBeenCalledExactlyOnceWith(optionId, "light");
  },
);

function pendingWrite() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("queues native changes, shows their intent, and rejects writes without blocking newer choices", async () => {
  const model = modelWithEffort("opus");
  const rejected = pendingWrite();
  const accepted = pendingWrite();
  const failure = new Error("Could not disable thinking");
  const change = vi
    .fn<(patch: AgentNativeIntelligencePatch) => Promise<void>>()
    .mockReturnValueOnce(rejected.promise)
    .mockReturnValueOnce(accepted.promise);
  const props = {
    models: [model],
    agent: { binding: CLAUDE, label: "Work" },
    selection: {
      kind: "claudeAgent",
      model: model.id,
      reasoningEffort: "medium",
      serviceTier: null,
    },
    onSelectionChange: () => {},
    provider: {
      label: "Work",
      selection: "claudeAgent",
      nativeIntelligence: {
        selected: { thinking: true },
        capabilities: { disableThinking: true, fastMode: true, ultracode: true },
        change,
      },
    },
  } satisfies AgentIntelligenceDropdownProps;
  const { result, rerender } = renderHook<
    AgentIntelligenceMenu,
    AgentNativeIntelligencePresentation["capabilities"]
  >(
    (capabilities) => {
      const input = {
        ...props,
        provider: {
          ...props.provider,
          nativeIntelligence: { ...props.provider.nativeIntelligence, capabilities },
        },
      };
      const catalog = useAgentModelCatalog(input);
      return useAgentIntelligenceMenu({ ...input, catalog });
    },
    { initialProps: props.provider.nativeIntelligence.capabilities },
  );
  expect(result.current.effort?.choices.map(({ label }) => label)).toEqual([
    "Off",
    "Low",
    "Medium",
  ]);

  const writes: Promise<void>[] = [];
  await act(async () => {
    const { effort, fast, ultracode } = result.current;
    writes.push(expect(effort!.choose("off")).rejects.toBe(failure));
    writes.push(fast!.set(true), ultracode!.set(true), effort!.choose("low"));
  });
  expect(result.current.effort?.choices.find((choice) => choice.current)?.value).toBe("low");
  expect(result.current.fast?.on).toBe(true);
  expect(result.current.ultracode?.on).toBe(true);
  expect(change.mock.calls).toEqual([[{ thinking: false }]]);
  await act(async () => {
    rejected.reject(failure);
    await writes[0];
  });
  expect(result.current.effort?.choices.find((choice) => choice.current)?.value).toBe("low");
  await act(async () => {
    accepted.resolve();
    await Promise.all(writes.slice(1));
  });
  expect(change.mock.calls).toEqual([
    [{ thinking: false }],
    [{ fast: true, ultracode: true, effort: "low", thinking: true }],
  ]);

  rerender({ ultracodeUnavailableReason: "Enable dynamic workflows to use Ultracode." });
  expect(result.current.fast).toBeNull();
  expect(result.current.ultracode).toMatchObject({
    on: false,
    unavailableReason: "Enable dynamic workflows to use Ultracode.",
  });
  await result.current.ultracode!.set(true);
  expect(change).toHaveBeenCalledTimes(2);
});
