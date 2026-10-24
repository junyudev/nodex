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
vi.mock("@/features/local-conversation/use-agent-instances", () => ({
  useAgentInstances: () => ({
    loading: false,
    error: null,
    refresh: () => {},
    instances: [
      { binding: { kind: "claude", instanceConfigId: "gateway" }, label: "Gateway", enabled: true },
      {
        binding: { kind: "claude", instanceConfigId: "disabled" },
        label: "Disabled profile",
        enabled: false,
      },
      { binding: { kind: "opencode", instanceConfigId: "open" }, label: "OpenCode", enabled: true },
      {
        binding: { kind: "acp", agentDefinitionId: "scripted-agent", instanceConfigId: "acp-work" },
        label: "ACP work",
        enabled: true,
      },
    ],
  }),
}));
const acpModels = vi.hoisted(() =>
  vi.fn((binding: { kind: string }) =>
    binding.kind === "acp"
      ? {
          loading: false,
          discovered: true,
          models: [
            {
              id: "scripted-fast",
              model: "scripted-fast",
              displayName: "scripted-fast",
              description: "",
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "default",
              inputModalities: [],
              isDefault: false,
            },
            {
              id: "scripted-deep",
              model: "scripted-deep",
              displayName: "scripted-deep",
              description: "",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Low" },
                { reasoningEffort: "high", description: "High" },
              ],
              defaultReasoningEffort: "low",
              inputModalities: [],
              isDefault: false,
            },
          ],
        }
      : { loading: false, discovered: false, models: [] },
  ),
);
vi.mock("@/features/acp-agents/use-acp-automation-models", () => ({
  useAcpAutomationModels: acpModels,
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

test("scheduled tasks can run an ACP instance with its exact advertised model and options", async () => {
  const changed = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState<WorkbenchAutomationDraft>({
      ...createWorkbenchAutomationDraft(),
      projectId: "project",
      model: "gpt-model",
      reasoningEffort: "high",
      serviceTier: "fast",
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
  await click(view.getByRole("button", { name: "Agent intelligence" }));
  await click(await body.findByLabelText("Agent Codex"));
  // OpenCode isn't scheduled here; enabled Claude profiles and ACP instances are.
  expect(body.queryByRole("menuitem", { name: "OpenCode" })).toBeNull();
  await click(await body.findByRole("menuitem", { name: "ACP work" }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    backendBinding: {
      kind: "acp",
      agentDefinitionId: "scripted-agent",
      instanceConfigId: "acp-work",
    },
    model: "",
    reasoningEffort: "",
    serviceTier: "",
  });
  await click(await body.findByLabelText("Model Default model"));
  await click(await body.findByRole("menuitem", { name: /scripted.deep/iu }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    model: "scripted-deep",
    reasoningEffort: "low",
  });
  await click(await body.findByLabelText(/^Model /u));
  await click(await body.findByRole("menuitem", { name: /scripted.fast/iu }));
  // A model without effort options sends none rather than a value the Agent never offered.
  expect(changed.mock.lastCall?.[0]).toMatchObject({ model: "scripted-fast", reasoningEffort: "" });
});
