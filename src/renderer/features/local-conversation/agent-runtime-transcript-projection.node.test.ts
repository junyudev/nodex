import { prepareAgentMessage } from "../../../shared/agent-prompt";
import { describe, expect, test } from "vite-plus/test";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { projectCodexCanonicalTurnItemViews } from "../../../shared/codex-canonical-item-projector";
import { buildCodexFileChangePatchRows } from "../../../shared/codex-file-change";
import { projectCodexItemViewToTranscriptEntry } from "../../../shared/codex-transcript-entry-projection";
import {
  buildAgentRuntimeAttachmentSource,
  buildAgentRuntimeToolResultImageSource,
} from "../../../shared/agent-runtime-attachments";
import {
  isAgentRuntimeItemHidden,
  parseAgentRuntimeToolName,
  projectAgentRuntimeExportTurns,
  projectAgentRuntimeHookRun,
  projectAgentRuntimeItem,
  type AgentRuntimeThread,
} from "./agent-runtime-transcript-projection";
import { buildRendererItemStream } from "./projection/build-renderer-item-stream";
import { bucketizeTurnItems } from "./projection/bucketize-turn-items";
import { buildTurnViewModel } from "./projection/build-turn-view-model";

const at = "2026-10-15T00:00:00.000Z";
const base = {
  id: "item",
  threadId: "parent",
  runId: "parent-run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as AgentTurnItem["status"],
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
};
const tool = (
  toolName: string,
  status: AgentTurnItem["status"] = "completed",
): Extract<AgentTurnItem, { type: "dynamic_tool" }> => ({
  ...base,
  status,
  type: "dynamic_tool",
  toolName,
  input: { query: "plan" },
  output: "done",
});
const task = (
  status: AgentTurnItem["status"],
  overrides: Partial<Extract<AgentTurnItem, { type: "subagent" }>> = {},
): Extract<AgentTurnItem, { type: "subagent" }> => ({
  ...base,
  status,
  type: "subagent",
  subagentId: "task",
  origin: "app_owned",
  driver: "claudeAgent",
  providerInstanceId: "claude",
  childThreadId: "child",
  prompt: "Review the auth module\nand report findings",
  result: null,
  ...overrides,
});
const message = (
  overrides: Partial<Extract<AgentTurnItem, { type: "user_message" }>>,
): Extract<AgentTurnItem, { type: "user_message" }> => ({
  ...base,
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: "message",
  inputIntent: "turn_start",
  text: "Hello",
  attachments: [],
  ...overrides,
});

describe("Runtime request recovery", () => {
  const failure = {
    class: "provider_error",
    code: "api_error_unknown",
    message: "Claude API unknown.",
    retryable: true,
  } as const;
  const error = (
    overrides: Partial<Extract<AgentTurnItem, { type: "error" }>> = {},
  ): Extract<AgentTurnItem, { type: "error" }> => ({
    ...base,
    type: "error",
    status: "running",
    completedAt: null,
    failure,
    retry: { attempt: 2, maxAttempts: 10, retryDelayMs: 1200 },
    ...overrides,
  });

  test("preserves provider retry progress without guessing an unknown cause", () => {
    expect(projectAgentRuntimeItem(error())).toEqual({
      type: "error",
      id: "item",
      message: failure.message,
      recovery: {
        state: "retrying",
        reason: "unknown",
        attempt: 2,
        maxAttempts: 10,
        retryAt: Date.parse(at) + 1200,
        updatedAt: Date.parse(at),
      },
      errorInfo: null,
      additionalDetails: "Code: api_error_unknown",
    });
  });

  test.each([
    ["pending", "retrying"],
    ["running", "retrying"],
    ["waiting", "retrying"],
    ["completed", "recovered"],
    ["idle", "recovered"],
    ["failed", "failed"],
    ["cancelled", "stopped"],
    ["interrupted", "stopped"],
  ] as const)("%s retry history projects as %s", (status, state) => {
    expect(projectAgentRuntimeItem(error({ status }))).toMatchObject({
      recovery: {
        state,
        attempt: 2,
        maxAttempts: 10,
        retryAt: state === "retrying" ? Date.parse(at) + 1200 : null,
      },
    });
  });

  test("retryability alone never invents an automatic retry", () => {
    expect(projectAgentRuntimeItem(error({ retry: undefined }))).toMatchObject({
      recovery: { state: "failed", attempt: null, maxAttempts: null, retryAt: null },
    });
    expect(
      projectAgentRuntimeItem(
        error({ retry: { attempt: 1, maxAttempts: null, retryDelayMs: null } }),
      ),
    ).toMatchObject({
      recovery: { state: "retrying", attempt: 1, maxAttempts: null, retryAt: null },
    });
  });

  test.each([
    [{ ...failure, code: "api_error_529" }, "overloaded"],
    [{ ...failure, code: "api_error_429" }, "rate_limit"],
    [{ ...failure, code: "authentication_failed" }, "authentication"],
    [{ ...failure, class: "transport_error" }, "unknown"],
    [{ ...failure, code: null, class: "transport_error" }, "connection"],
    [{ ...failure, code: null, class: "usage_limit" }, "usage_limit"],
  ] as const)("uses reported provider classification %j", (reported, reason) => {
    expect(projectAgentRuntimeItem(error({ failure: reported }))).toMatchObject({
      recovery: { reason },
    });
  });

  test("terminal failures retain the cause and reset time for diagnostic details", () => {
    const resetAt = "2026-10-15T01:00:00.000Z";
    expect(
      projectAgentRuntimeItem(
        error({
          status: "failed",
          failure: { ...failure, class: "usage_limit", code: null, retryable: false, resetAt },
        }),
      ),
    ).toMatchObject({
      message: failure.message,
      recovery: { state: "failed", reason: "usage_limit", retryAt: null },
      additionalDetails: "Usage resets: Thu, 15 Oct 2026 01:00:00 GMT",
    });
  });
});

describe("Runtime application tool presentation", () => {
  test("every provider spelling of the application server resolves to nodex_app", () => {
    expect(parseAgentRuntimeToolName("mcp__nodex_app__search")).toEqual({
      namespace: "nodex_app",
      tool: "search",
    });
    expect(parseAgentRuntimeToolName("nodex_app.create_session")).toEqual({
      namespace: "nodex_app",
      tool: "create_session",
    });
    expect(parseAgentRuntimeToolName("nodex-app.fetch")).toMatchObject({ namespace: "nodex_app" });
    expect(parseAgentRuntimeToolName("github.create_issue")).toEqual({
      namespace: "github",
      tool: "create_issue",
    });
    expect(parseAgentRuntimeToolName("WebFetch")).toEqual({ namespace: null, tool: "WebFetch" });
    expect(parseAgentRuntimeToolName(null)).toEqual({ namespace: null, tool: "Tool" });
  });

  test("application calls keep their namespace for rich rendering", () => {
    expect(projectAgentRuntimeItem(tool("mcp__nodex_app__search"))).toMatchObject({
      type: "dynamicToolCall",
      namespace: "nodex_app",
      tool: "search",
    });
  });

  test("dynamic tool presentation preserves the execution title and typed output content", () => {
    const contentItems = [
      { type: "inputText", text: "Image captured" },
      { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
      { type: "inputAudio", audioUrl: "data:audio/wav;base64,YXVkaW8=" },
    ];
    expect(
      projectAgentRuntimeItem({
        ...tool("node_repl.js"),
        title: "Inspecting workspace",
        output: contentItems,
      }),
    ).toMatchObject({
      type: "dynamicToolCall",
      displayTitle: "Inspecting workspace",
      contentItems,
    });
  });

  test("completed file inspections use their image path even when history omits tool output", () => {
    const read = {
      ...tool("Read"),
      title: "Read /workspace/rail-states-light.png",
      viewedImagePath: "/workspace/rail-states-light.png",
      input: { file_path: "/workspace/rail-states-light.png" },
    };
    const output = {
      type: "image",
      file: {
        type: "image/png",
        originalSize: 13675,
        dimensions: { originalWidth: 760, originalHeight: 236 },
        sizeBytes: 13675,
      },
    };
    for (const result of [{ output }, { output: undefined, outputOmitted: true }]) {
      expect(projectAgentRuntimeItem({ ...read, ...result })).toEqual({
        type: "imageView",
        id: read.id,
        path: read.viewedImagePath,
      });
    }
  });

  test.each(["pending", "running", "waiting", "failed", "cancelled", "interrupted"] as const)(
    "%s image reads keep their tool lifecycle and inspectable result",
    (status) => {
      const read = {
        ...tool("Read", status),
        viewedImagePath: "/workspace/reference.png",
        title: "Read /workspace/reference.png",
        input: { file_path: "/workspace/reference.png" },
        output: status === "failed" ? "File does not exist" : undefined,
      };
      expect(projectAgentRuntimeItem(read)).toMatchObject({
        type: "dynamicToolCall",
        displayTitle: read.title,
        arguments: read.input,
        status: ["pending", "running", "waiting"].includes(status) ? "inProgress" : "failed",
        contentItems: read.output === undefined ? null : [{ type: "inputText", text: read.output }],
      });
    },
  );

  test("file arguments alone do not turn ordinary tools into image inspections", () => {
    const read = {
      ...tool("Read"),
      title: "Read /workspace/README.md",
      input: { file_path: "/workspace/README.md" },
      output: "Documentation",
    };
    expect(projectAgentRuntimeItem(read)).toMatchObject({
      type: "dynamicToolCall",
      displayTitle: read.title,
      contentItems: [{ type: "inputText", text: "Documentation" }],
    });
    expect(
      projectAgentRuntimeItem({ ...tool("Write"), input: { file_path: "/workspace/output.png" } }),
    ).toMatchObject({ type: "dynamicToolCall", tool: "Write" });
  });

  test("runtime MCP calls retain native identity, metadata and typed result images through projection", () => {
    const source = buildAgentRuntimeToolResultImageSource({
      sourceThreadId: "parent",
      itemId: "item",
      contentIndex: 1,
    });
    const projected = projectAgentRuntimeItem({
      ...tool("cua_repl.js"),
      output: undefined,
      mcpToolCall: {
        type: "mcpToolCall",
        id: "native-call",
        server: "cua_repl",
        tool: "js",
        status: "completed",
        arguments: { title: "Inspect page", code: "await tab.capture()" },
        pluginId: "browser-tools",
        result: {
          content: [
            { type: "text", text: "Captured" },
            { type: "image", mimeType: "image/png" },
          ],
          structuredContent: { page: "Example" },
          _meta: { "codex/toolSurface": { kind: "browserUse", backend: "chrome" } },
        },
      },
    });
    expect(projected?.type).toBe("mcpToolCall");
    const view = projectCodexCanonicalTurnItemViews({
      threadId: "parent",
      turnId: "parent-run",
      items: [projected!],
      observedAtMs: 1,
      turnStatus: "completed",
    })[0];
    expect(view?.itemId).toBe("item");
    expect(view?.mcpToolCall).toMatchObject({
      callId: "native-call",
      pluginId: "browser-tools",
      invocation: { server: "cua_repl", tool: "js", arguments: { title: "Inspect page" } },
      source: { kind: "browserUse", backend: "chrome" },
      result: {
        type: "success",
        structuredContent: { page: "Example" },
        content: [
          { type: "text", text: "Captured" },
          { type: "image", source, data: "", mimeType: "image/png" },
        ],
      },
    });
  });

  test("application MCP tools keep their registered identity and complete media result", () => {
    const projected = projectAgentRuntimeItem({
      ...tool("nodex_app.capture"),
      mcpToolCall: {
        type: "mcpToolCall",
        id: "native-call",
        server: "nodex_app",
        tool: "capture",
        status: "completed",
        arguments: {},
        result: {
          content: [
            { type: "text", text: "Captured" },
            { type: "image", mimeType: "image/png" },
          ],
          structuredContent: { captured: true },
        },
      },
    });
    expect(projected).toMatchObject({
      type: "dynamicToolCall",
      namespace: "nodex_app",
      tool: "capture",
      contentItems: [
        { type: "inputText", text: '{"captured":true}' },
        { type: "inputText", text: "Captured" },
        {
          type: "inputImage",
          imageUrl: buildAgentRuntimeToolResultImageSource({
            sourceThreadId: "parent",
            itemId: "item",
            contentIndex: 1,
          }),
        },
      ],
    });
  });

  test("execution plumbing never reaches the transcript and task calls defer to the task row", () => {
    for (const name of ["list_agent_models", "task_status", "task_wait"])
      for (const status of ["running", "completed", "failed"] as const)
        expect(projectAgentRuntimeItem(tool(`nodex_app.${name}`, status))).toBeNull();
    for (const name of ["mcp__nodex_app__delegate_task", "nodex_app.task_cancel"]) {
      expect(isAgentRuntimeItemHidden(tool(name, "running"))).toBe(true);
      expect(isAgentRuntimeItemHidden(tool(name, "completed"))).toBe(true);
      // A failed delegation has no task row, so the failure stays visible.
      expect(projectAgentRuntimeItem(tool(name, "failed"))).toMatchObject({ status: "failed" });
    }
    expect(projectAgentRuntimeItem(tool("nodex_app.task_send"))).not.toBeNull();
    expect(projectAgentRuntimeItem(tool("other.task_status"))).not.toBeNull();
  });
});

describe("Runtime imported images", () => {
  const thread = {
    id: base.threadId,
    projectId: "project",
    title: "Imported chat",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/replacement",
    activeProviderThreadId: null,
    historyOrigin: "native_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: base.threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies AgentRuntimeThread;
  const image = {
    type: "image" as const,
    id: "copied-image",
    name: "copied.png",
    mimeType: "image/png",
    sizeBytes: 20,
  };
  const projectHistory = (items: readonly AgentTurnItem[]) => {
    const canonical = items.flatMap((item) => projectAgentRuntimeItem(item) ?? []);
    const views = projectCodexCanonicalTurnItemViews({
      threadId: base.threadId,
      turnId: null,
      items: canonical,
      observedAtMs: Date.parse(at),
      turnStatus: "completed",
    });
    return {
      canonical,
      views,
      entries: views.map((view, sequence) =>
        projectCodexItemViewToTranscriptEntry(view, "replay", sequence),
      ),
    };
  };
  const exportHistory = (items: readonly AgentTurnItem[]) =>
    projectAgentRuntimeExportTurns(
      thread,
      items.map((item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      })),
      [],
    );

  test.each(["", "Continue"])(
    "retains opening missing-image metadata when turn params rebuild the user message %j",
    (text) => {
      const unavailable = { name: "missing.png", sourcePath: "/removed/missing.png" };
      const item = message({
        runId: null,
        text,
        attachments: [],
        unavailableImages: [{ ...unavailable, reason: "source_missing" }],
      });
      const turns = exportHistory([item]);

      expect(turns).toHaveLength(1);
      expect(turns[0]?.clientUserMessageId).toBe(item.messageId);
      expect(turns[0]?.items).toHaveLength(1);
      expect(turns[0]?.items[0]).toMatchObject({
        rawItemId: item.id,
        kind: "userMessage",
        markdownText: text,
        unavailableImages: [unavailable],
      });
      expect(turns[0]?.items[0]?.userAttachments ?? []).toEqual([]);
    },
  );

  test.each(["copied", "missing"] as const)(
    "keeps an imported %s image inspection through completed-turn rendering when output is omitted",
    (availability) => {
      const unavailable = { name: "viewed.png", sourcePath: "/removed/viewed.png" };
      const itemId = `view:${availability}`;
      const ownedSource = buildAgentRuntimeAttachmentSource({
        sourceThreadId: base.threadId,
        itemId,
        attachmentId: image.id,
      });
      const turns = exportHistory([
        message({ runId: null }),
        {
          ...base,
          type: "dynamic_tool",
          toolName: "imageView",
          id: itemId,
          runId: null,
          ordinal: 2,
          input: { path: unavailable.sourcePath },
          outputOmitted: true,
          ...(availability === "copied"
            ? { attachments: [image] }
            : { unavailableImages: [{ ...unavailable, reason: "source_missing" as const }] }),
        },
        {
          ...base,
          type: "assistant_message",
          id: "reply",
          messageId: "reply",
          runId: null,
          ordinal: 3,
          text: "Done",
          streaming: false,
        },
      ]);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      const items = buildRendererItemStream({
        entries: turn.items,
        requests: [],
        turnStatus: "completed",
      });
      const inspection = items.find((item) => item.type === "imageView");
      const expected = {
        type: "imageView",
        imageViewPaths: availability === "copied" ? [ownedSource] : [],
        ...(availability === "missing" ? { unavailableImages: [unavailable] } : {}),
      };
      expect(inspection).toMatchObject(expected);

      const buckets = bucketizeTurnItems({ items, turnStatus: "completed" });
      expect(
        buckets.agentItems.map((item) => item.id),
        "bucketizer dropped the inspection",
      ).toContain(itemId);
      const model = buildTurnViewModel({
        turnId: turn.turnId,
        turn,
        buckets,
        isLatestTurn: true,
        isStreamingTurn: false,
        isBlocked: false,
      });
      expect(model.blocks.find((block) => block.type === "imageView")).toMatchObject(expected);
    },
  );

  test("carries assistant Markdown image bindings through history with decoded entity keys and owned targets", () => {
    const sourcePath = "entity&image.png";
    const missingPath = "removed&image.png";
    const text = "![Saved](entity&amp;image.png)\n![Missing](removed&amp;image.png)";
    const ownedSource = buildAgentRuntimeAttachmentSource({
      sourceThreadId: base.threadId,
      itemId: base.id,
      attachmentId: image.id,
    });
    const importedImages = [
      { sourcePath, name: image.name, source: ownedSource },
      { sourcePath: missingPath, name: "removed.png", source: null },
    ];
    const { canonical, views, entries } = projectHistory([
      {
        ...base,
        runId: null,
        type: "assistant_message",
        messageId: "assistant:imported",
        text,
        streaming: false,
        attachments: [image],
        importedImageLinks: [
          { sourcePath, attachmentId: image.id },
          { sourcePath: missingPath, attachmentId: null },
        ],
        unavailableImages: [
          { name: "removed.png", sourcePath: missingPath, reason: "source_missing" },
        ],
      },
    ]);

    expect(canonical[0]).toMatchObject({ type: "agentMessage", text, importedImages });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      normalizedKind: "assistantMessage",
      markdownText: text,
      importedImages,
    });
    expect(entries[0]).toMatchObject({
      kind: "assistantMessage",
      markdownText: text,
      importedImages,
    });
  });
});

describe("Runtime delegated task rows", () => {
  test("created conversations retain their selected model in the transcript", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "thread_created",
        targetThreadId: "child",
        targetRunId: "child-run",
        targetProviderInstanceId: "codex",
        targetModel: "gpt-6.1-sol",
      }),
    ).toEqual({
      type: "subAgentActivity",
      id: "item",
      kind: "started",
      agentThreadId: "child",
      agentPath: "child",
      model: "gpt-6.1-sol",
      reasoningEffort: null,
    });
  });

  test("a task reports its own lifecycle instead of a creation outcome", () => {
    const statuses = (
      ["running", "waiting", "completed", "failed", "interrupted", "cancelled"] as const
    ).map((status) => {
      const projected = projectAgentRuntimeItem(task(status));
      return projected?.type === "delegatedTask" ? projected.status : null;
    });
    expect(statuses).toEqual(["running", "waiting", "completed", "failed", "stopped", "cancelled"]);
  });

  test("rows carry the task identity, owner Run and a readable title", () => {
    expect(projectAgentRuntimeItem(task("running", { progress: "Reading files" }))).toEqual({
      type: "delegatedTask",
      id: "item",
      taskId: "task",
      ownerRunId: "parent-run",
      childThreadId: "child",
      title: "Review the auth module",
      providerInstanceId: "claude",
      status: "running",
      prompt: "Review the auth module\nand report findings",
      summary: "Reading files",
    });
    expect(
      projectAgentRuntimeItem(task("completed", { title: "Audit", result: "No issues" })),
    ).toMatchObject({ title: "Audit", summary: "No issues" });
  });

  test("native path titles become readable names without losing their detail identity", () => {
    const native = task("running", {
      driver: "codex",
      origin: "provider_native",
      title: "/root/reference_bundle",
    });
    expect(projectAgentRuntimeItem(native)).toMatchObject({
      title: "Reference bundle",
      agentPath: "/root/reference_bundle",
      taskId: "task",
      childThreadId: "child",
    });
    const titled = projectAgentRuntimeItem({ ...native, origin: "app_owned" });
    expect(titled).toMatchObject({ title: "/root/reference_bundle" });
    expect(titled).not.toHaveProperty("agentPath");
    expect(native.title).toBe("/root/reference_bundle");
  });
});

describe("Runtime message attribution and notices", () => {
  test("input another Agent sent links to the sending conversation", () => {
    expect(
      projectAgentRuntimeItem(
        message({ createdBy: "agent", creationSource: "mcp", senderThreadId: "parent" }),
      ),
    ).toMatchObject({ origin: { kind: "agent", senderThreadId: "parent" } });
    expect(
      projectAgentRuntimeItem(message({ createdBy: "agent", creationSource: "server" })),
    ).toMatchObject({ origin: { kind: "nodex" } });
    expect(projectAgentRuntimeItem(message({}))).not.toHaveProperty("origin");
  });

  test("steered and queued input keep their delivery intent", () => {
    expect(projectAgentRuntimeItem(message({ inputIntent: "steer" }))).toMatchObject({
      inputIntent: "steer",
    });
    expect(projectAgentRuntimeItem(message({ inputIntent: "queued_turn" }))).toMatchObject({
      inputIntent: "queued",
    });
    expect(projectAgentRuntimeItem(message({ inputIntent: "turn_start" }))).not.toHaveProperty(
      "inputIntent",
    );
  });

  test("reported work names the one task it can open", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "notification",
        source: { kind: "subagent", childThreadId: "child" },
        outcome: "completed",
        summary: 'Subagent "Audit" finished',
      }),
    ).toEqual({
      type: "runtimeNotice",
      id: "item",
      message: 'Subagent "Audit" finished',
      notice: { kind: "report", source: "subagent", outcome: "completed", childThreadId: "child" },
    });
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        summary: "Nodex restarted and resumed this turn",
      }),
    ).toMatchObject({ notice: { kind: "report", source: "system", childThreadId: null } });
  });

  test("a stopped Run ends with one marker; the request bookkeeping stays hidden", () => {
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "run_interrupt_result",
        status: "interrupted",
        message: "Run interrupted by user",
      }),
    ).toMatchObject({ type: "runtimeNotice", message: "Stopped", notice: { kind: "stopped" } });
    expect(
      projectAgentRuntimeItem({ ...base, type: "run_interrupt_request", message: "Stop" }),
    ).toBeNull();
  });

  test("a handoff names the Agents it moved between, never the history it carried", () => {
    const handoff = {
      ...base,
      type: "handoff",
      contextHandoffId: "handoff",
      fromProviderThreadIds: ["codex-thread"],
      toProviderThreadId: "claude-thread",
      fromProviderInstanceIds: ["codex"],
      toProviderInstanceId: "claude",
      toModel: "sonnet",
      strategy: "full_thread_summary",
      summary: "[Historical user; user_message] the whole earlier conversation",
    } as Extract<AgentTurnItem, { type: "handoff" }>;
    expect(
      projectAgentRuntimeItem({
        ...handoff,
        fromModelSelections: [{ instanceId: "codex", model: "gpt" }],
      }),
    ).toEqual({
      type: "runtimeNotice",
      id: "item",
      message: "Context handoff to sonnet",
      notice: {
        kind: "agentHandoff",
        carried: "conversation",
        failed: false,
        from: [{ providerInstanceId: "codex", model: "gpt" }],
        to: { providerInstanceId: "claude", model: "sonnet" },
      },
    });
    // Returning to an Agent carries only what it missed; a merged fork carries the fork's work.
    expect(
      projectAgentRuntimeItem({ ...handoff, strategy: "delta_since_target_last_seen" }),
    ).toMatchObject({ notice: { carried: "missed" } });
    expect(
      projectAgentRuntimeItem({ ...handoff, strategy: "fork_delta_summary", status: "failed" }),
    ).toMatchObject({ notice: { carried: "fork", failed: true } });
    // Without recorded source models the Agents still name the handoff.
    expect(projectAgentRuntimeItem(handoff)).toMatchObject({
      notice: { from: [{ providerInstanceId: "codex", model: null }] },
    });
  });

  test("a cleared context reads as its own notice", () => {
    expect(projectAgentRuntimeItem({ ...base, type: "context_cleared" })).toEqual({
      type: "runtimeNotice",
      id: "item",
      message: "Context cleared",
      notice: { kind: "contextCleared" },
    });
  });
});

describe("Runtime Thoughts", () => {
  const thought = (
    status: AgentTurnItem["status"],
    overrides: Partial<Extract<AgentTurnItem, { type: "reasoning" }>> = {},
  ): Extract<AgentTurnItem, { type: "reasoning" }> => ({
    ...base,
    type: "reasoning",
    title: "Thinking",
    text: "I need to check whether the label clamps.",
    streaming: status === "running",
    status,
    startedAt: "2026-10-15T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-10-15T00:00:12.500Z",
    ...overrides,
  });
  const entryOf = (item: AgentTurnItem, turnStatus: "inProgress" | "completed") => {
    const views = projectCodexCanonicalTurnItemViews({
      threadId: base.threadId,
      turnId: "parent-run",
      items: [projectAgentRuntimeItem(item)!],
      observedAtMs: Date.parse(at),
      turnStatus,
    });
    return projectCodexItemViewToTranscriptEntry(views[0]!, "live", 0);
  };

  test("a streaming Thought is live and reports when it started", () => {
    expect(entryOf(thought("running"), "inProgress")).toMatchObject({
      semanticKind: "reasoning",
      status: "inProgress",
      markdownText: "I need to check whether the label clamps.",
      thought: { startedAtMs: Date.parse("2026-10-15T00:00:00.000Z"), durationMs: null },
    });
  });

  test("a settled Thought reports how long it took, including one its Run stopped", () => {
    for (const status of ["completed", "interrupted"] as const) {
      expect(entryOf(thought(status), "inProgress")).toMatchObject({
        status: "completed",
        thought: { durationMs: 12_500 },
      });
    }
  });
});

describe("Runtime Turn metadata", () => {
  test("hooks stay out of the transcript and read as the Turn's hook runs", () => {
    const hook: Extract<AgentTurnItem, { type: "hook_run" }> = {
      ...base,
      type: "hook_run",
      eventName: "userPromptSubmit",
      source: "project",
      sourcePath: "/workspace/.codex/hooks.json",
      hookStatus: "blocked",
      statusMessage: null,
      entries: [{ kind: "feedback", text: "Fix it before retrying." }],
    };
    expect(isAgentRuntimeItemHidden(hook)).toBe(true);
    expect(projectAgentRuntimeHookRun(hook).run).toMatchObject({
      eventName: "userPromptSubmit",
      source: "project",
      status: "blocked",
      entries: [{ kind: "feedback", text: "Fix it before retrying." }],
    });
  });
  test("reviews, cited memory and command reads keep what the reply footer reads", () => {
    expect(
      projectAgentRuntimeItem(
        {
          ...base,
          type: "approval_review",
          targetItemId: null,
          actionKind: "command",
          actionSummary: "touch protected.txt",
          decision: "denied",
          riskLevel: "low",
          userAuthorization: "low",
          rationale: "Not requested.",
        },
        "/workspace",
      ),
    ).toMatchObject({
      type: "automaticApprovalReview",
      action: { type: "command", command: "touch protected.txt" },
      status: "denied",
      rationale: "Not requested.",
    });
    const citation = {
      entries: [{ path: "MEMORY.md", lineStart: 2, lineEnd: 4, note: "Convention." }],
      threadIds: [],
    };
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "assistant_message",
        messageId: "reply",
        text: "Done.",
        streaming: false,
        memoryCitation: citation,
      }),
    ).toMatchObject({ type: "agentMessage", memoryCitation: citation });
    const read = {
      type: "read",
      command: "cat SKILL.md",
      name: "SKILL.md",
      path: "/w/SKILL.md",
    } as const;
    expect(
      projectAgentRuntimeItem({
        ...base,
        type: "command_execution",
        input: "cat SKILL.md",
        commandActions: [read],
      }),
    ).toMatchObject({ type: "commandExecution", commandActions: [read] });
  });
});

describe("Runtime user messages", () => {
  test("show only what the user wrote, never the app data sent beside it", () => {
    const projected = projectAgentRuntimeItem(
      message({
        text: "Use the selected variant\n\n[Visualization changes](t3-context://v1/nodex-app-context/0123abcd)",
      }),
    );
    expect(projected).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: "Use the selected variant" }],
    });
  });
});

describe("Runtime context compaction", () => {
  const compaction = (
    overrides: Partial<Extract<AgentTurnItem, { type: "compaction" }>>,
  ): Extract<AgentTurnItem, { type: "compaction" }> => ({
    ...base,
    type: "compaction",
    driver: "codex",
    ...overrides,
  });

  test("keeps the Run's trigger and live start for the compaction row", () => {
    expect(projectAgentRuntimeItem(compaction({ trigger: "manual" }))).toEqual({
      type: "contextCompaction",
      id: "item",
      completed: true,
      source: "manual",
      startedAtMs: Date.parse(at),
    });
    expect(
      projectAgentRuntimeItem(compaction({ status: "running", completedAt: null })),
    ).toMatchObject({ completed: false, source: "automatic" });
  });
});

test("projects saved selected-text context even when the user sent no prose", async () => {
  const selection = { id: "selected", text: "Earlier response" };
  const prepared = await prepareAgentMessage(
    "",
    { text: "", selectedTextAttachments: [selection] },
    async () => "",
  );
  const canonical = projectAgentRuntimeItem(
    message({ text: prepared.text, context: prepared.context }),
  );
  if (!canonical) throw new Error("Expected selected-text message");
  const views = projectCodexCanonicalTurnItemViews({
    threadId: "parent",
    turnId: "parent-run",
    items: [canonical],
    observedAtMs: 1,
    turnStatus: "completed",
  });
  const entry = projectCodexItemViewToTranscriptEntry(views[0]!, "bootstrap", 1);
  expect(entry.markdownText).toBe("");
  expect(entry.textSelections?.selectedTextAttachments).toEqual([selection]);
});

describe("Runtime file changes", () => {
  const fileChange = (
    overrides: Partial<Extract<AgentTurnItem, { type: "file_change" }>>,
  ): Extract<AgentTurnItem, { type: "file_change" }> => ({
    ...base,
    type: "file_change",
    fileName: "/repo/src/app.ts",
    ...overrides,
  });
  const rows = (item: AgentTurnItem) => {
    const [view] = projectCodexCanonicalTurnItemViews({
      threadId: base.threadId,
      turnId: base.runId,
      items: [projectAgentRuntimeItem(item)!],
      observedAtMs: Date.parse(at),
      turnStatus: "completed",
    });
    return buildCodexFileChangePatchRows(view?.fileChange?.changes).map((row) => ({
      path: row.path,
      action: row.action,
      type: row.change.type,
      counts: row.summary && { additions: row.summary.additions, deletions: row.summary.deletions },
    }));
  };

  test("shows every recorded file with its own operation and measured lines", () => {
    expect(
      rows(
        fileChange({
          changes: [
            {
              operation: "modify",
              path: "/repo/src/app.ts",
              diff: "@@ -66,3 +66,4 @@\n   const a =\n-    old;\n+    new;\n+    more;\n   return a;\n",
              additions: 2,
              deletions: 1,
            },
            {
              operation: "add",
              path: "/repo/src/new.ts",
              diff: "one\ntwo\n",
              additions: 2,
              deletions: 0,
            },
            {
              operation: "move",
              oldPath: "/repo/src/old-name.ts",
              path: "/repo/src/new-name.ts",
              diff: "@@ -1 +1 @@\n-a\n+b\n",
              additions: 1,
              deletions: 1,
            },
            {
              operation: "delete",
              path: "/repo/src/gone.ts",
              diff: "bye\n",
              additions: 0,
              deletions: 1,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        path: "/repo/src/app.ts",
        action: "edit",
        type: "update",
        counts: { additions: 2, deletions: 1 },
      },
      {
        path: "/repo/src/new.ts",
        action: "create",
        type: "add",
        counts: { additions: 2, deletions: 0 },
      },
      {
        path: "/repo/src/old-name.ts",
        action: "edit",
        type: "update",
        counts: { additions: 1, deletions: 1 },
      },
      {
        path: "/repo/src/gone.ts",
        action: "delete",
        type: "delete",
        counts: { additions: 0, deletions: 1 },
      },
    ]);
  });

  test("keeps measured lines for a diff the Runtime withheld, and never invents an empty change", () => {
    expect(
      rows(
        fileChange({
          changes: [
            { operation: "modify", path: "/repo/src/app.ts", additions: 300, deletions: 12 },
          ],
        }),
      ),
    ).toEqual([
      {
        path: "/repo/src/app.ts",
        action: "edit",
        type: "nonRenderable",
        counts: { additions: 300, deletions: 12 },
      },
    ]);
    // An item recorded without its files names one file whose diff is unknown, not +0 -0.
    expect(rows(fileChange({}))).toEqual([
      { path: "/repo/src/app.ts", action: "edit", type: "nonRenderable", counts: null },
    ]);
  });

  test("prefers the lines the Runtime measured over a recount of the delivered diff", () => {
    // Past the inline parse budget a line scan would skip the removed `-- note` lines.
    const removed = Array.from({ length: 6_000 }, (_, index) =>
      index % 2 === 0 ? "--- note" : "-select 1;",
    );
    expect(
      rows(
        fileChange({
          changes: [
            {
              operation: "modify",
              path: "/repo/db/seed.sql",
              diff: `@@ -1,6000 +0,0 @@\n${removed.join("\n")}\n`,
              additions: 0,
              deletions: 6_000,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        path: "/repo/db/seed.sql",
        action: "edit",
        type: "update",
        counts: { additions: 0, deletions: 6_000 },
      },
    ]);
  });

  test("shows a failed edit's provider error where its diff would be", () => {
    const error = "String to replace not found";
    const expected = {
      type: "fileChange",
      status: "failed",
      changes: [
        { path: "/repo/src/app.ts", kind: { type: "update", move_path: null }, diff: error },
      ],
    };
    expect(projectAgentRuntimeItem(fileChange({ status: "failed", diffStr: error }))).toMatchObject(
      expected,
    );
    expect(
      projectAgentRuntimeItem(
        fileChange({
          status: "failed",
          diffStr: error,
          changes: [{ operation: "modify", path: "/repo/src/app.ts" }],
        }),
      ),
    ).toMatchObject(expected);
  });
});
