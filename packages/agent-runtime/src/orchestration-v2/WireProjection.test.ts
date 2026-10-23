import {
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
  projectStoredEventForWire,
  assertPublicWirePayloadBudget,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import { MAX_TOOL_OUTPUT_IMAGES, toolOutputImages } from "@t3tools/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("persists exact MCP results while history withholds bodies and detail retains indexed image markers", () => {
    const call = {
      type: "mcpToolCall" as const,
      id: "native-js-call",
      server: "node_repl",
      tool: "js",
      status: "completed" as const,
      arguments: { title: "Inspect page", code: "capture()" },
      result: {
        content: [
          { type: "text", text: "Before" },
          {
            type: "image",
            mimeType: "image/png",
            data: "AQID",
            annotations: { audience: ["user"] },
          },
          { type: "text", text: "After" },
        ],
        structuredContent: { width: 1200 },
        _meta: { "codex/toolSurface": { kind: "browser", browser: "chrome" } },
        extension: { retained: true },
      },
    };
    const persisted = decodeTurnItem({ ...base, mcpToolCall: call });
    expect(decodeTurnItemJson(encodeTurnItemJson(persisted))).toMatchObject({ mcpToolCall: call });
    const history = projectTurnItemForWire(persisted);
    expect(history).toMatchObject({
      outputOmitted: true,
      mcpToolCall: { result: { content: [], _meta: call.result._meta } },
    });
    expect(JSON.stringify(history)).not.toContain("AQID");
    const detail = projectTurnItemForDetail(persisted);
    expect(detail).toMatchObject({
      mcpToolCall: {
        result: {
          content: [
            call.result.content[0],
            { type: "image", mimeType: "image/png", annotations: { audience: ["user"] } },
            call.result.content[2],
          ],
          structuredContent: call.result.structuredContent,
          _meta: call.result._meta,
          extension: call.result.extension,
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain("AQID");
    expect(persisted).toMatchObject({ mcpToolCall: call });
  });

  it("bounds huge MCP results without shifting later image content positions", () => {
    const item = decodeTurnItem({
      ...base,
      mcpToolCall: {
        type: "mcpToolCall",
        id: "native-large",
        server: "node_repl",
        tool: "js",
        status: "completed",
        arguments: {},
        result: {
          content: [
            { type: "text", text: "x".repeat(400_000) },
            { type: "image", mimeType: "image/png", data: "AQID" },
          ],
        },
      },
    });
    const detail = projectTurnItemForDetail(item);
    expect(detail).toMatchObject({
      mcpToolCall: {
        result: { content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(270_000);
    expect(JSON.stringify(detail)).toContain("output truncated for transport");
  });

  it("keeps dynamic result image indexes after truncation and preserves remote image URLs", () => {
    const output = [
      { type: "inputText", text: "x".repeat(400_000) },
      { type: "inputImage", imageUrl: "data:image/png;base64,AQID" },
    ];
    expect(projectTurnItemForDetail({ ...base, output })).toMatchObject({
      output: [{ type: "text" }, { type: "inputImage" }],
    });
    const remote = [{ type: "inputImage", imageUrl: "https://example.test/image.png" }];
    expect(projectTurnItemForDetail({ ...base, output: remote })).toMatchObject({ output: remote });
    expect(output[1]).toEqual({ type: "inputImage", imageUrl: "data:image/png;base64,AQID" });
  });

  it("bounds arbitrary protocol metadata without losing required native call identity", () => {
    const item = decodeTurnItem({
      ...base,
      mcpToolCall: {
        type: "mcpToolCall",
        id: "native-large-meta",
        server: "node_repl",
        tool: "js",
        status: "completed",
        arguments: {},
        futureExtension: "x".repeat(400_000),
        result: { content: [], futureExtension: "x".repeat(400_000) },
      },
    });
    for (const projected of [projectTurnItemForWire(item), projectTurnItemForDetail(item)]) {
      expect(decodeTurnItemJson(encodeTurnItemJson(projected))).toMatchObject({
        mcpToolCall: { id: "native-large-meta", server: "node_repl", tool: "js" },
      });
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(20_000);
    }
  });

  it("encodes only task metadata while execution retains giant bodies and delivery state", () => {
    const body = "private task body ".repeat(1_100_000);
    const stored = {
      sequence: 1,
      commandId: null,
      event: {
        id: EventId.make("large-task-event"),
        type: "subagent.updated" as const,
        threadId: base.threadId,
        occurredAt: base.updatedAt,
        payload: {
          id: NodeId.make("large-task"),
          threadId: base.threadId,
          runId: null,
          parentNodeId: NodeId.make("root"),
          origin: "app_owned" as const,
          createdBy: "agent" as const,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          providerThreadId: null,
          childThreadId: ThreadId.make("child"),
          nativeTaskRef: null,
          prompt: body,
          result: body,
          progress: body,
          title: "Inspect",
          model: null,
          completionWake: "always" as const,
          completionDelivery: { state: "pending" as const, observedByRunId: null },
          workflow: {
            phases: [],
            agents: [{ index: 0, label: "Agent", state: "completed" as const, result: body }],
          },
          status: "completed" as const,
          startedAt: base.startedAt,
          completedAt: base.completedAt,
          updatedAt: base.updatedAt,
        },
      },
    };
    const projected = projectStoredEventForWire(stored);
    const encoded = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2StoredEvent))(projected);
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(2_048);
    expect(projected.event.payload).toMatchObject({
      prompt: "",
      result: null,
      childThreadId: "child",
    });
    expect(projected.event.payload).not.toHaveProperty("workflow");
    expect(projected.event.payload).not.toHaveProperty("completionDelivery");
    expect(stored.event.payload.prompt).toBe(body);
    expect(stored.event.payload.result).toBe(body);
    expect(stored.event.payload.completionDelivery.state).toBe("pending");
    expect(stored.event.payload.workflow.agents[0]?.result).toBe(body);
  });

  it("bounds growing conversation text before codec and notification without changing execution", () => {
    const stored = {
      sequence: 1,
      commandId: null,
      event: {
        id: EventId.make("large-message"),
        type: "message.updated" as const,
        threadId: base.threadId,
        occurredAt: base.updatedAt,
        payload: {
          id: MessageId.make("large-message"),
          threadId: base.threadId,
          runId: null,
          nodeId: null,
          role: "assistant" as const,
          text: "x".repeat(2 * 1_048_576),
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          createdAt: base.startedAt,
          updatedAt: base.updatedAt,
        },
      },
    };
    const projected = projectStoredEventForWire(stored);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(140_000);
    expect(stored.event.payload.text.length).toBe(2 * 1_048_576);
    expect(() => assertPublicWirePayloadBudget({ metadata: stored.event.payload.text })).toThrow(
      "public stream transport budget",
    );
  });
  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("preserves provider notices in bounded items and live events", () => {
    const item = {
      ...base,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    expect(projectTurnItemForWire(item)).toEqual(item);
    const event = {
      id: EventId.make("notice-wire-event"),
      type: "turn-item.updated" as const,
      threadId: item.threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
    expect(projectDomainEventForWire(event)).toEqual(event);
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected).not.toHaveProperty("output");
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it.each([
    [" \t\r\n\n  first\t line  \r\n" + "x\n".repeat(10_000), "first line"],
    [" \n".repeat(10_000), "Large tool output"],
    ["a".repeat(160) + "\n" + "x".repeat(20_000), "a".repeat(160)],
    ["a".repeat(161) + "\n" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["a".repeat(159) + "\t b" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["  café\u00a0\u2003😀 \t\r\n" + "x".repeat(20_000), "café 😀"],
  ])("preserves bounded input summary normalization for case %#", (input, summary) => {
    const projected = projectTurnItemForWire({ ...base, input });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary,
      truncated: true,
    });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("serializes an oversized structured input only once for its summary", () => {
    let serializations = 0;
    const input = {
      toJSON() {
        serializations += 1;
        return { text: "x".repeat(100_000) };
      },
    };
    const projected = projectTurnItemForWire({ ...base, input });
    expect(serializations).toBe(1);
    expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
      truncated: true,
    });
  });

  it("withholds task bodies from activity and bounds explicit detail at a UTF-8 boundary", () => {
    const progress = "a".repeat(262_143) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect code",
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).toMatchObject({ prompt: "", result: null });
    expect(projected).not.toHaveProperty("progress");
    const detail = projectTurnItemForDetail(item);
    expect(detail.type === "subagent" ? detail.progress : null).toBe(
      "a".repeat(262_143) + "\n… output truncated for transport",
    );
    expect(item.progress).toBe(progress);
  });

  it.each(["", "small output", "x".repeat(1_048_576)])(
    "omits command output of every size, case %#",
    (output) => {
      const item = { ...base, type: "command_execution" as const, input: "test", output };
      const projected = projectTurnItemForWire(item);
      expect(projected).not.toHaveProperty("output");
      expect(projected).toMatchObject({ input: "test", status: "completed" });
      // Clients fetch withheld output on demand, so they need to know it exists.
      expect(projected.type === "command_execution" ? projected.outputOmitted : null).toBe(
        output ? true : undefined,
      );
      expect(item.output).toBe(output);
    },
  );

  it.each([
    ["echo ok", "echo ok"],
    ["a".repeat(262_143) + "😀", "a".repeat(262_143) + "\n… output truncated for transport"],
  ])("bounds fetched command input without changing persistence, case %#", (input, expected) => {
    const item = { ...base, type: "command_execution" as const, input, output: "ok" };
    const projected = projectTurnItemForDetail(item);
    expect(projected).toMatchObject({ input: expected, output: "ok" });
    expect(item.input).toBe(input);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3-code__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    // The truncated text block plus a fixed number of markers, however many images there are.
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    // A failed edit keeps the provider's error so expanding the row can show it.
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("keeps the identity of a chat a tool created, so its row can open it", () => {
    const item = {
      ...base,
      toolName: "nodex_app.create_session",
      output: {
        content: [{ type: "text", text: "PRIVATE_BODY" }],
        structuredContent: {
          sessionId: "created-session",
          threadId: "created-thread",
          launchState: "attached",
        },
      },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    expect(projected).toMatchObject({
      output: { sessionId: "created-session", threadId: "created-thread" },
      outputOmitted: true,
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
  });

  it("does not serialize raw dynamic output to discard it", () => {
    const output = {
      toJSON: () => {
        throw new Error("Raw output must not be serialized");
      },
    };
    expect(projectTurnItemForWire({ ...base, output })).not.toHaveProperty("output");
  });
});
