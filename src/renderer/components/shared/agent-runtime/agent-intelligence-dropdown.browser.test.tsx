import { act, render } from "@testing-library/react";
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

test("selects effort with the pointer after changing model in an open composer menu", async () => {
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
            selection={controller.selection}
            onSelectionChange={controller.select}
            open={controller.isOpen}
            onOpenChange={controller.setOpen}
            provider={{
              label: "Claude",
              selection: "claude",
              options: [],
              select: () => {},
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
  await act(async () => userEvent.click(view.getByRole("button", { name: "Select model" })));
  await act(async () =>
    userEvent.hover(view.getByRole("menuitem", { name: "Model Claude Opus 5" })),
  );
  const sonnet = await view.findByRole("menuitem", {
    name: /Claude Sonnet 5\.5.*claude-sonnet-5-5/u,
  });
  await act(async () => userEvent.click(sonnet));
  expect(view.getByRole("menuitem", { name: "Model Claude Opus 5" })).toBeTruthy();
  await act(async () => finishModelChange?.());
  await view.findByRole("menuitem", { name: "Model Claude Sonnet 5.5" });
  await act(async () => userEvent.keyboard("{Escape}"));
  await act(async () => userEvent.hover(view.getByRole("menuitem", { name: "Effort Medium" })));
  const low = await view.findByRole("menuitem", { name: "Low" });
  await act(async () => userEvent.click(low));
  expect(change).toHaveBeenCalledWith({ effort: "low", thinking: true });
});
