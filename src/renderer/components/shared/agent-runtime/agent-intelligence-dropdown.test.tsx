import { fireEvent, within } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai } from "@/test/thread-maitai";
import type { CodexModelOption } from "../../../../shared/types";
import { projectNativeModelOption } from "@/lib/native-model-option";
import { AgentIntelligenceDropdown } from "./agent-intelligence-dropdown";

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

function renderSelector(overrides: Partial<Parameters<typeof AgentIntelligenceDropdown>[0]> = {}) {
  const props: Parameters<typeof AgentIntelligenceDropdown>[0] = {
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

async function openSelector(view: ReturnType<typeof renderSelector>) {
  await act(async () => {
    const trigger = view.getByRole("button", { name: "Agent intelligence" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await Promise.resolve();
  });
}

describe("shared Codex intelligence dropdown", () => {
  test("keeps inheritance explicit and delegates clearing to its consumer", async () => {
    const onInherit = vi.fn();
    const view = renderSelector({ allowInherit: true, inheritance: "inherited", onInherit });

    expect(view.getByText("Use current/default")).toBeTruthy();
    await openSelector(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Use current/default" }));
      await Promise.resolve();
    });
    expect(onInherit).toHaveBeenCalledTimes(1);
  });

  test("reuses the native Composer model fallback behavior", async () => {
    const onSelectionChange = vi.fn();
    const view = renderSelector({ onSelectionChange });
    await openSelector(view);

    expect(view.queryByLabelText(/Provider/u)).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByLabelText("Model Model A"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(view.container.ownerDocument.body).getByText("Model B"));
      await Promise.resolve();
    });
    expect(onSelectionChange).toHaveBeenCalledWith(
      {
        kind: "codex",
        model: "model-b",
        reasoningEffort: "low",
        serviceTier: null,
      },
      "model",
    );
  });

  test("emits the same Standard and Fast service-tier values as Composer", async () => {
    const onSelectionChange = vi.fn();
    const view = renderSelector({ onSelectionChange });
    await openSelector(view);

    await act(async () => {
      fireEvent.click(view.getByLabelText("Speed Standard"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(view.container.ownerDocument.body).getByText("Fast"));
      await Promise.resolve();
    });
    expect(onSelectionChange).toHaveBeenCalledWith(
      { ...SELECTION, serviceTier: "fast" },
      "serviceTier",
    );
  });
});

test("shows and selects the concrete Claude model ID in the shared picker", async () => {
  const onSelectionChange = vi.fn();
  const model = projectNativeModelOption({
    value: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: null,
  });
  const view = renderSelector({
    models: [model],
    selection: { ...SELECTION, kind: "claude", model: model.id },
    onSelectionChange,
  });
  await openSelector(view);
  await act(async () => {
    fireEvent.click(view.getByLabelText("Model Claude Sonnet 5"));
  });
  const row = await within(view.container.ownerDocument.body).findByRole("menuitem", {
    name: /Claude Sonnet 5\s*claude-sonnet-5/u,
  });
  await act(async () => {
    fireEvent.click(row);
  });
  expect(onSelectionChange).toHaveBeenCalledWith(
    { ...SELECTION, kind: "claude", model: "claude-sonnet-5", reasoningEffort: "default" },
    "model",
  );
});

test("selects native Claude effort levels and resets them for an unsupported model", async () => {
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
  await act(async () => {
    fireEvent.click(view.getByLabelText("Effort High"));
  });
  const body = within(view.container.ownerDocument.body);
  const max = await body.findByRole("menuitem", { name: "Max" });
  expect(body.queryByRole("menuitem", { name: "Medium" })).toBeNull();
  await act(async () => {
    fireEvent.click(max);
  });
  expect(onSelectionChange).toHaveBeenLastCalledWith(
    { ...selection, reasoningEffort: "max" },
    "reasoningEffort",
  );
  await act(async () => {
    fireEvent.click(view.getByLabelText("Model Model A"));
  });
  const nextModel = await body.findByRole("menuitem", { name: /Model B/u });
  await act(async () => {
    fireEvent.click(nextModel);
  });
  expect(onSelectionChange).toHaveBeenLastCalledWith(
    { ...selection, model: "model-b", reasoningEffort: "default" },
    "model",
  );
});

test("shows actual native Fast state and selects explicit On without an inheritance option", async () => {
  const change = vi.fn(async () => {});
  const onSelectionChange = vi.fn();
  const view = renderSelector({
    selection: { ...SELECTION, kind: "claude" },
    onSelectionChange,
    provider: {
      label: "Claude",
      selection: "claude:work",
      options: [],
      select: () => {},
      nativeIntelligence: {
        selected: { fast: false, context: "200k" },
        capabilities: { fastMode: true, contextWindows: ["200k", "1m"] },
        change,
      },
    },
  });
  await openSelector(view);
  expect(view.queryByLabelText(/Thinking/u)).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByLabelText("Fast Off"));
  });
  await act(async () => {
    fireEvent.click(await within(document.body).findByRole("menuitem", { name: "On" }));
  });
  expect(change).toHaveBeenLastCalledWith({ fast: true });
  expect(onSelectionChange).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(view.getByLabelText("Context 200k"));
  });
  await act(async () => {
    fireEvent.click(await within(document.body).findByRole("menuitem", { name: "1m" }));
  });
  expect(change).toHaveBeenLastCalledWith({ context: "1m" });
});

test("puts thinking Off in Effort and reenables thinking even when selecting the same effort", async () => {
  const change = vi.fn(async () => {});
  const view = renderSelector({
    selection: { ...SELECTION, kind: "claude" },
    provider: {
      label: "Claude",
      selection: "claude:work",
      options: [],
      select: () => {},
      nativeIntelligence: {
        selected: { thinking: false },
        capabilities: { disableThinking: true },
        change,
      },
    },
  });
  await openSelector(view);
  await act(async () => {
    fireEvent.click(view.getByLabelText("Effort Off"));
  });
  const body = within(document.body);
  await act(async () => {
    fireEvent.click(await body.findByRole("menuitem", { name: "High" }));
  });
  expect(change).toHaveBeenLastCalledWith({ effort: "high", thinking: true });
  await act(async () => {
    fireEvent.click(await body.findByRole("menuitem", { name: "Off" }));
  });
  expect(change).toHaveBeenLastCalledWith({ thinking: false });
});

test("adaptive thinking alone does not advertise a thinking Off choice", async () => {
  const view = renderSelector({
    selection: { ...SELECTION, kind: "claude" },
    provider: {
      label: "Claude",
      selection: "claude:work",
      options: [],
      select: () => {},
      nativeIntelligence: {
        selected: { thinking: true },
        capabilities: { disableThinking: false },
        change: async () => {},
      },
    },
  });
  await openSelector(view);
  await act(async () => {
    fireEvent.click(view.getByLabelText("Effort High"));
  });
  const body = within(document.body);
  await body.findByRole("menuitem", { name: "Medium" });
  expect(body.queryByRole("menuitem", { name: "Off" })).toBeNull();
});

test("supports reversible thinking for native models without effort levels", async () => {
  const change = vi.fn(async () => {});
  const model = projectNativeModelOption({ value: "haiku", name: "Haiku", description: null });
  const view = renderSelector({
    models: [model],
    selection: { ...SELECTION, kind: "claude", model: model.id },
    provider: {
      label: "Claude",
      selection: "claude:work",
      options: [],
      select: () => {},
      nativeIntelligence: {
        selected: { thinking: false },
        capabilities: { disableThinking: true },
        change,
      },
    },
  });
  await openSelector(view);
  await act(async () => {
    fireEvent.click(view.getByLabelText("Effort Off"));
  });
  await act(async () => {
    fireEvent.click(await within(document.body).findByRole("menuitem", { name: "On" }));
  });
  expect(change).toHaveBeenCalledWith({ thinking: true });
});
