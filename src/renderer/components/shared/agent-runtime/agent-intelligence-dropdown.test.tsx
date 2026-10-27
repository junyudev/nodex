import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai } from "@/test/thread-maitai";
import type { CodexModelOption } from "../../../../shared/types";
import { projectNativeModelOption } from "@/lib/native-model-option";
import {
  AgentIntelligenceDropdown,
  type AgentIntelligenceDropdownProps,
  type AgentNativeIntelligencePatch,
} from "./agent-intelligence-dropdown";

const MODELS: readonly CodexModelOption[] = [
  {
    id: "model-a",
    model: "model-a",
    displayName: "Model A",
    description: "Balanced model.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "model-b",
    model: "model-b",
    displayName: "Model B",
    description: "Focused model.",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }],
    defaultReasoningEffort: "low",
    inputModalities: ["text"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

const SELECTION = {
  kind: "codex",
  model: "model-a",
  reasoningEffort: "high",
  serviceTier: null,
} as const;

function renderSelector(overrides: Partial<AgentIntelligenceDropdownProps> = {}) {
  const props: AgentIntelligenceDropdownProps = {
    models: MODELS,
    selection: SELECTION,
    onSelectionChange: () => undefined,
    triggerStyle: "settings",
    ...overrides,
  };
  return renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown {...props} />
    </NodexTooltipProvider>,
  );
}

const click = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

const press = async (element: HTMLElement, key: string) =>
  act(async () => {
    fireEvent.keyDown(element, { key });
    await Promise.resolve();
  });

async function openSelector(view: ReturnType<typeof renderSelector>) {
  await click(view.getByRole("button", { name: "Agent intelligence" }));
  await view.findByRole("listbox");
}

const claudeProvider = (
  nativeIntelligence: NonNullable<AgentIntelligenceDropdownProps["provider"]>["nativeIntelligence"],
) => ({ label: "Claude", selection: "claude:work", nativeIntelligence });

describe("Codex models from a plain list", () => {
  test("keeps inheritance explicit and delegates clearing to its consumer", async () => {
    const onInherit = vi.fn();
    const onSelectionChange = vi.fn();
    const view = renderSelector({
      allowInherit: true,
      inheritance: "inherited",
      selection: { ...SELECTION, serviceTier: "fast" },
      onInherit,
      onSelectionChange,
    });

    const trigger = view.getByRole("button", { name: "Agent intelligence" });
    expect(trigger.textContent).toBe("Use current/default");
    expect(trigger.hasAttribute("data-fast-mode-indicator")).toBe(false);
    await openSelector(view);
    const inherit = view.getByRole("option", { name: "Use current/default" });
    expect(inherit.getAttribute("aria-selected")).toBe("true");
    expect(view.getByRole("option", { name: "Model A" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    await click(inherit);
    expect(onInherit).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  test("falls back to an effort the next model supports", async () => {
    const onSelectionChange = vi.fn();
    const view = renderSelector({ onSelectionChange });
    await openSelector(view);

    expect(view.queryByRole("button", { name: "Refresh models" })).toBeNull();
    expect(view.queryByRole("button", { name: "Manage providers" })).toBeNull();
    await click(view.getByRole("option", { name: "Model B" }));
    expect(onSelectionChange).toHaveBeenCalledWith(
      { kind: "codex", model: "model-b", reasoningEffort: "low", serviceTier: null },
      "model",
    );
  });

  test("offers the standard Codex levels for a model the list does not describe", async () => {
    const view = renderSelector({ selection: { ...SELECTION, model: "gpt-unlisted" } });
    await openSelector(view);
    const effort = view.getByRole("slider", { name: "Effort" });
    expect(effort.getAttribute("aria-valuetext")).toBe("High");
    expect(Number(effort.getAttribute("max"))).toBeGreaterThan(1);
  });

  test("turns Fast on as the shared service tier and shows it on the trigger", async () => {
    const onSelectionChange = vi.fn();
    const view = renderSelector({
      onSelectionChange,
      selection: { ...SELECTION, serviceTier: "fast" },
    });
    const trigger = view.getByRole("button", { name: "Agent intelligence" });
    expect(trigger.getAttribute("data-fast-mode-indicator")).toBe("true");
    await openSelector(view);
    const fast = view.getByRole("button", { name: "Fast" });
    expect(fast.getAttribute("aria-pressed")).toBe("true");
    await click(fast);
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...SELECTION, serviceTier: null },
      "serviceTier",
    );
  });
});

describe("Claude models from a plain list", () => {
  test("keeps a supported effort on a model change and resets an unsupported one", async () => {
    const onSelectionChange = vi.fn();
    const selection = { ...SELECTION, kind: "claude" as const, reasoningEffort: "high" };
    const view = renderSelector({
      models: [
        projectNativeModelOption({
          value: "model-a",
          name: "Model A",
          description: null,
          reasoningEfforts: ["high", "max"],
        }),
        projectNativeModelOption({ value: "model-b", name: "Model B", description: null }),
      ],
      selection,
      onSelectionChange,
    });
    await openSelector(view);
    await click(view.getByRole("option", { name: "Model B" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      { ...selection, model: "model-b", reasoningEffort: "default" },
      "model",
    );
  });

  test("sets native effort on the slider and re-enables thinking from the Off stop", async () => {
    const change = vi.fn<(patch: AgentNativeIntelligencePatch) => Promise<void>>();
    function Selector() {
      const [thinking, setThinking] = useState(false);
      return (
        <NodexTooltipProvider delay={0}>
          <AgentIntelligenceDropdown
            models={MODELS}
            triggerStyle="settings"
            selection={{ ...SELECTION, kind: "claude" }}
            onSelectionChange={() => {}}
            provider={claudeProvider({
              selected: { thinking },
              capabilities: { disableThinking: true },
              change: async (patch) => {
                await change(patch);
                if (typeof patch.thinking === "boolean") setThinking(patch.thinking);
              },
            })}
          />
        </NodexTooltipProvider>
      );
    }
    const view = renderWithMaitai(<Selector />);
    expect(view.getByRole("button", { name: "Agent intelligence" }).textContent).toBe(
      "Model A · Off",
    );
    await openSelector(view);
    const effort = view.getByRole("slider", { name: "Effort" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Off");
    await press(effort, "End");
    await waitFor(() =>
      expect(change).toHaveBeenLastCalledWith({ effort: "high", thinking: true }),
    );
    await waitFor(() => expect(effort.getAttribute("aria-valuetext")).toBe("High"));
    await press(effort, "Home");
    await waitFor(() => expect(change).toHaveBeenLastCalledWith({ thinking: false }));
  });

  test("adaptive thinking alone does not add an Off stop", async () => {
    const change = vi.fn(async () => {});
    const view = renderSelector({
      selection: { ...SELECTION, kind: "claude" },
      provider: claudeProvider({
        selected: { thinking: true },
        capabilities: { disableThinking: false },
        change,
      }),
    });
    await openSelector(view);
    await press(view.getByRole("slider", { name: "Effort" }), "Home");
    await waitFor(() => expect(change).toHaveBeenCalledWith({ effort: "medium", thinking: true }));
    expect(change).not.toHaveBeenCalledWith({ thinking: false });
  });

  test("switches thinking as a mode for a model without effort levels", async () => {
    const change = vi.fn(async () => {});
    const model = projectNativeModelOption({ value: "haiku", name: "Haiku", description: null });
    const view = renderSelector({
      models: [model],
      selection: { ...SELECTION, kind: "claude", model: model.id },
      provider: claudeProvider({
        selected: { thinking: false },
        capabilities: { disableThinking: true },
        change,
      }),
    });
    await openSelector(view);
    expect(view.queryByRole("slider", { name: "Effort" })).toBeNull();
    await click(view.getByRole("button", { name: "Thinking" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith({ thinking: true }));
  });

  test("maps Fast to the native preference instead of the Codex service tier", async () => {
    const change = vi.fn(async () => {});
    const onSelectionChange = vi.fn();
    const view = renderSelector({
      selection: { ...SELECTION, kind: "claude" },
      onSelectionChange,
      provider: claudeProvider({
        selected: { fast: false },
        capabilities: { fastMode: true },
        change,
      }),
    });
    await openSelector(view);
    await click(view.getByRole("button", { name: "Fast" }));
    await waitFor(() => expect(change).toHaveBeenLastCalledWith({ fast: true }));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
