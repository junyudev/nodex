import { expect, it, vi, describe, test } from "vite-plus/test";
import type { AgentRuntimeMessage } from "./agent-runtime-api";
import {
  appendAgentAppContext,
  prepareAgentAppContext,
  prepareAgentMessage,
  retainAgentAppContext,
} from "./agent-prompt";
import type { AgentRuntimeOperations, AgentSnapshot } from "@nodex/agent-runtime/contracts";
import { resolveAgentRuntimeAgentConfig } from "./agent-runtime-agent-config";
import {
  agentRuntimeAgentSwitchRefusal,
  agentRuntimePendingSelection,
  agentRuntimeSelectionRefusal,
} from "./agent-runtime-agent-switch";
import { agentRuntimeContextClearRefusal } from "./agent-runtime-context-clear";
import { agentRuntimeForkSource, agentRuntimeMergeableRun } from "./agent-runtime-fork-merge";
import vectors from "../../tests/fixtures/agent-identity-vectors.json";
import { decodeLegacyAgentBinding } from "./agents/legacy-identity";
import { AgentBackendBindingSchema } from "./schemas/agent-backend";
import {
  agentRuntimeModelSelection,
  applyAgentRuntimeOptionIntent,
  readAgentRuntimeServiceTier,
  readAgentRuntimeEffort,
  type AgentRuntimeOptionDescriptor,
} from "./agent-runtime-provider";
import { parseAgentRuntimeStartupEvidence } from "./agent-runtime-startup-evidence";

describe("agent prompt", () => {
  const prepareAgentPrompt = async (...input: Parameters<typeof prepareAgentMessage>) =>
    (await prepareAgentMessage(...input)).text;

  it("preserves document ordering, pasted text, local files and skills without duplicating mentions", async () => {
    const read = vi.fn(async () => "Full temporary paste contents");
    const temporary = { label: "Paste", path: "/temp/paste.txt", fsPath: "/temp/paste.txt" };
    expect(
      await prepareAgentPrompt(
        "fallback",
        {
          text: "fallback",
          documentItems: [
            { type: "text", text: "Use " },
            { type: "skill", name: "audit", path: "/skills/audit/SKILL.md" },
          ],
          skills: [{ name: "audit", path: "/skills/audit/SKILL.md" }],
          textAttachments: [
            { text: "Complete pasted instructions" },
            { file: temporary, preview: "Truncated preview" },
          ],
          fileAttachments: [
            {
              label: "app.ts",
              path: "app.ts",
              fsPath: "/project/app.ts",
              startLine: 5,
              endLine: 10,
            },
          ],
        },
        read,
      ),
    ).toBe(
      "Use [audit](/skills/audit/SKILL.md)\n\n[app.ts](/project/app.ts):5-10\n\nComplete pasted instructions\n\nFull temporary paste contents",
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(temporary);
  });

  it("rejects unsupported inputs and unavailable paste sources before submission", async () => {
    const read = vi.fn(async () => {
      throw new Error("Paste source unavailable");
    });
    await expect(
      prepareAgentPrompt("Inspect", { text: "Inspect", images: [{ source: "/image.png" }] }, read),
    ).rejects.toThrow("does not support image");
    await expect(
      prepareAgentPrompt("Run", { text: "Run", agentConfigs: [{ model: "other" }] }, read),
    ).rejects.toThrow("model and mode menus");
    await expect(
      prepareAgentPrompt(
        "Inspect",
        {
          text: "Inspect",
          textAttachments: [
            { file: { label: "Paste", path: "/missing", fsPath: "/missing" }, preview: "Preview" },
          ],
        },
        read,
      ),
    ).rejects.toThrow("Paste source unavailable");
  });

  it("dispatches the selected native skill at the start of the text block with all context as arguments", async () => {
    const result = await prepareAgentPrompt(
      "fallback",
      {
        text: "fallback",
        documentItems: [
          { type: "text", text: "First inspect " },
          { type: "skill", name: "review", path: "/skills/review" },
          { type: "text", text: " then " },
          { type: "skill", name: "audit", path: "/skills/audit" },
          { type: "text", text: " the change" },
        ],
        textAttachments: [{ text: "Full evidence" }],
        images: [{ source: "data:image/png;base64,AA==" }],
      },
      vi.fn(),
      { images: true, nativeSkills: true },
    );
    expect(result).toBe("/audit First inspect /review then  the change\n\nFull evidence");
  });

  it("leaves structured Agent config to semantic runtime admission without adding it to model-visible text", async () => {
    const input = {
      text: "Inspect the change",
      agentConfigs: [{ model: "model-b", mode: "plan", reasoning: "high", speed: "fast" }],
    };
    expect(await prepareAgentPrompt("fallback", input, vi.fn(), { agentConfigs: true })).toBe(
      "Inspect the change",
    );
    expect(input.agentConfigs[0]).toEqual({
      model: "model-b",
      mode: "plan",
      reasoning: "high",
      speed: "fast",
    });
  });

  it("preserves captured app provenance and structured context with images through the shared compiler", async () => {
    const input = {
      text: "Explain this",
      mcpAppModelContextAttachments: [
        {
          id: "widget-1",
          sourceName: "Calendar",
          server: "calendar",
          kind: "context" as const,
          untrusted: true as const,
          content: [
            {
              type: "text" as const,
              text: "Meeting context",
              annotations: { audience: ["assistant" as const] },
            },
            { type: "image" as const, mimeType: "image/png", data: "AA==" },
          ],
          structuredContent: { meetingId: "meeting-2" },
        },
      ],
    };
    const message = await prepareAgentMessage("Explain this", input, vi.fn(), { images: true });
    // The app's data rides beside the user's words as a context record the Agent reads as data.
    expect(message.text).toBe("Explain this");
    const record = message.context!.records[0]!;
    expect(record.kind).toBe("nodex-app-context");
    expect(record.payload).toMatchObject({
      trust: "untrusted",
      items: [
        {
          kind: "model_context",
          source: "mcp_app",
          sourceId: "widget-1",
          server: "calendar",
          text: "Meeting context",
          structuredContent: { meetingId: "meeting-2" },
        },
      ],
    });
    expect(prepareAgentAppContext(input).images).toEqual([
      { source: "data:image/png;base64,AA==" },
    ]);
    expect(input.mcpAppModelContextAttachments[0]!.content).toHaveLength(2);
  });

  it("compiles visualization follow-ups as labeled app data and refuses invalid captured provenance", async () => {
    const untrustedAppMessage = {
      source: "visualization" as const,
      sourceId: "chart-1",
      text: "Use the highlighted bar",
    };
    const message = await prepareAgentMessage("Follow-up", undefined, vi.fn(), {
      untrustedAppMessage,
    });
    expect(message.text).toBe("Follow-up");
    expect(
      (message.context as unknown as { records: { payload: { items: unknown[] } }[] }).records[0]!
        .payload.items,
    ).toEqual([{ kind: "message", ...untrustedAppMessage }]);
    await expect(
      prepareAgentPrompt("Follow-up", undefined, vi.fn(), {
        untrustedAppMessage: { ...untrustedAppMessage, sourceId: "" },
      }),
    ).rejects.toThrow("Invalid untrusted app message");
  });

  it("keeps a queued message's app data when its words are rewritten", async () => {
    const untrustedAppMessage = {
      source: "visualization" as const,
      sourceId: "chart-1",
      text: "Use the highlighted bar",
      structuredContent: { bar: 3 },
    };
    const original = await prepareAgentMessage("Compare these", undefined, vi.fn(), {
      untrustedAppMessage,
    });
    const rewritten = retainAgentAppContext({ text: "Compare only the first two" }, original);
    expect(rewritten.text).toBe("Compare only the first two");
    expect(rewritten.context).toEqual(original.context);

    // New app data replaces the old; a message that had none gains none.
    const fresh = await prepareAgentMessage("Compare", undefined, vi.fn(), {
      untrustedAppMessage: { ...untrustedAppMessage, sourceId: "chart-2" },
    });
    expect(retainAgentAppContext(fresh, original)).toEqual(fresh);
    expect(retainAgentAppContext({ text: "Plain" }, {})).toEqual({ text: "Plain" });
  });

  it("fits a long label within the limit Agent execution keeps a record under", () => {
    const message = appendAgentAppContext<Pick<AgentRuntimeMessage, "text" | "context">>(
      { text: "" },
      [{ text: "evidence" }],
      "x".repeat(400),
    );
    expect(message.context!.records[0]!.label).toHaveLength(200);
  });
});

describe("agent runtime agent config", () => {
  const providers = [
    {
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
      models: [
        { slug: "default", name: "Default", isDefault: true, isCustom: false, capabilities: null },
        { slug: "chosen", name: "Chosen", isDefault: false, isCustom: false, capabilities: null },
      ],
    },
  ] satisfies AgentRuntimeOperations["providers.read"]["output"];
  const base = {
    providers,
    modelSelection: { instanceId: "codex", model: "default" },
    interactionMode: "default" as const,
  };

  it("resolves a model and mode without requiring or manufacturing execution identity", () => {
    const message = {
      text: "Task",
      agentConfigs: [{ model: "chosen", mode: "plan" }],
      provenance: "editor",
    };
    const result = resolveAgentRuntimeAgentConfig({ ...base, message });
    expect(result).toEqual({
      hasConfig: true,
      message: {
        ...message,
        modelSelection: { instanceId: "codex", model: "chosen", options: [] },
        interactionMode: "plan",
      },
    });
    expect(result.message).not.toHaveProperty("messageId");
    expect(message).not.toHaveProperty("modelSelection");
  });

  it("parses raw config only when the structured config sidecar is absent", () => {
    const text = 'Task\n\n:agent-config{model="chosen"}';
    expect(resolveAgentRuntimeAgentConfig({ ...base, message: { text } })).toMatchObject({
      hasConfig: true,
      message: { text: "Task", modelSelection: { instanceId: "codex", model: "chosen" } },
    });
    const message = { text, agentConfigs: [] };
    const result = resolveAgentRuntimeAgentConfig({ ...base, message });
    expect(result.hasConfig).toBe(false);
    expect(result.message).toBe(message);
  });

  it("refuses an unavailable configured model before changing the original message", () => {
    const message = { text: "Task", agentConfigs: [{ model: "removed" }] };
    expect(() => resolveAgentRuntimeAgentConfig({ ...base, message })).toThrow(
      "Agent model 'removed' is unavailable",
    );
    expect(message).toEqual({ text: "Task", agentConfigs: [{ model: "removed" }] });
  });

  it("writes Fast as the id the model's catalog gives the tier", () => {
    const tiers = {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select" as const,
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
          ],
        },
      ],
    };
    const result = resolveAgentRuntimeAgentConfig({
      ...base,
      providers: [
        {
          ...providers[0]!,
          models: [{ slug: "default", name: "Default", isCustom: false, capabilities: tiers }],
        },
      ],
      message: { text: "Task", agentConfigs: [{ speed: "fast" }] },
    });
    expect(result.message.modelSelection?.options).toEqual([
      { id: "serviceTier", value: "priority" },
    ]);
  });
});

describe("agent runtime agent switch", () => {
  type Projection = Parameters<typeof agentRuntimeAgentSwitchRefusal>[0];
  const session = (status: string, handoff = true) => ({
    id: "session",
    status,
    capabilities: { sessions: { supportsProviderSwitchingViaHandoff: handoff } },
  });
  const finished = {
    thread: {
      id: "thread",
      activeProviderThreadId: "provider-thread",
      modelSelection: { instanceId: "codex", model: "gpt" },
    },
    runs: [{ id: "run", status: "completed", providerThreadId: "provider-thread" }],
    providerSessions: [],
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId: "thread",
        providerInstanceId: "codex",
        providerSessionId: "detached-session",
        nativeThreadRef: { driver: "codex", nativeId: "native", strength: "strong" },
        firstRunOrdinal: 1,
      },
    ],
  } as unknown as Projection;
  const withRuns = (status: string): Projection => ({
    ...finished,
    runs: [{ ...finished.runs[0]!, status } as AgentSnapshot["projection"]["runs"][number]],
  });

  describe("Agent switching in a started chat", () => {
    it("lets a finished chat continue on another Agent after its process detached", () => {
      expect(agentRuntimeAgentSwitchRefusal(finished)).toBeNull();
    });

    it("follows a live provider session's capability, including while its reply runs", () => {
      const running = withRuns("running");
      expect(
        agentRuntimeAgentSwitchRefusal({
          ...running,
          providerSessions: [session("running")],
          providerThreads: [{ ...finished.providerThreads[0]!, providerSessionId: "session" }],
        } as unknown as Projection),
      ).toBeNull();
      expect(
        agentRuntimeAgentSwitchRefusal({
          ...running,
          providerSessions: [session("ready", false)],
          providerThreads: [{ ...finished.providerThreads[0]!, providerSessionId: "session" }],
        } as unknown as Projection),
      ).toMatch(/can't continue on another Agent/u);
    });

    it("waits for a starting reply's session and refuses a chat without native history", () => {
      expect(agentRuntimeAgentSwitchRefusal(withRuns("starting"))).toMatch(/Wait for the current/u);
      expect(
        agentRuntimeAgentSwitchRefusal({
          ...finished,
          providerThreads: [{ ...finished.providerThreads[0]!, nativeThreadRef: null }],
        } as unknown as Projection),
      ).toMatch(/can't continue on another Agent/u);
      expect(agentRuntimeAgentSwitchRefusal({ ...finished, runs: [] })).toBeNull();
    });

    it("lets a cleared chat start its fresh conversation on any Agent", () => {
      expect(
        agentRuntimeAgentSwitchRefusal({
          ...finished,
          providerThreads: [
            { ...finished.providerThreads[0]!, nativeThreadRef: null, firstRunOrdinal: null },
          ],
        } as unknown as Projection),
      ).toBeNull();
    });

    it("applies the chat's Agent rule to other Agents and the provider's model rule within one", () => {
      const current = { instanceId: "codex", model: "gpt" };
      const providers = [
        { instanceId: "codex", requiresNewThreadForModelChange: false },
        { instanceId: "pinned", requiresNewThreadForModelChange: true },
      ];
      const refusal = "Wait for the current reply to start, then choose another Agent.";
      expect(
        agentRuntimeSelectionRefusal({
          current,
          next: { instanceId: "claude", model: "sonnet" },
          agentSwitchRefusal: refusal,
          providers,
        }),
      ).toBe(refusal);
      expect(
        agentRuntimeSelectionRefusal({
          current,
          next: { instanceId: "codex", model: "gpt-mini" },
          agentSwitchRefusal: refusal,
          providers,
        }),
      ).toBeNull();
      expect(
        agentRuntimeSelectionRefusal({
          current: { instanceId: "pinned", model: "a" },
          next: { instanceId: "pinned", model: "b" },
          agentSwitchRefusal: null,
          providers,
        }),
      ).toMatch(/keeps its model/u);
      expect(
        agentRuntimeSelectionRefusal({
          current: { instanceId: "pinned", model: "a" },
          next: { instanceId: "pinned", model: "a" },
          agentSwitchRefusal: null,
          providers,
        }),
      ).toBeNull();
    });

    it("carries only a choice that differs from what the chat last ran, in any option order", () => {
      const observed = {
        instanceId: "codex",
        model: "gpt",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "fast" },
        ],
      };
      const reordered = { ...observed, options: [...observed.options].reverse() };
      expect(agentRuntimePendingSelection(observed, reordered)).toBeNull();
      expect(agentRuntimePendingSelection(observed, undefined)).toBeNull();
      const claude = { instanceId: "claude", model: "sonnet" };
      expect(agentRuntimePendingSelection(observed, claude)).toBe(claude);
      const lower = { ...observed, options: [{ id: "reasoningEffort", value: "low" }] };
      expect(agentRuntimePendingSelection(observed, lower)).toBe(lower);
    });
  });
});

describe("agent runtime context clear", () => {
  type Projection = Parameters<typeof agentRuntimeContextClearRefusal>[0];
  const idle = {
    runs: [{ id: "run", status: "completed" }],
    providerThreads: [{ id: "provider-thread", pendingBackgroundTasks: [] }],
    subagents: [{ id: "task", status: "completed" }],
  } as unknown as Projection;

  describe("Clearing a chat's context", () => {
    it("clears a finished chat, including one whose latest reply failed or stopped", () => {
      expect(agentRuntimeContextClearRefusal(idle)).toBeNull();
      for (const status of ["failed", "interrupted", "cancelled"])
        expect(
          agentRuntimeContextClearRefusal({
            ...idle,
            runs: [{ ...idle.runs[0]!, status }],
          } as unknown as Projection),
        ).toBeNull();
    });

    it("waits for anything that could still add to the context", () => {
      for (const status of ["preparing", "queued", "starting", "running", "waiting"])
        expect(
          agentRuntimeContextClearRefusal({
            ...idle,
            runs: [...idle.runs, { id: "next", status }],
          } as unknown as Projection),
        ).toMatch(/Wait for the reply and queued messages/u);
      expect(
        agentRuntimeContextClearRefusal({
          ...idle,
          providerThreads: [{ id: "provider-thread", pendingBackgroundTasks: [{ id: "shell" }] }],
        } as unknown as Projection),
      ).toMatch(/Stop background work/u);
      expect(
        agentRuntimeContextClearRefusal({
          ...idle,
          subagents: [{ id: "task", status: "running" }],
        } as unknown as Projection),
      ).toMatch(/subagents to report back/u);
    });

    it("has nothing to clear before a message or after every Run was rewound", () => {
      expect(agentRuntimeContextClearRefusal({ ...idle, runs: [] })).toMatch(/Send a message/u);
      expect(
        agentRuntimeContextClearRefusal({
          ...idle,
          runs: [{ id: "run", status: "rolled_back" }],
        } as unknown as Projection),
      ).toMatch(/Send a message/u);
    });
  });
});

describe("agent runtime fork merge", () => {
  type Status = Parameters<typeof agentRuntimeMergeableRun>[0][number]["status"];
  const run = (ordinal: number, status: Status) => ({ id: `run:${ordinal}`, ordinal, status });

  describe("Merging a fork back", () => {
    it("merges the newest finished Run, including one still capturing its checkpoint", () => {
      expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "failed")])?.id).toBe("run:1");
      expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "waiting")])?.id).toBe("run:2");
      expect(agentRuntimeMergeableRun([run(1, "failed")])).toBeNull();
    });

    it("holds the merge while a newer Run is still working", () => {
      expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "running")])).toBeNull();
      expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "queued")])?.id).toBe("run:1");
    });

    it("finds the source only from the Run a chat was forked at", () => {
      expect(
        agentRuntimeForkSource({ forkedFrom: { type: "run", threadId: "source", runId: "r" } }),
      ).toBe("source");
      expect(agentRuntimeForkSource({ forkedFrom: null })).toBeNull();
    });
  });
});

describe("Agent Runtime provider identity", () => {
  it.each(vectors)("preserves the instance ID for $kind $configId", (vector) => {
    const binding = decodeLegacyAgentBinding({
      kind: vector.kind,
      instanceConfigId: vector.configId,
      agentDefinitionId: vector.definitionId,
    });
    expect(binding).toEqual({ driver: vector.driver, instanceId: vector.instanceId });
    expect(AgentBackendBindingSchema.safeParse(binding).success).toBe(true);
  });

  it("routes an unfamiliar driver with its exact instance ID", () => {
    const binding = AgentBackendBindingSchema.parse({
      driver: "futureAgent",
      instanceId: "future_work",
    });
    expect(agentRuntimeModelSelection(binding, " model ")).toEqual({
      instanceId: "future_work",
      model: "model",
    });
    expect(AgentBackendBindingSchema.safeParse({ ...binding, instanceId: " padded" }).success).toBe(
      false,
    );
  });
});

describe("Agent Runtime model option intent", () => {
  const codex: AgentRuntimeOptionDescriptor[] = [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        { id: "fast", label: "Fast" },
      ],
    },
  ];
  const claude: AgentRuntimeOptionDescriptor[] = [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({ id, label: id })),
    },
    { id: "thinking", label: "Thinking", type: "boolean" },
    { id: "fastMode", label: "Speed", type: "boolean" },
  ];

  it("writes Codex effort and speed under reasoningEffort and serviceTier", () => {
    expect(
      applyAgentRuntimeOptionIntent(codex, undefined, {
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    ).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "fast" },
    ]);
    const standard = applyAgentRuntimeOptionIntent(codex, [{ id: "serviceTier", value: "fast" }], {
      serviceTier: null,
    });
    expect(standard).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(readAgentRuntimeServiceTier(standard)).toBeNull();
    expect(readAgentRuntimeServiceTier([{ id: "serviceTier", value: "fast" }])).toBe("fast");
  });

  it("reaches a model whose catalog names Fast `priority`, and reads it back as Fast", () => {
    const tiers = [
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select" as const,
        options: [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast" },
        ],
      },
    ];
    const fast = applyAgentRuntimeOptionIntent(tiers, undefined, { serviceTier: "fast" });
    expect(fast).toEqual([{ id: "serviceTier", value: "priority" }]);
    expect(readAgentRuntimeServiceTier(fast)).toBe("fast");
    const standard = applyAgentRuntimeOptionIntent(tiers, fast, { serviceTier: null });
    expect(standard).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(readAgentRuntimeServiceTier(standard)).toBeNull();
  });

  it.each([
    { offered: ["priority", "ultrafast"], requested: "ultrafast", expected: "ultrafast" },
    { offered: ["priority"], requested: "ultrafast", expected: "priority" },
    { offered: ["ultrafast"], requested: "fast", expected: "default" },
    { offered: [], requested: "ultrafast", expected: "default" },
  ])(
    "fits $requested to $expected on a model offering $offered",
    ({ offered, requested, expected }) => {
      const descriptors: AgentRuntimeOptionDescriptor[] = offered.length
        ? [
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select",
              options: offered.map((id) => ({ id, label: id })),
            },
          ]
        : [];
      const options = applyAgentRuntimeOptionIntent(descriptors, undefined, {
        serviceTier: requested,
      });
      expect(options).toEqual([{ id: "serviceTier", value: expected }]);
      expect(applyAgentRuntimeOptionIntent(descriptors, options, {})).toEqual(options);
    },
  );

  it("names Standard on a model without speeds only to clear a faster one", () => {
    expect(applyAgentRuntimeOptionIntent([], undefined, { serviceTier: null })).toEqual([]);
    expect(
      applyAgentRuntimeOptionIntent([], [{ id: "serviceTier", value: "priority" }], {
        serviceTier: null,
      }),
    ).toEqual([]);
  });

  it("writes Claude effort under effort and keeps its other declared options", () => {
    expect(
      applyAgentRuntimeOptionIntent(
        claude,
        [
          { id: "thinking", value: false },
          { id: "fastMode", value: true },
        ],
        { reasoningEffort: "max" },
      ),
    ).toEqual([
      { id: "thinking", value: false },
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
  });

  it("preserves Antigravity's native thought-level choice through effort intent and handoff", () => {
    const descriptors: AgentRuntimeOptionDescriptor[] = [
      {
        id: "thought_level",
        label: "Thinking",
        type: "select",
        options: [
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
        ],
      },
    ];
    const options = applyAgentRuntimeOptionIntent(descriptors, undefined, {
      reasoningEffort: "high",
    });
    expect(options).toEqual([{ id: "thought_level", value: "high" }]);
    expect(readAgentRuntimeEffort(options)).toBe("high");
    expect(
      applyAgentRuntimeOptionIntent(descriptors, options, { reasoningEffort: "unavailable" }),
    ).toEqual([]);
  });

  it("never carries another provider's ids or values a model does not offer", () => {
    expect(
      applyAgentRuntimeOptionIntent(
        codex,
        [
          { id: "effort", value: "max" },
          { id: "reasoningEffort", value: "xhigh" },
        ],
        {},
      ),
    ).toEqual([]);
    expect(
      applyAgentRuntimeOptionIntent(codex, [{ id: "reasoningEffort", value: "low" }], {
        reasoningEffort: "ultra",
      }),
    ).toEqual([]);
  });
});

describe("agent runtime startup evidence", () => {
  const evidence = {
    schemaVersion: 1,
    runId: "isolated-run",
    hostPid: 42,
    runtimeId: "runtime",
    runtimeGeneration: "generation",
    nodeSource: "standalone",
    nodeVersion: "24.22.1",
  };
  const expected = { runId: evidence.runId, hostPid: evidence.hostPid };
  test("startup evidence identifies the execution process's exact host generation", () => {
    expect(parseAgentRuntimeStartupEvidence(evidence, expected)).toEqual(evidence);
    expect(() => parseAgentRuntimeStartupEvidence({ ...evidence, hostPid: 43 }, expected)).toThrow(
      "another host generation",
    );
    expect(() =>
      parseAgentRuntimeStartupEvidence({ ...evidence, runId: "earlier-run" }, expected),
    ).toThrow("another host generation");
  });
  test("readiness requires an execution identity and excludes private connection fields", () => {
    expect(() =>
      parseAgentRuntimeStartupEvidence({ ...evidence, runtimeGeneration: "" }, expected),
    ).toThrow();
    expect(() =>
      parseAgentRuntimeStartupEvidence(
        { ...evidence, mcpEndpoint: "http://private/secret" },
        expected,
      ),
    ).toThrow();
  });
});
