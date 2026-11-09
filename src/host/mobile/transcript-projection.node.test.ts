import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { ChatItem, ChatSnapshot } from "@nodex/mobile-protocol";
import { describe, expect, test } from "vitest";
import {
  approvalOptions,
  boundChatItem,
  chatItemId,
  chatPatch,
  parseChatItemId,
  projectNativeItem,
  projectRequests,
  runtimeItemProjector,
  runtimeActivity,
  transcriptWindow,
  utf8Tail,
} from "./transcript-projection";

const projectRuntimeItem = runtimeItemProjector("posix");
import { parseAttachmentRef } from "./files";

const at = "2026-11-04T12:00:00.000Z";
const base = {
  id: "item",
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
} as const;

const assistant = (id: string, text: string): ChatItem => ({
  kind: "assistant",
  id,
  at,
  text,
  streaming: true,
  truncated: false,
  unavailableImages: [],
});
const snapshot = (items: ChatItem[]): ChatSnapshot => ({
  sessionId: "chat",
  revision: 0,
  title: "Title",
  projectName: null,
  items,
  historyCursor: null,
  state: {
    status: "running",
    activeRunId: "run",
    queuedCount: 0,
    requests: [],
    agentLabel: null,
    sendBlockedReason: null,
    stopBlockedReason: null,
    archived: false,
    canManage: true,
  },
});

describe("Mobile transcript", () => {
  test.each([
    [{ ...base, type: "command_execution", input: "echo hi", output: "hi" }, "command"],
    [{ ...base, type: "file_change", fileName: "a.md", diffStr: "+ added" }, "file"],
    [{ ...base, type: "file_search", pattern: "notes" }, "search"],
    [{ ...base, type: "web_search", patterns: ["notes"] }, "web"],
    [
      { ...base, type: "dynamic_tool", toolName: "read_page", input: {}, output: { id: 3 } },
      "tool",
    ],
    [
      {
        ...base,
        type: "subagent",
        subagentId: "child",
        childThreadId: "child-thread",
        driver: "codex",
        providerInstanceId: "codex",
        origin: "app_owned",
        prompt: "Read the Page",
        result: "Done",
      },
      "agent",
    ],
    [
      { ...base, type: "proposed_plan", planId: "plan", markdown: "Steps", streaming: false },
      "plan",
    ],
  ] as const)("projects a work category", (item, category) => {
    expect(projectRuntimeItem("chat", item satisfies AgentTurnItem)).toMatchObject({
      kind: "activity",
      category,
      at,
    });
  });

  test("a message reads as arriving only while its own run is live", () => {
    const message = {
      ...base,
      type: "assistant_message",
      messageId: "message",
      text: "Half a repl",
      streaming: true,
    } satisfies AgentTurnItem;
    const streaming = (activeRunId: string | null) =>
      projectRuntimeItem("chat", message, undefined, undefined, { activeRunId });
    expect(streaming(message.runId)).toMatchObject({ kind: "assistant", streaming: true });
    expect(streaming("the-run-that-resumed-it")).toMatchObject({ streaming: false });
    expect(streaming(null)).toMatchObject({ streaming: false });
  });

  test("preserves queued messages and inherited item coordinates", () => {
    const item = projectRuntimeItem(
      "chat",
      {
        ...base,
        type: "user_message",
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "queued_turn",
        messageId: "message",
        text: "Read this",
        attachments: [],
      },
      "ancestor",
      "source-item",
      { queued: true },
    );
    expect(item).toMatchObject({ kind: "user", queued: true, files: [] });
    if (!item) throw new Error("A user message is always shown");
    expect(parseChatItemId(item.id)).toEqual(["ancestor", "source-item", null]);
    expect(parseChatItemId(item.id + "=")).toBeNull();
    expect(chatItemId("ancestor", "source-item")).toBe(item.id);
  });

  test("keeps valid UTF-8 tails and makes the older window resumable", () => {
    expect(utf8Tail("a🙂b", 4)).toEqual({ text: "b", truncated: true });
    expect(utf8Tail("a🙂b", 5)).toEqual({ text: "🙂b", truncated: true });
    const rows = Array.from({ length: 100 }, (_, index) => ({
      item: assistant(String(index), "a"),
      cursor: String(index),
    }));
    const small = transcriptWindow(rows, false);
    expect(small.items).toHaveLength(80);
    expect(small.items[0]?.id).toBe("79");
    expect(small.items.at(-1)?.id).toBe("0");
    expect(small.historyCursor).toBe("79");
    const large = transcriptWindow(
      rows.map((row) => ({
        ...row,
        item: assistant(row.item.id, "a".repeat(80 * 1024) + "tail"),
      })),
      false,
    );
    expect(large.items).toHaveLength(3);
    expect(large.historyCursor).toBe("2");
    expect(large.items[0]).toMatchObject({ kind: "assistant", truncated: true });
    expect(Buffer.byteLength(JSON.stringify(large.items))).toBeLessThan(256 * 1024);
    const command = projectRuntimeItem("chat", {
      ...base,
      type: "command_execution",
      input: "echo",
      output: "x".repeat(4096) + "tail",
    });
    if (!command) throw new Error("A command is always shown");
    expect(boundChatItem(command)).toMatchObject({
      outputTruncated: true,
      output: expect.stringMatching(/tail$/u),
    });
  });

  test("appends a UTF-16 suffix and upserts after replacement or settlement", () => {
    const previous = snapshot([assistant("item", "🙂")]);
    const added = assistant("item", "🙂 more");
    expect(chatPatch(previous, snapshot([added]))).toEqual([
      { op: "append", itemId: "item", offset: 2, text: " more" },
    ]);
    const replaced = assistant("item", "Different");
    expect(chatPatch(previous, snapshot([replaced]))).toEqual([{ op: "upsert", item: replaced }]);
    const done = { ...added, streaming: false };
    expect(chatPatch(previous, snapshot([done]))).toEqual([{ op: "upsert", item: done }]);
  });

  test("preserves provider option identities and elevates a pending approval", () => {
    const options = approvalOptions({
      ...base,
      type: "approval_request",
      requestId: "request",
      requestKind: "command",
      options: [
        { label: "Allow once", decision: "accept", optionId: "once" },
        { label: "Allow this workspace", decision: "accept", optionId: "workspace" },
      ],
    });
    expect(options.map(({ optionId }) => optionId)).toEqual(["once", "workspace"]);
    expect(options[0]?.id).not.toBe(options[1]?.id);
    expect(
      runtimeActivity({
        sessionId: "chat",
        threadId: "thread",
        status: "running",
        activeRunId: "run",
        pendingRequestCount: 1,
        approvalPrompt: "Run git status?",
        backgroundTasks: [],
        providerInstanceId: "agent",
        model: "model",
        updatedAt: at,
      }),
    ).toEqual({
      sessionId: "chat",
      status: "waiting",
      pendingRequestCount: 1,
      attention: "Run git status?",
    });
  });
});

describe("a step's pictures", () => {
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPQzrkJRwzEcQBLchcBrdrRDQAAAABJRU5ErkJggg==";
  const tool = (fields: Record<string, unknown>) =>
    ({
      ...base,
      id: "tool-item",
      threadId: "fork",
      type: "dynamic_tool",
      toolName: "screenshot",
      input: {},
      ...fields,
    }) as AgentTurnItem;
  const project = (item: AgentTurnItem) => {
    const projected = projectRuntimeItem("chat", item, "source-thread", "source-item");
    if (projected?.kind !== "activity") throw new Error("A tool call is a step");
    return projected;
  };
  const located = (images: readonly { ref: string }[]) =>
    images.map(({ ref }) => parseAttachmentRef(ref));

  const returned = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      attachmentId: `tool-result:${index + 1}`,
      mimeType: "image/png",
    }));

  test("a tool's returned pictures are named as every Runtime read lists them, never as text", () => {
    const screenshot = "A".repeat(2 * 1024 * 1024);
    // A full read still holds the bytes; the Runtime names the pictures it would serve.
    const step = project(
      tool({
        mcpToolCall: {
          type: "mcpToolCall",
          id: "call",
          server: "browser",
          tool: "screenshot",
          status: "completed",
          arguments: {},
          result: {
            content: [
              { type: "text", text: "Captured the page." },
              { type: "image", data: screenshot, mimeType: "image/png" },
            ],
            structuredContent: null,
          },
        },
        resultImages: returned(1),
      }),
    );
    expect(step.output).toBe("Captured the page.");
    expect(step.images).toEqual([
      { ref: expect.any(String), name: "Tool output", mimeType: "image/png", size: null },
    ]);
    // The host's attachment owner reads the recorded block at that position, for the Member.
    expect(located(step.images)).toEqual([
      ["chat", "source-thread", "source-item", "tool-result:1"],
    ]);
    expect(Buffer.byteLength(JSON.stringify(step))).toBeLessThan(4 * 1024);
  });

  test("a transcript window names a few of a step's pictures, and the opened step the rest", () => {
    // A window item has no output, only the names.
    const step = project(tool({ outputOmitted: true, resultImages: returned(12) }));
    expect(located(step.images).map((locator) => locator?.[3])).toEqual(
      returned(8).map(({ attachmentId }) => attachmentId),
    );
    const windowed = boundChatItem(step);
    if (windowed.kind !== "activity") throw new Error("A step stays a step");
    expect(located(windowed.images).map((locator) => locator?.[3])).toEqual([
      "tool-result:1",
      "tool-result:2",
      "tool-result:3",
      "tool-result:4",
    ]);
    expect(step.output).toBeNull();
  });

  test("a picture an Agent viewed shows the copy it kept, in the window as in the step", () => {
    const copy = {
      type: "image",
      id: "viewed-copy",
      name: "chart.png",
      mimeType: "image/png",
      sizeBytes: 68,
    };
    const viewed = tool({
      toolName: "Read",
      title: "Read chart.png",
      viewedImagePath: "/Users/someone/chart.png",
      attachments: [
        copy,
        { type: "file", id: "notes", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 },
      ],
    });
    const full = project({
      ...viewed,
      output: [{ type: "image", data: PNG, mimeType: "image/png" }],
    } as AgentTurnItem);
    // A transcript window carries no tool output; the copy is the item's own attachment.
    const window = project({ ...viewed, outputOmitted: true } as AgentTurnItem);
    for (const step of [full, window]) {
      expect(step.images).toEqual([
        { ref: expect.any(String), name: "chart.png", mimeType: "image/png", size: 68 },
      ]);
      expect(located(step.images)).toEqual([
        ["chat", "source-thread", "source-item", "viewed-copy"],
      ]);
    }
    expect(window.output).toBeNull();
  });

  test("a result whose shape matters keeps it, without the picture's bytes", () => {
    const step = project(
      tool({
        output: {
          content: [{ type: "image", data: PNG, mimeType: "image/png" }],
          structuredContent: { width: 4 },
        },
      }),
    );
    expect(JSON.parse(step.output ?? "null")).toEqual({
      content: [{ type: "image" }],
      structuredContent: { width: 4 },
    });
    // The attachment owner reads only an MCP result or a list of blocks, so none is offered.
    expect(step.images).toEqual([]);
  });
});

describe("a connected conversation's pictures", () => {
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGPQzrkJRwzEcQBLchcBrdrRDQAAAABJRU5ErkJggg==";
  const project = (item: Record<string, unknown>, runId: string | null = "run") =>
    projectNativeItem("chat", "codex-thread", runId, item as unknown as ThreadItem);
  const located = (images: readonly { ref: string }[]) =>
    images.map(({ ref }) => parseAttachmentRef(ref) ?? ref);

  test("its desktop reads the pictures a message carries, by their place in it", () => {
    const message = project({
      type: "userMessage",
      id: "message",
      content: [
        { type: "text", text: "Compare these", text_elements: [] },
        { type: "localImage", path: "/Users/someone/Desktop/before.png" },
        { type: "image", url: `data:image/png;base64,${PNG}` },
        { type: "image", url: "https://example.test/after.png" },
        { type: "localImage", path: "screens/relative.png" },
      ],
    });
    if (message.kind !== "user") throw new Error("A message is a message");
    expect(message.text).toBe("Compare these");
    expect(located(message.files)).toEqual([
      ["chat", "codex-thread", "message", "input:1", "run"],
      ["chat", "codex-thread", "message", "input:2", "run"],
      "https://example.test/after.png",
    ]);
    expect(message.files.map(({ name }) => name)).toEqual([
      "before.png",
      "Attached image",
      "Attached image",
    ]);
    expect(message.unavailableImages).toEqual([
      { name: "relative.png", reason: "This picture isn't saved where the desktop can read it." },
    ]);
  });

  test("a step shows what the Agent viewed, generated or got back, never as text", () => {
    const viewed = project({ type: "imageView", id: "view", path: "/tmp/chart.png" });
    expect(viewed).toMatchObject({
      kind: "activity",
      title: "View image",
      detail: "/tmp/chart.png",
    });
    if (viewed.kind !== "activity") throw new Error("A view is a step");
    expect(located(viewed.images)).toEqual([["chat", "codex-thread", "view", "image", "run"]]);

    const returned = project({
      type: "mcpToolCall",
      id: "call",
      server: "browser",
      tool: "screenshot",
      status: "completed",
      arguments: {},
      result: {
        content: [
          { type: "text", text: "Captured." },
          { type: "image", data: PNG.repeat(4096), mimeType: "image/png" },
        ],
        structuredContent: null,
      },
      error: null,
    });
    if (returned.kind !== "activity") throw new Error("A tool call is a step");
    expect(returned.output).toBe("Captured.");
    expect(located(returned.images)).toEqual([
      ["chat", "codex-thread", "call", "content:1", "run"],
    ]);
    expect(Buffer.byteLength(JSON.stringify(returned))).toBeLessThan(4 * 1024);
  });

  test("a picture its desktop cannot read is named with the reason, not left out", () => {
    const generated = project({
      type: "imageGeneration",
      id: "generated",
      status: "completed",
      revisedPrompt: "A lighthouse at dusk",
      failure: null,
      fileId: "file-provider",
    });
    expect(generated).toMatchObject({
      kind: "activity",
      title: "Generate image",
      detail: "A lighthouse at dusk",
      images: [],
      unavailableImages: [
        {
          name: "Picture",
          reason: "Codex keeps this picture with its provider; the desktop has no copy.",
        },
      ],
    });
    // Without its Run, the item cannot be read again to fetch the picture.
    expect(project({ type: "imageView", id: "view", path: "/tmp/chart.png" }, null)).toMatchObject({
      images: [],
      unavailableImages: [{ name: "chart.png" }],
    });
  });
});

describe("an imported conversation's pictures", () => {
  test("an imported reply shows the copies the Runtime kept, and names a gone picture", () => {
    const copy = (id: string, name: string) => ({
      type: "image",
      id,
      name,
      mimeType: "image/png",
      sizeBytes: 64,
    });
    const reply = projectRuntimeItem(
      "chat",
      {
        ...base,
        id: "reply",
        type: "assistant_message",
        messageId: "reply",
        streaming: false,
        text: [
          "Before ![Old chart](/Users/me/before.png) and ![After][after].",
          "Gone: ![Lost](/Users/me/lost.png)",
          "[after]: /Users/me/after%20one.png",
        ].join("\n\n"),
        attachments: [
          copy("copy-before", "before.png"),
          copy("copy-after", "after one.png"),
          copy("generated", "generated.png"),
        ],
        importedImageLinks: [
          { sourcePath: "/Users/me/before.png", attachmentId: "copy-before" },
          { sourcePath: "/Users/me/after%20one.png", attachmentId: "copy-after" },
          { sourcePath: "/Users/me/lost.png", attachmentId: null },
        ],
        unavailableImages: [
          { name: "lost.png", sourcePath: "/Users/me/lost.png", reason: "source_missing" },
        ],
      } as unknown as AgentTurnItem,
      "source-thread",
      "source-item",
    );
    if (reply?.kind !== "assistant") throw new Error("A reply is a reply");
    const pictures = [...reply.text.matchAll(/!\[([^\]]*)\]\(<?([^)>]+)>?\)/gu)].map(
      ([, alt, url]) => [alt, parseAttachmentRef(url ?? "")?.[3] ?? url],
    );
    // Each picture shows from the copy, through the chat's one attachment owner; the reply's own
    // attachment that no link names still follows it once.
    expect(pictures).toEqual([
      ["Old chart", "copy-before"],
      ["After", "copy-after"],
      ["", "generated"],
    ]);
    // A reference's definition line shows nothing; no picture still names a local file.
    expect(reply.text).not.toMatch(/!\[[^\]]*\]\(<?\/Users/u);
    expect(reply.unavailableImages).toEqual([
      { name: "lost.png", reason: "Its original file is missing." },
    ]);
  });

  test("a reply's own pictures from this host's files are read from the host", () => {
    const reply = projectRuntimeItem(
      "chat",
      {
        ...base,
        id: "reply",
        type: "assistant_message",
        messageId: "reply",
        streaming: false,
        text: [
          "![Luna](/srv/crew/luna-star.png) beside ![Plot](plot.png)",
          "and ![Web](https://example.com/web.png)",
        ].join("\n\n"),
        attachments: [],
      } as unknown as AgentTurnItem,
      "source-thread",
      "source-item",
    );
    if (reply?.kind !== "assistant") throw new Error("A reply is a reply");
    const pictures = [...reply.text.matchAll(/!\[([^\]]*)\]\(<?([^)>]+)>?\)/gu)].map(
      ([, alt, url]) => [alt, parseAttachmentRef(url ?? "") ?? url],
    );
    // A phone has none of the host's files; it reads each picture from the host as the Member.
    expect(pictures).toEqual([
      ["Luna", ["chat", "source-thread", "source-item", "reply-picture:/srv/crew/luna-star.png"]],
      ["Plot", ["chat", "source-thread", "source-item", "reply-picture:plot.png"]],
      ["Web", "https://example.com/web.png"],
    ]);
  });

  test("an imported message names each picture whose file was already gone", () => {
    const message = projectRuntimeItem("chat", {
      ...base,
      type: "user_message",
      createdBy: "user",
      creationSource: "import",
      inputIntent: "turn",
      messageId: "message",
      text: "Before",
      attachments: [],
      unavailableImages: [
        { name: "before.png", sourcePath: "/gone/before.png", reason: "source_missing" },
      ],
    } as unknown as AgentTurnItem);
    expect(message).toMatchObject({
      kind: "user",
      unavailableImages: [{ name: "before.png", reason: "Its original file is missing." }],
    });
  });
});

describe("pending requests", () => {
  // A real snapshot carries its items only as display rows.
  const snapshotOf = (items: readonly unknown[], requests: readonly unknown[]) =>
    ({
      turnItems: [],
      visibleTurnItems: (items as readonly { id: string }[]).map((item) => ({
        item,
        sourceItemId: item.id,
        sourceThreadId: "thread",
      })),
      runtimeRequests: requests,
    }) as unknown as AgentSnapshot["projection"];
  const live = (id: string, status = "pending") => ({
    id,
    status,
    responseCapability: { type: "live" },
  });
  const approval = (overrides: Record<string, unknown> = {}) => ({
    ...base,
    id: "approval",
    type: "approval_request",
    requestId: "request",
    requestKind: "command",
    prompt: "touch ~/file",
    status: "waiting",
    ...overrides,
  });

  test("finds an approval in the snapshot's rows, refusal first and the exact command shown", () => {
    const [request] = projectRequests(
      snapshotOf(
        [
          approval({
            options: [
              { decision: "accept", label: "Approve once" },
              { decision: "cancel", label: "Cancel" },
            ],
          }),
        ],
        [live("request")],
      ),
    );
    expect(request).toMatchObject({ kind: "approval", requestId: "request", runId: "run" });
    if (request?.kind !== "approval") throw new Error("Expected an approval");
    expect(request.detail).toBe("touch ~/file");
    expect(request.options.map(({ label, tone }) => [label, tone])).toEqual([
      ["Decline and stop", "danger"],
      ["Approve", "primary"],
    ]);
  });

  test("offers every decision when the provider advertises none", () => {
    const [request] = projectRequests(snapshotOf([approval()], [live("request")]));
    if (request?.kind !== "approval") throw new Error("Expected an approval");
    expect(request.options.map(({ label }) => label)).toEqual([
      "Decline",
      "Approve",
      "Allow for this chat",
      "Decline and stop",
    ]);
  });

  test("ignores an approval that was answered or can no longer be answered", () => {
    expect(projectRequests(snapshotOf([approval()], [live("request", "resolved")]))).toEqual([]);
    expect(
      projectRequests(
        snapshotOf([approval()], [{ ...live("request"), responseCapability: { type: "gone" } }]),
      ),
    ).toEqual([]);
  });

  test("keeps a question for a secret on the desktop", () => {
    const question = { id: "q", question: "Token?", header: "", options: [], isSecret: true };
    expect(
      projectRequests(
        snapshotOf(
          [
            {
              ...base,
              id: "input",
              type: "user_input_request",
              requestId: "request",
              questions: [question],
            },
          ],
          [live("request")],
        ),
      ),
    ).toEqual([]);
  });
});

describe("what the transcript leaves out", () => {
  test.each([
    { type: "approval_request", requestId: "r", requestKind: "command" },
    { type: "checkpoint" },
    { type: "user_input_request", requestId: "r", questions: [], status: "waiting" },
  ])("hides $type", (item) => {
    expect(
      projectRuntimeItem("chat", { ...base, id: "i", ...item } as unknown as AgentTurnItem),
    ).toBeNull();
  });
});
