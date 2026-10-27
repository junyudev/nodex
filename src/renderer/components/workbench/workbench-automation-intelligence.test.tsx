import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai } from "@/test/thread-maitai";
import {
  AutomationAgentDropdown,
  AutomationModelPicker,
  useAutomationAgent,
} from "./workbench-automation-intelligence";
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

function AgentAndModel({
  draft,
  onChange,
}: {
  readonly draft: WorkbenchAutomationDraft;
  readonly onChange: (draft: WorkbenchAutomationDraft) => void;
}) {
  const agent = useAutomationAgent({ draft, codexModels: [], onChange });
  return (
    <>
      <AutomationAgentDropdown agent={agent} disabled={false} />
      {draft.kind === "cron" ? (
        <AutomationModelPicker
          agent={agent}
          draft={draft}
          codexModels={[]}
          disabled={false}
          onChange={onChange}
        />
      ) : null}
    </>
  );
}

function renderEditor(initial: WorkbenchAutomationDraft) {
  const changed = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(initial);
    return (
      <AgentAndModel
        draft={draft}
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
  return { view, changed };
}

const click = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

test("scheduled tasks select the exact enabled Claude profile, concrete model and advertised effort", async () => {
  const { view, changed } = renderEditor({
    ...createWorkbenchAutomationDraft(),
    projectId: "project",
    model: "gpt-model",
    reasoningEffort: "high",
    serviceTier: "fast",
    localEnvironmentConfigPath: "/workspace/codex-env.toml",
  });
  await click(view.getByRole("button", { name: "Scheduled agent" }));
  expect(view.queryByRole("menuitem", { name: "Disabled profile" })).toBeNull();
  await click(await view.findByRole("menuitem", { name: "Gateway" }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    backendBinding: { kind: "claude", instanceConfigId: "gateway" },
    model: "default",
    reasoningEffort: "default",
    serviceTier: "",
    localEnvironmentConfigPath: "",
  });
  await waitFor(() =>
    expect(discovery).toHaveBeenLastCalledWith({
      kind: "project",
      instanceConfigId: "gateway",
      projectId: "project",
    }),
  );
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Scheduled agent" }).textContent).toBe("Gateway"),
  );

  await click(view.getByRole("button", { name: "Agent intelligence" }));
  expect(view.queryByRole("button", { name: "Fast" })).toBeNull();
  await click(await view.findByRole("option", { name: /Gateway Sonnet/u }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    model: "vendor-sonnet",
    reasoningEffort: "high",
  });
  await click(view.getByRole("button", { name: "Agent intelligence" }));
  const effort = await view.findByRole("slider", { name: "Effort" });
  expect(effort.getAttribute("aria-valuetext")).toBe("High");
  await act(async () => {
    fireEvent.keyDown(effort, { key: "ArrowRight" });
    await Promise.resolve();
  });
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    backendBinding: { kind: "claude", instanceConfigId: "gateway" },
    model: "vendor-sonnet",
    reasoningEffort: "max",
    serviceTier: "",
  });
  await act(async () => {
    fireEvent.keyDown(effort, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("listbox")).toBeNull());

  const acceptedChanges = changed.mock.calls.length;
  await click(view.getByRole("button", { name: "Scheduled agent" }));
  await click(await view.findByRole("menuitem", { name: "Gateway" }));
  expect(changed).toHaveBeenCalledTimes(acceptedChanges);
});

test("scheduled tasks can run an ACP instance with its exact advertised model and options", async () => {
  const { view, changed } = renderEditor({
    ...createWorkbenchAutomationDraft(),
    projectId: "project",
    model: "gpt-model",
    reasoningEffort: "high",
    serviceTier: "fast",
  });
  await click(view.getByRole("button", { name: "Scheduled agent" }));
  // OpenCode isn't scheduled here; enabled Claude profiles and ACP instances are.
  expect(view.queryByRole("menuitem", { name: "OpenCode" })).toBeNull();
  await click(await view.findByRole("menuitem", { name: "ACP work" }));
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
  const trigger = view.getByRole("button", { name: "Agent intelligence" });
  await click(trigger);
  await click(await view.findByRole("option", { name: /scripted.deep/iu }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    model: "scripted-deep",
    reasoningEffort: "low",
  });

  // The model's advertised effort levels stay choosable.
  await click(trigger);
  const effort = await view.findByRole("button", { name: "Effort Light" });
  await act(async () => {
    fireEvent.pointerDown(effort, { button: 0, ctrlKey: false });
    fireEvent.click(effort);
    await Promise.resolve();
  });
  await click(await view.findByRole("menuitem", { name: "High" }));
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    model: "scripted-deep",
    reasoningEffort: "high",
  });

  await click(await view.findByRole("option", { name: /scripted.fast/iu }));
  // A model without effort options sends none rather than a value the Agent never offered.
  expect(changed.mock.lastCall?.[0]).toMatchObject({ model: "scripted-fast", reasoningEffort: "" });
});

test("a task that continues one chat chooses its Agent alone", async () => {
  const { view } = renderEditor({ ...createWorkbenchAutomationDraft(), kind: "heartbeat" });
  expect(view.getByRole("button", { name: "Scheduled agent" }).textContent).toBe("Codex");
  expect(view.queryByRole("button", { name: "Agent intelligence" })).toBeNull();
});
