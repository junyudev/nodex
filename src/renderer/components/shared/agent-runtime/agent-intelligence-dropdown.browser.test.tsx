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
        provider: { kind: "claude", selection: "claude" },
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
            agent={{ binding: { kind: "claude", instanceConfigId: "claude" }, label: "Claude" }}
            selection={controller.selection}
            onSelectionChange={controller.select}
            open={controller.isOpen}
            onOpenChange={controller.setOpen}
            provider={{
              label: "Claude",
              selection: "claude",
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
  await act(async () =>
    userEvent.click(await view.findByRole("option", { name: "Claude Sonnet 5.5" })),
  );
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
