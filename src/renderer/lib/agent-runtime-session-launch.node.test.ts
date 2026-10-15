import { expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeRendererTransport } from "./agent-runtime-runtime";
import { launchAgentRuntimeSession } from "./agent-runtime-session-launch";

it("preserves the first submission and NFM sidecar while compiling programmatic Session launches", async () => {
  const launch = vi
    .fn()
    .mockResolvedValue({ sessionId: "draft", projectId: "project", threadId: "runtime-root" });
  const transport = {
    launch,
    catalog: vi.fn().mockResolvedValue([
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "default-model", isDefault: true }],
      },
    ]),
  } as unknown as AgentRuntimeRendererTransport;
  const agentConfigs = [
    { mode: "plan", provider: "openai", model: "explicit-model", reasoning: "high", speed: "fast" },
  ];
  const identity = {
    launchId: "launch:stable",
    messageId: "message:stable",
    acceptedAt: 1791993600000,
  };
  const input = {
    sessionId: "draft",
    projectId: "project",
    prompt: "Fallback",
    promptInput: { text: "Compiled task", agentConfigs },
    launchIdentity: identity,
  };
  await launchAgentRuntimeSession(input, transport);
  await launchAgentRuntimeSession(input, transport);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls[0]![0]).toEqual(launch.mock.calls[1]![0]);
  expect(launch.mock.calls[0]![0]).toMatchObject({
    sessionId: "draft",
    launchId: identity.launchId,
    acceptedAt: identity.acceptedAt,
    modelSelection: { instanceId: "codex", model: "default-model" },
    message: { messageId: identity.messageId, text: "Compiled task", agentConfigs },
  });
});

it("submits the selected model, effort, speed, planning mode and workspace through one Session launch", async () => {
  const launch = vi
    .fn()
    .mockResolvedValue({ sessionId: "draft", projectId: "project", threadId: "root" });
  const transport = {
    launch,
    catalog: vi.fn().mockResolvedValue([
      {
        instanceId: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          { slug: "default", isDefault: true },
          {
            slug: "selected",
            capabilities: {
              optionDescriptors: [
                { id: "reasoningEffort", type: "select", options: [{ id: "high" }] },
                { id: "serviceTier", type: "select", options: [{ id: "fast" }] },
              ],
            },
          },
        ],
      },
    ]),
  } as unknown as AgentRuntimeRendererTransport;
  await launchAgentRuntimeSession(
    {
      sessionId: "draft",
      projectId: "project",
      prompt: "Task",
      title: "Page section",
      codexDefaults: { model: "selected", reasoningEffort: "high", serviceTier: "fast" },
      interactionMode: "plan",
      runInTarget: "newWorktree",
      runInEnvironmentPath: "env/config",
      worktreeStartingState: { type: "working-tree" },
      presentationTicket: { ticketId: "018f0097-a39b-7000-8000-000000000000" },
    },
    transport,
  );
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Page section",
      modelSelection: {
        instanceId: "codex",
        model: "selected",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      },
      interactionMode: "plan",
      runInTarget: "newWorktree",
      runInEnvironmentPath: "env/config",
      worktreeStartingState: { type: "working-tree" },
      presentationTicket: { ticketId: "018f0097-a39b-7000-8000-000000000000" },
    }),
  );
});
