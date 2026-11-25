import { describe, expect, test, it, vi, afterEach, beforeEach } from "vite-plus/test";
import {
  initialAgentApprovalTypingGuard,
  reduceAgentApprovalTypingGuard as reduce,
} from "./agent-approval-typing-guard";
import {
  isAgentRuntimeModeSupported,
  requiresFullAccessConfirmation,
  resolveAgentRuntimeMode,
} from "./agent-runtime-mode";
import {
  agentRuntimeImageInputSupport,
  agentRuntimePromptImages,
  prepareAgentRuntimeMessage,
} from "./agent-runtime-prompt";
import type { CodexPromptInput } from "../../shared/types";
import type { CodexUntrustedAppMessage } from "../../shared/codex-untrusted-app-input";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
  AgentRuntimeSessionActivitySnapshot,
} from "../../shared/agent-runtime-api";
import { createAgentRuntimeActivityStore } from "./agent-runtime-session-activity";
import type { AgentRuntimeRendererTransport } from "./agent-runtime-runtime";
import { launchAgentRuntimeSession } from "./agent-runtime-session-launch";
import {
  DEFAULT_MODEL_POLICY,
  projectModelPolicyCatalog,
  setModelOn,
} from "../../shared/model-policy";
import { providerKeyRuntimeInstanceId } from "../../shared/provider-keys";
import { agentRuntimeProviderFixture } from "../../shared/testing/agent-runtime-snapshot";
import { agentTeammate, newChatAgentTeam } from "./agent-team";
import {
  canExecuteContextualKeyboardAction,
  executeContextualKeyboardAction,
  markContextualKeyboardActionPresentationActive,
  markContextualKeyboardActionTargetActive,
  registerContextualKeyboardActionTarget,
  resetContextualKeyboardActionRegistryForTests,
  unregisterContextualKeyboardActionTarget,
} from "./contextual-keyboard-actions";

describe("approval typing guard", () => {
  test.each([1499, 1500, 1501])(
    "holds only arrivals before the 1500 ms idle boundary: %s",
    (elapsed) => {
      let state = reduce(initialAgentApprovalTypingGuard(), { type: "focus" });
      state = reduce(state, { type: "type", now: 100 });
      state = reduce(state, { type: "requests", ids: ["a"], now: 100 + elapsed });
      expect(state.held.has("a")).toBe(elapsed < 1500);
      expect(state.seen.has("a")).toBe(true);
    },
  );
  test("never holds an existing request again and drops removed held requests", () => {
    let state = reduce(initialAgentApprovalTypingGuard(), {
      type: "requests",
      ids: ["old"],
      now: 0,
    });
    state = reduce(reduce(state, { type: "focus" }), { type: "type", now: 10 });
    state = reduce(state, { type: "requests", ids: ["old", "new"], now: 11 });
    expect([...state.held]).toEqual(["new"]);
    state = reduce(state, { type: "requests", ids: ["old"], now: 12 });
    expect(state.held.size).toBe(0);
    expect([...reduce(state, { type: "requests", ids: ["new"], now: 13 }).held]).toEqual([]);
  });
  test.each(["blur", "send", "idle"] as const)("%s releases holds and resets typing", (type) => {
    let state = reduce(initialAgentApprovalTypingGuard(), { type: "focus" });
    state = reduce(state, { type: "type", now: 100 });
    state = reduce(state, { type: "requests", ids: ["a"], now: 101 });
    state = reduce(state, { type });
    expect(state.held.size).toBe(0);
    expect(state.lastTypedAt).toBe(-Infinity);
    expect(state.focused).toBe(type !== "blur");
  });
  test("unfocused typing never holds a new request", () => {
    const state = reduce(initialAgentApprovalTypingGuard(), { type: "type", now: 100 });
    expect(reduce(state, { type: "requests", ids: ["a"], now: 101 }).held.size).toBe(0);
  });
});

describe("permission modes", () => {
  test("treats a missing or empty list as every mode", () => {
    expect(isAgentRuntimeModeSupported("auto", undefined)).toBe(true);
    expect(isAgentRuntimeModeSupported("auto", [])).toBe(true);
    expect(isAgentRuntimeModeSupported("auto", ["approval-required", "full-access"])).toBe(false);
    expect(resolveAgentRuntimeMode("auto")).toBe("auto");
    expect(resolveAgentRuntimeMode("full-access", [])).toBe("full-access");
  });

  test("resolves to the broadest supported mode at or below the selected mode", () => {
    const supported = ["approval-required", "full-access"] as const;
    expect(resolveAgentRuntimeMode("auto", supported)).toBe("approval-required");
    expect(resolveAgentRuntimeMode("full-access", supported)).toBe("full-access");
    expect(resolveAgentRuntimeMode("full-access", ["approval-required", "auto"])).toBe("auto");
    expect(resolveAgentRuntimeMode("approval-required", ["full-access"])).toBe("approval-required");
  });

  test("confirms only a step up to Full access", () => {
    expect(requiresFullAccessConfirmation("approval-required", "full-access")).toBe(true);
    expect(requiresFullAccessConfirmation("full-access", "full-access")).toBe(false);
    expect(requiresFullAccessConfirmation("full-access", "auto")).toBe(false);
  });
});

describe("agent runtime prompt", () => {
  const image = "data:image/png;base64,aW1hZ2U=";
  const model = (inputModalities?: ("text" | "image")[]) => ({
    slug: "model",
    name: "Model",
    isCustom: false,
    capabilities: { optionDescriptors: [], ...(inputModalities ? { inputModalities } : {}) },
  });
  const imageInputs: {
    name: string;
    promptInput?: CodexPromptInput;
    untrustedAppMessage?: CodexUntrustedAppMessage;
  }[] = [
    { name: "attached image", promptInput: { text: "Look", images: [{ source: image }] } },
    {
      name: "appshot",
      promptInput: {
        text: "Look",
        appshots: [
          {
            id: "shot",
            appName: "Example",
            bundleIdentifier: "example",
            windowTitle: null,
            axTree: "",
            imageName: "Window",
            imageDataUrl: image,
            appIconDataUrl: null,
          },
        ],
      },
    },
    {
      name: "application context",
      promptInput: {
        text: "Look",
        mcpAppModelContextAttachments: [
          {
            id: "context",
            title: "Preview",
            untrusted: true,
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ],
      },
    },
    {
      name: "application message",
      untrustedAppMessage: {
        source: "visualization",
        sourceId: "preview",
        text: "Look",
        imageUrls: [image],
      },
    },
  ];

  describe("Runtime visual input admission", () => {
    it.each(["structured", "raw", "editor-text", "document-items"])(
      "validates the effective %s Agent config model before completing preparation",
      async (source) => {
        const textModel = { ...model(["text"]), slug: "text" };
        const visionModel = { ...model(["text", "image"]), slug: "vision" };
        const provider = {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          version: "test",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-22T00:00:00.000Z",
          slashCommands: [],
          skills: [],
          models: [textModel, visionModel],
        } satisfies AgentRuntimeOperations["providers.read"]["output"][number];
        const prepare = (from: typeof textModel, to: string) => {
          const text = source === "structured" ? "Look" : `Look\n:agent-config{model="${to}"}`;
          const input = {
            model: from,
            provider,
            modelSelection: { instanceId: "codex", model: from.slug },
            kind: "codex" as const,
            text,
            ...(source === "structured"
              ? {
                  promptInput: { text, images: [{ source: image }], agentConfigs: [{ model: to }] },
                }
              : source === "document-items"
                ? {
                    promptInput: {
                      text: "Look",
                      documentItems: [{ type: "text" as const, text }],
                      images: [{ source: image }],
                    },
                  }
                : source === "editor-text"
                  ? { promptInput: { text, images: [{ source: image }] } }
                  : {
                      untrustedAppMessage: {
                        source: "visualization" as const,
                        sourceId: "view",
                        text: "Image",
                        imageUrls: [image],
                      },
                    }),
          };
          return prepareAgentRuntimeMessage(input, vi.fn());
        };
        await expect(prepare(textModel, "vision")).resolves.toHaveProperty("text");
        await expect(prepare(visionModel, "text")).rejects.toThrow("does not support image");
      },
    );
    it("keeps an explicit empty editor config list authoritative", async () => {
      const text = 'Look\n\n:agent-config{model="text"}';
      await expect(
        prepareAgentRuntimeMessage(
          {
            model: model(["text", "image"]),
            kind: "codex",
            text,
            promptInput: { text, images: [{ source: image }], agentConfigs: [] },
          },
          vi.fn(),
        ),
      ).resolves.toEqual({ text });
    });
    it("distinguishes explicit text-only from unreported capability", () => {
      expect(agentRuntimeImageInputSupport(undefined)).toBe("unknown");
      expect(agentRuntimeImageInputSupport(model())).toBe("unknown");
      expect(agentRuntimeImageInputSupport(model(["text"]))).toBe("unsupported");
      expect(agentRuntimeImageInputSupport(model(["text", "image"]))).toBe("supported");
    });

    it.each(imageInputs)(
      "checks $name before preparing a message",
      async ({ promptInput, untrustedAppMessage }) => {
        const read = vi.fn();
        const input = { kind: "opencode" as const, text: "Look", promptInput, untrustedAppMessage };
        await expect(
          prepareAgentRuntimeMessage({ ...input, model: model(["text"]) }, read),
        ).rejects.toThrow("does not support image");
        await expect(
          prepareAgentRuntimeMessage({ ...input, model: model() }, read),
        ).rejects.toThrow("has not reported image");
        await expect(
          prepareAgentRuntimeMessage({ ...input, model: model(["text", "image"]) }, read),
        ).resolves.toHaveProperty("text");
        expect(agentRuntimePromptImages(promptInput, untrustedAppMessage)).toEqual([
          expect.objectContaining({ source: image }),
        ]);
        expect(read).not.toHaveBeenCalled();
      },
    );
  });
});

describe("agent runtime session activity", () => {
  const activity = (
    sessionId: string,
    status: AgentRuntimeSessionActivity["status"] = "running",
  ): AgentRuntimeSessionActivity => ({
    sessionId,
    threadId: `thread:${sessionId}`,
    status,
    activeRunId: status === "running" ? `run:${sessionId}` : null,
    pendingRequestCount: status === "waiting" ? 1 : 0,
    backgroundTasks: [],
    providerInstanceId: "codex",
    model: "gpt-5.5",
    updatedAt: "2026-10-15T00:00:00.000Z",
  });

  function fakeSource() {
    const reads: Array<(snapshot: AgentRuntimeSessionActivitySnapshot) => void> = [];
    const changeListeners = new Set<(change: AgentRuntimeSessionActivityChange) => void>();
    const connectionListeners = new Set<(state: AgentRuntimeConnectionState) => void>();
    return {
      reads,
      changeListeners,
      push: (change: AgentRuntimeSessionActivityChange) => {
        for (const listener of changeListeners) listener(change);
      },
      pushConnection: (state: AgentRuntimeConnectionState) => {
        for (const listener of connectionListeners) listener(state);
      },
      source: {
        read: () =>
          new Promise<AgentRuntimeSessionActivitySnapshot>((resolve) => {
            reads.push(resolve);
          }),
        subscribe: (listener: (change: AgentRuntimeSessionActivityChange) => void) => {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        readConnection: async (): Promise<AgentRuntimeConnectionState> => ({ status: "idle" }),
        subscribeConnection: (listener: (state: AgentRuntimeConnectionState) => void) => {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Agent Runtime Session activity store", () => {
    it("applies changes that race the initial snapshot in sequence order", async () => {
      const fake = fakeSource();
      const store = createAgentRuntimeActivityStore(fake.source);
      const release = store.subscribeAll(() => {});
      // Pushed before the snapshot answers: one is already covered by it, one is newer.
      fake.push({ type: "upsert", sequence: 4, activity: activity("a", "waiting") });
      fake.push({ type: "remove", sequence: 6, sessionId: "b" });
      fake.reads[0]!({
        sequence: 5,
        items: [activity("a"), activity("b")],
        complete: true,
      });
      await settle();
      expect(store.read("a")?.status).toBe("running");
      expect(store.read("b")).toBeNull();
      release();
    });

    it("notifies only the Session whose activity changed", async () => {
      const fake = fakeSource();
      const store = createAgentRuntimeActivityStore(fake.source);
      const a = vi.fn();
      const b = vi.fn();
      const releaseA = store.subscribeSession("a", a);
      const releaseB = store.subscribeSession("b", b);
      fake.reads[0]!({ sequence: 1, items: [activity("a")], complete: true });
      await settle();
      a.mockClear();
      b.mockClear();
      fake.push({ type: "upsert", sequence: 2, activity: activity("a", "background") });
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
      expect(store.read("a")?.status).toBe("background");
      releaseA();
      releaseB();
    });

    it("re-reads after a reset and after the Runtime becomes ready again", async () => {
      const fake = fakeSource();
      const store = createAgentRuntimeActivityStore(fake.source);
      const release = store.subscribeAll(() => {});
      fake.reads[0]!({ sequence: 1, items: [activity("a")], complete: true });
      await settle();
      fake.push({ type: "reset", sequence: 2 });
      expect(fake.reads).toHaveLength(2);
      fake.reads[1]!({ sequence: 3, items: [], complete: true });
      await settle();
      expect(store.read("a")).toBeNull();
      fake.pushConnection({ status: "restarting", attempt: 1 });
      fake.pushConnection({ status: "ready", generation: "g2" });
      expect(fake.reads).toHaveLength(3);
      expect(store.readConnection()).toEqual({ status: "ready", generation: "g2" });
      fake.reads[2]!({ sequence: 4, items: [], complete: true });
      await settle();
      fake.pushConnection({ status: "unresponsive", generation: "g2" });
      expect(fake.reads).toHaveLength(3);
      fake.pushConnection({ status: "ready", generation: "g2" });
      expect(fake.reads).toHaveLength(4);
      release();
    });

    it("detaches from Main shortly after the last observer leaves", async () => {
      vi.useFakeTimers();
      const fake = fakeSource();
      const store = createAgentRuntimeActivityStore(fake.source);
      const release = store.subscribeSession("a", () => {});
      expect(fake.changeListeners.size).toBe(1);
      release();
      // A quick remount keeps the same attachment.
      const again = store.subscribeSession("a", () => {});
      vi.advanceTimersByTime(5_000);
      expect(fake.changeListeners.size).toBe(1);
      again();
      vi.advanceTimersByTime(5_000);
      expect(fake.changeListeners.size).toBe(0);
      expect(fake.reads).toHaveLength(1);
    });
  });
});

describe("agent runtime session launch", () => {
  it.each(["claudeAgent", "opencode"])(
    "launches with %s when Codex is unavailable",
    async (driver) => {
      const launch = vi
        .fn()
        .mockResolvedValue({ sessionId: "draft", projectId: null, threadId: "root" });
      const transport = {
        launch,
        catalog: vi.fn().mockResolvedValue([
          { instanceId: "codex", enabled: true, installed: false, status: "error", models: [] },
          {
            instanceId: `${driver}_configured`,
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
          modelSelection: { instanceId: `${driver}_configured`, model: "available-model" },
        }),
      );
      expect(onSelectionResolved).toHaveBeenCalledWith(driver);
    },
  );

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
            driver: "opencode",
            displayName: "Work Agent",
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
        caseName === "disabled-instance"
          ? /Work Agent is turned off/
          : /selected Agent.*unavailable/i,
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
      {
        mode: "plan",
        provider: "openai",
        model: "explicit-model",
        reasoning: "high",
        speed: "fast",
      },
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
        newChatDefaults: {
          remembered: {
            binding: { driver: "codex", instanceId: "codex" },
            model: "selected",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          codexServiceTier: "fast",
        },
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
});

describe("agent team", () => {
  const model = {
    slug: "model",
    name: "Model",
    isDefault: true,
    isCustom: false,
    capabilities: null,
  };
  const codex = agentRuntimeProviderFixture({ models: [model] });
  const claude = agentRuntimeProviderFixture({
    instanceId: "claude_work",
    driver: "claudeAgent",
    displayName: "Claude Code",
    models: [model],
  });

  describe("agentTeammate", () => {
    it("finds another harness and skips a second sign-in to the lead's harness", () => {
      const personalClaude = { ...claude, instanceId: "claude_personal" };
      expect(agentTeammate([claude, personalClaude, codex], claude.instanceId)).toBe(codex);
      expect(agentTeammate([claude, personalClaude], claude.instanceId)).toBeNull();
    });

    const [modelsOff] = projectModelPolicyCatalog(
      [claude],
      setModelOn(DEFAULT_MODEL_POLICY, claude, model.slug, false),
    );
    it.each([
      [
        "unavailable",
        agentRuntimeProviderFixture({
          ...claude,
          availability: "unavailable",
          enabled: false,
          installed: false,
        }),
      ],
      [
        "signed out",
        agentRuntimeProviderFixture({ ...claude, auth: { status: "unauthenticated" } }),
      ],
      ["all models off", modelsOff!],
      ["still being checked", agentRuntimeProviderFixture({ ...claude, checkPending: true })],
    ] as const)("skips an Agent that is %s", (_reason, candidate) => {
      expect(agentTeammate([codex, candidate], codex.instanceId)).toBeNull();
    });

    it("never offers an Agent that spends credits, even to a lead that runs on them", () => {
      const creditCodex = agentRuntimeProviderFixture({
        ...codex,
        instanceId: `nodex_codex_${"a".repeat(32)}`,
        source: "nodex",
      });
      const creditClaude = agentRuntimeProviderFixture({
        ...claude,
        instanceId: `nodex_claude_${"a".repeat(32)}`,
        source: "nodex",
      });
      expect(agentTeammate([claude, creditCodex], claude.instanceId)).toBeNull();
      expect(agentTeammate([creditClaude, creditCodex], creditClaude.instanceId)).toBeNull();
      expect(agentTeammate([creditClaude, codex], creditClaude.instanceId)).toBe(codex);
    });

    it("offers a managed API key to Claude Code even though both use the same driver", () => {
      const apiKey = agentRuntimeProviderFixture({
        ...claude,
        instanceId: providerKeyRuntimeInstanceId({ preset: "deepseek", id: "test-key" }),
        displayName: "DeepSeek",
      });
      expect(agentTeammate([claude, apiKey], claude.instanceId)).toBe(apiKey);
    });
  });

  describe("newChatAgentTeam", () => {
    it("starts on Codex by default and follows a remembered Agent choice", () => {
      const providers = [claude, codex];
      expect(newChatAgentTeam(providers)).toEqual({ lead: codex, teammate: claude });
      expect(
        newChatAgentTeam(providers, {
          remembered: {
            binding: { driver: claude.driver, instanceId: claude.instanceId },
            model: model.slug,
          },
        }),
      ).toEqual({ lead: claude, teammate: codex });
    });

    it("has no team while the chat would start on a model that is off", () => {
      const other = { ...model, slug: "other", isDefault: false };
      const [offCodex] = projectModelPolicyCatalog(
        [agentRuntimeProviderFixture({ models: [model, other] })],
        setModelOn(DEFAULT_MODEL_POLICY, codex, model.slug, false),
      );
      const remembered = {
        binding: { driver: codex.driver, instanceId: codex.instanceId },
        model: model.slug,
      };
      expect(newChatAgentTeam([offCodex!, claude], { remembered })).toBeNull();
      expect(newChatAgentTeam([offCodex!, claude])).toEqual({ lead: offCodex, teammate: claude });
    });

    it("has no team when only one Agent is connected", () => {
      expect(newChatAgentTeam([codex])).toBeNull();
    });
  });
});

describe("contextual keyboard action registry", () => {
  beforeEach(() => resetContextualKeyboardActionRegistryForTests());

  test("routes actions to the most recently active registered surface", () => {
    const calls: string[] = [];
    registerContextualKeyboardActionTarget("one", {
      surfaceId: "board-one",
      presentationId: "tab-one",
      canExecute: (commandId) => commandId === "boardOpen",
      execute: () => {
        calls.push("one");
        return true;
      },
    });
    registerContextualKeyboardActionTarget("two", {
      surfaceId: "board-two",
      presentationId: "tab-two",
      canExecute: (commandId) => commandId === "boardOpen",
      execute: () => {
        calls.push("two");
        return true;
      },
    });

    markContextualKeyboardActionTargetActive("board-one");
    expect(canExecuteContextualKeyboardAction("boardOpen")).toBe(true);
    expect(executeContextualKeyboardAction("boardOpen")).toBe(true);
    expect(calls).toEqual(["one"]);

    markContextualKeyboardActionTargetActive("board-two");
    expect(executeContextualKeyboardAction("boardOpen")).toBe(true);
    expect(calls).toEqual(["one", "two"]);
  });

  test("ignores stale unregister calls and fails open without a capability", () => {
    registerContextualKeyboardActionTarget("current", {
      surfaceId: "board",
      presentationId: "tab",
      canExecute: () => false,
      execute: () => {
        throw new Error("Unavailable action must not execute");
      },
    });
    unregisterContextualKeyboardActionTarget("board", "stale");
    expect(executeContextualKeyboardAction("boardOpen")).toBe(false);
    unregisterContextualKeyboardActionTarget("board", "current");
    expect(canExecuteContextualKeyboardAction("boardOpen")).toBe(false);
  });

  test("uses a sole mounted surface before pointer activation", () => {
    registerContextualKeyboardActionTarget("current", {
      surfaceId: "board",
      presentationId: "tab",
      canExecute: (commandId) => commandId === "boardFocusNext",
      execute: () => true,
    });

    expect(executeContextualKeyboardAction("boardFocusNext")).toBe(true);
  });

  test("preserves ownership when a mounted surface updates its target", () => {
    const calls: string[] = [];
    registerContextualKeyboardActionTarget("current", {
      surfaceId: "board",
      presentationId: "tab",
      canExecute: () => true,
      execute: () => {
        calls.push("before");
        return true;
      },
    });
    markContextualKeyboardActionTargetActive("board");

    registerContextualKeyboardActionTarget("current", {
      surfaceId: "board",
      presentationId: "tab",
      canExecute: () => true,
      execute: () => {
        calls.push("after");
        return true;
      },
    });

    expect(executeContextualKeyboardAction("boardOpen")).toBe(true);
    expect(calls).toEqual(["after"]);
  });

  test("routes by the Workbench presentation and blocks background Boards", () => {
    const calls: string[] = [];
    for (const id of ["one", "two"]) {
      registerContextualKeyboardActionTarget(id, {
        surfaceId: `board-${id}`,
        presentationId: `tab-${id}`,
        canExecute: () => true,
        execute: () => {
          calls.push(id);
          return true;
        },
      });
    }

    markContextualKeyboardActionPresentationActive("tab-two");
    expect(executeContextualKeyboardAction("boardFocusNext")).toBe(true);
    expect(calls).toEqual(["two"]);

    markContextualKeyboardActionPresentationActive("browser-tab");
    expect(executeContextualKeyboardAction("boardFocusNext")).toBe(false);
    expect(calls).toEqual(["two"]);
  });

  test("preserves the engaged surface when a presentation has multiple targets", () => {
    const calls: string[] = [];
    for (const id of ["primary", "nested"]) {
      registerContextualKeyboardActionTarget(id, {
        surfaceId: `board-${id}`,
        presentationId: "shared-tab",
        canExecute: () => true,
        execute: () => {
          calls.push(id);
          return true;
        },
      });
    }

    markContextualKeyboardActionTargetActive("board-nested");
    expect(executeContextualKeyboardAction("boardFocusNext")).toBe(true);
    expect(calls).toEqual(["nested"]);
  });
});
