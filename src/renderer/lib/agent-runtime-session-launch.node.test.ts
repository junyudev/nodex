import { expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeRendererTransport } from "./agent-runtime-runtime";
import { launchAgentRuntimeSession } from "./agent-runtime-session-launch";

it.each([
  { driver: "claudeAgent", kind: "claude" },
  { driver: "opencode", kind: "opencode" },
])("launches with $kind when Codex is unavailable", async ({ driver, kind }) => {
  const launch = vi
    .fn()
    .mockResolvedValue({ sessionId: "draft", projectId: null, threadId: "root" });
  const transport = {
    launch,
    catalog: vi.fn().mockResolvedValue([
      { instanceId: "codex", enabled: true, installed: false, status: "error", models: [] },
      {
        instanceId: `${driver}:configured`,
        driver,
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "first-model" }, { slug: "available-model", isDefault: true }],
      },
    ]),
  } as unknown as AgentRuntimeRendererTransport;
  const onSelectionResolved = vi.fn();
  await launchAgentRuntimeSession(
    { sessionId: "draft", projectId: null, prompt: "Task", onSelectionResolved },
    transport,
  );
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      modelSelection: { instanceId: `${driver}:configured`, model: "available-model" },
    }),
  );
  expect(onSelectionResolved).toHaveBeenCalledWith(kind);
});

it("keeps an explicit Agent instance, model and options even when Codex offers the same model", async () => {
  const launch = vi
    .fn()
    .mockResolvedValue({ sessionId: "draft", projectId: null, threadId: "root" });
  const transport = {
    launch,
    catalog: vi.fn().mockResolvedValue(
      ["codex", "opencode:work"].map((instanceId) => ({
        instanceId,
        driver: instanceId === "codex" ? "codex" : "opencode",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "shared-model", isDefault: true }],
      })),
    ),
  } as unknown as AgentRuntimeRendererTransport;
  const modelSelection = {
    instanceId: "opencode:work",
    model: "shared-model",
    options: [{ id: "variant", value: "high" }],
  };
  const input = { sessionId: "draft", projectId: null, prompt: "Task", modelSelection };
  await launchAgentRuntimeSession(input, transport);
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ modelSelection }));
});

it.each(["missing-instance", "disabled-instance", "missing-model"])(
  "refuses an explicit %s without starting another Agent",
  async (caseName) => {
    const launch = vi.fn();
    const transport = {
      launch,
      catalog: vi.fn().mockResolvedValue([
        {
          instanceId: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "default", isDefault: true }],
        },
        {
          instanceId: "opencode:work",
          enabled: caseName !== "disabled-instance",
          installed: true,
          status: "ready",
          models: [{ slug: "model" }],
        },
      ]),
    } as unknown as AgentRuntimeRendererTransport;
    const input = {
      sessionId: "draft",
      projectId: null,
      prompt: "Task",
      modelSelection: {
        instanceId: caseName === "missing-instance" ? "missing" : "opencode:work",
        model: caseName === "missing-model" ? "missing" : "model",
      },
    };
    await expect(launchAgentRuntimeSession(input, transport)).rejects.toThrow(
      /selected Agent.*unavailable/i,
    );
    expect(launch).not.toHaveBeenCalled();
  },
);

it.each([
  { inputModalities: undefined, reason: /has not reported image support/ },
  { inputModalities: ["text"], reason: /does not support image attachments/ },
])(
  "rejects image launches when the selected model reports $inputModalities",
  async ({ inputModalities, reason }) => {
    const launch = vi.fn();
    const transport = {
      launch,
      catalog: vi.fn().mockResolvedValue([
        {
          instanceId: "opencode:work",
          driver: "opencode",
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "model", capabilities: { inputModalities } }],
        },
      ]),
    } as unknown as AgentRuntimeRendererTransport;
    await expect(
      launchAgentRuntimeSession(
        {
          sessionId: "draft",
          projectId: null,
          prompt: "Read this",
          promptInput: {
            text: "Read this",
            images: [{ source: "data:image/png;base64,aW1hZ2U=" }],
          },
        },
        transport,
      ),
    ).rejects.toThrow(reason);
    expect(launch).not.toHaveBeenCalled();
  },
);

it("keeps image attachments on a launch whose exact model supports images", async () => {
  const launch = vi.fn();
  const transport = {
    launch,
    catalog: vi.fn().mockResolvedValue([
      {
        instanceId: "opencode:work",
        driver: "opencode",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "model", capabilities: { inputModalities: ["text", "image"] } }],
      },
    ]),
  } as unknown as AgentRuntimeRendererTransport;
  const images = [{ source: "data:image/png;base64,aW1hZ2U=" }];
  await launchAgentRuntimeSession(
    {
      sessionId: "draft",
      projectId: null,
      prompt: "Read this",
      promptInput: { text: "Read this", images },
    },
    transport,
  );
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.objectContaining({ images }) }),
  );
});

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
        models: [
          { slug: "default-model", isDefault: true },
          {
            slug: "explicit-model",
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
