import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../../globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { projectNativeModelOption } from "@/lib/native-model-option";
import {
  AgentIntelligenceDropdown,
  type AgentIntelligenceSelection,
} from "./agent-intelligence-dropdown";
import { CodexServiceTierSettingsProvider } from "@/lib/use-codex-service-tier-settings";
import { useComposerIntelligenceController } from "@/features/local-conversation/view/composer/use-composer-intelligence-controller";
import type {
  ThreadFooterModel,
  ThreadStageActions,
} from "@/features/local-conversation/thread-stage-types";

const models = [
  projectNativeModelOption({
    value: "claude-opus-5",
    name: "Claude Opus 5",
    description: null,
    reasoningEfforts: ["low", "medium", "high", "max"],
  }),
  projectNativeModelOption({
    value: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    description: null,
    reasoningEfforts: ["low", "medium", "high"],
  }),
];

test("selects effort with the pointer after a model change commits", async () => {
  const change = vi.fn(async () => {});
  let finishModelChange: (() => void) | null = null;
  function Probe() {
    const [committed, setCommitted] = useState({ model: "claude-opus-5", fastMode: true });
    const controller = useComposerIntelligenceController(
      {
        selectedModel: committed.model,
        selectedReasoningEffort: "medium",
        availableModels: models,
        provider: { kind: "claudeAgent", selection: "claudeAgent" },
      } as ThreadFooterModel,
      {
        onIntelligenceSelectionChange: (selection: AgentIntelligenceSelection) =>
          new Promise<void>((resolve) => {
            finishModelChange = () => {
              setCommitted({ model: selection.model, fastMode: false });
              resolve();
            };
          }),
      } as unknown as ThreadStageActions,
    );
    return (
      <NodexTooltipProvider>
        <div style={{ position: "fixed", bottom: 100, right: 200 }}>
          <AgentIntelligenceDropdown
            models={models}
            agent={{ binding: { driver: "claudeAgent", instanceId: "claude" }, label: "Claude" }}
            selection={controller.selection}
            onSelectionChange={controller.select}
            open={controller.isOpen}
            onOpenChange={controller.setOpen}
            provider={{
              label: "Claude",
              selection: "claudeAgent",
              nativeIntelligence: {
                selected: { thinking: true, fast: false },
                capabilities: { fastMode: committed.fastMode },
                change,
              },
            }}
          />
        </div>
      </NodexTooltipProvider>
    );
  }
  const view = render(
    <CodexServiceTierSettingsProvider>
      <Probe />
    </CodexServiceTierSettingsProvider>,
  );
  const trigger = view.getByRole("button", { name: "Select model" });
  await act(async () => userEvent.click(trigger));
  const nextModel = await view.findByRole("option", { name: "Claude Sonnet 5.5" });
  await act(async () => userEvent.click(nextModel));
  await waitFor(() => expect(view.queryByRole("listbox")).toBeNull());
  // The chat keeps its committed model until the change lands.
  expect(trigger.textContent).toContain("Claude Opus 5");
  await act(async () => finishModelChange?.());
  await waitFor(() => expect(trigger.textContent).toContain("Claude Sonnet 5.5"));

  await act(async () => userEvent.click(trigger));
  const effort = await view.findByRole("slider", { name: "Effort" });
  expect(effort.getAttribute("aria-valuetext")).toBe("Medium");
  expect(view.queryByRole("button", { name: "Fast" })).toBeNull();
  const track = effort.closest<HTMLElement>('[data-slot="slider"]');
  if (!track) throw new Error("Expected the effort track");
  const { height } = track.getBoundingClientRect();
  await act(async () => userEvent.click(track, { position: { x: 1, y: height / 2 } }));
  await waitFor(() => expect(change).toHaveBeenCalledWith({ effort: "low", thinking: true }));
});

test("opens the model menu without widening the button, aligned to its trailing edge", async () => {
  function Probe() {
    const [open, setOpen] = useState(false);
    const [selection, setSelection] = useState<AgentIntelligenceSelection>({
      kind: "claudeAgent",
      model: "claude-opus-5",
      reasoningEffort: "medium",
      serviceTier: null,
    });
    return (
      <NodexTooltipProvider>
        {/* The trailing edge has room on its left for the whole menu, as in the Composer. */}
        <div style={{ position: "fixed", bottom: 100, right: 16 }}>
          <AgentIntelligenceDropdown
            models={models}
            agent={{ binding: { driver: "claudeAgent", instanceId: "claude" }, label: "Claude" }}
            selection={selection}
            onSelectionChange={setSelection}
            open={open}
            onOpenChange={setOpen}
            provider={{ label: "Claude", selection: "claudeAgent" }}
          />
        </div>
      </NodexTooltipProvider>
    );
  }
  const view = render(
    <CodexServiceTierSettingsProvider>
      <Probe />
    </CodexServiceTierSettingsProvider>,
  );
  const trigger = view.getByRole("button", { name: "Select model" });
  const closed = trigger.getBoundingClientRect();

  await act(async () => userEvent.click(trigger));
  await view.findByRole("listbox");

  await waitFor(() => {
    const menu = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    if (!menu) throw new Error("Expected the model menu.");
    const opened = trigger.getBoundingClientRect();
    expect(opened.width).toBeCloseTo(closed.width, 1);
    expect(opened.left).toBeCloseTo(closed.left, 1);
    expect(menu.getBoundingClientRect().right).toBeCloseTo(opened.right, 0);
  });
});

test("hovering the speed button lists the model's tiers and picks one inside the open picker", async () => {
  const sol = {
    ...projectNativeModelOption({
      value: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      description: null,
      reasoningEfforts: ["low", "medium", "high"],
    }),
    serviceTiers: [
      { id: "priority", name: "Fast", description: "2x speed, increased usage" },
      { id: "ultrafast", name: "Ultrafast", description: "Even faster, more expensive" },
    ],
  };
  function Probe() {
    const [open, setOpen] = useState(false);
    const [selection, setSelection] = useState<AgentIntelligenceSelection>({
      kind: "codex",
      model: sol.id,
      reasoningEffort: "medium",
      serviceTier: null,
    });
    return (
      <NodexTooltipProvider>
        <div style={{ position: "fixed", bottom: 100, right: 16 }}>
          <AgentIntelligenceDropdown
            models={[sol]}
            selection={selection}
            onSelectionChange={setSelection}
            open={open}
            onOpenChange={setOpen}
          />
        </div>
      </NodexTooltipProvider>
    );
  }
  const view = render(
    <CodexServiceTierSettingsProvider>
      <Probe />
    </CodexServiceTierSettingsProvider>,
  );
  const trigger = view.getByRole("button", { name: "Select model" });
  await act(async () => userEvent.click(trigger));
  const speed = await view.findByRole("button", { name: "Speed" });
  expect(speed.getAttribute("aria-description")).toBe("Standard");

  await act(async () => userEvent.hover(speed));
  const ultrafast = await view.findByRole("menuitemradio", { name: /^Ultrafast/ });
  await act(async () => userEvent.click(ultrafast));

  await waitFor(() => expect(speed.getAttribute("aria-description")).toBe("Ultrafast"));
  // Choosing a speed keeps the picker open around it.
  expect(view.getByRole("listbox")).toBeTruthy();
  expect(trigger.querySelector("[data-ultrafast-mode-indicator]")).not.toBeNull();
});
