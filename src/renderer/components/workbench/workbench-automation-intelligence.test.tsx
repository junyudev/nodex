import { fireEvent, waitFor, within } from "@testing-library/react";
import { act, useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai } from "@/test/thread-maitai";
import { AutomationIntelligenceDropdown } from "./workbench-automation-intelligence";
import {
  createWorkbenchAutomationDraft,
  type WorkbenchAutomationDraft,
} from "./workbench-automation-draft";

const discovery = vi.hoisted(() =>
  vi.fn(() => ({
    options: [
      { value: "vendor-sonnet", name: "Gateway Sonnet", reasoningEfforts: ["high", "max"] },
    ],
    discovery: {
      intelligence: { model: "vendor-sonnet", effort: "high", fast: false, thinking: true },
    },
  })),
);
vi.mock("@/features/local-conversation/use-claude-model-catalog", () => ({
  useClaudeModelCatalog: discovery,
}));
vi.mock("@/lib/workbench-settings-runtime", () => ({
  readClaudeAgentSettings: async () => ({
    instances: [
      { id: "gateway", displayName: "Gateway", enabled: true },
      { id: "disabled", displayName: "Disabled profile", enabled: false },
    ],
  }),
}));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeClaudeAgentSettingsChanges: () => () => {} }),
}));

test("scheduled tasks select the exact enabled Claude profile, concrete model and advertised effort", async () => {
  const changed = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState<WorkbenchAutomationDraft>({
      ...createWorkbenchAutomationDraft(),
      projectId: "project",
      model: "gpt-model",
      reasoningEffort: "high",
      serviceTier: "fast",
      localEnvironmentConfigPath: "/workspace/codex-env.toml",
    });
    return (
      <AutomationIntelligenceDropdown
        draft={draft}
        codexModels={[]}
        disabled={false}
        onChange={(next) => {
          changed(next);
          setDraft(next);
        }}
      />
    );
  }
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <Editor />
    </NodexTooltipProvider>,
  );
  const body = within(view.container.ownerDocument.body);
  const click = async (element: HTMLElement) =>
    act(async () => {
      fireEvent.click(element);
      await Promise.resolve();
    });
  await waitFor(() => expect(discovery).toHaveBeenCalled());
  await click(view.getByRole("button", { name: "Agent intelligence" }));
  await click(await body.findByLabelText("Agent Codex"));
  await click(await body.findByRole("menuitem", { name: "Gateway" }));
  expect(body.queryByRole("menuitem", { name: "Disabled profile" })).toBeNull();
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    backendBinding: { kind: "claude", instanceConfigId: "gateway" },
    model: "default",
    reasoningEffort: "default",
    serviceTier: "",
    localEnvironmentConfigPath: "",
  });
  expect(discovery).toHaveBeenLastCalledWith({
    kind: "project",
    instanceConfigId: "gateway",
    projectId: "project",
  });
  expect(body.queryByLabelText(/Speed /u)).toBeNull();
  await click(await body.findByLabelText("Model Gateway Sonnet"));
  await click(await body.findByRole("menuitem", { name: /Gateway Sonnet\s*vendor-sonnet/u }));
  await click(await body.findByLabelText("Effort High"));
  await click(await body.findByRole("menuitem", { name: "Max" }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    backendBinding: { kind: "claude", instanceConfigId: "gateway" },
    model: "vendor-sonnet",
    reasoningEffort: "max",
    serviceTier: "",
  });
  const acceptedChanges = changed.mock.calls.length;
  await click(await body.findByLabelText("Agent Gateway"));
  await click(await body.findByRole("menuitem", { name: "Gateway" }));
  expect(changed).toHaveBeenCalledTimes(acceptedChanges);
});
