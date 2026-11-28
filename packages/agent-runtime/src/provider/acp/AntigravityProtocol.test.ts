import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  extractAntigravityUserInputQuestion,
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravitySessionUpdate,
  normalizeAntigravityToolCall,
  sanitizeAntigravityToolPayload,
  makeAntigravityReadRepair,
} from "./AntigravityProtocol.ts";
import {
  mergeToolCallState,
  extractMcpToolCallIdentity,
  parseSessionUpdateEvent,
} from "@nodex/provider-acp/server/runtimeModel";
import { acpToolCallDiffPatch, acpToolCallFileChanges } from "@nodex/provider-acp/server/adapter";

describe("native Antigravity subagent tools", () => {
  it("recognizes only native invocation titles and excludes MCP tools", () => {
    const toolCall = { toolCallId: "trajectory:4", kind: "other", data: {} };
    for (const title of [
      "Running start_subagent",
      "Run start_subagent?",
      "Running invoke_subagent",
      "Run invoke_subagent?",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBe("subagent");
      expect(
        classifyAntigravitySubagentToolCall(
          { ...toolCall, title },
          { update: { _meta: { is_mcp_tool_call: true } } },
        ),
      ).toBe("mcp");
    }
    for (const title of [
      "Running subagent",
      "start_subagent",
      "Run command",
      "Running manage_task",
    ]) {
      expect(classifyAntigravitySubagentToolCall({ ...toolCall, title }, {})).toBeUndefined();
    }
    expect(
      classifyAntigravitySubagentToolCall(
        { ...toolCall, title: "Running start_subagent", kind: "execute" },
        {},
      ),
    ).toBeUndefined();
  });

  it("recognizes history starts and bounds the launch output", () => {
    expect(
      antigravitySubagentOutput({
        toolCallId: "trajectory:4",
        data: { rawOutput: "  Finished review.  " },
      }),
    ).toBe("Finished review.");
    const result = antigravitySubagentOutput({
      toolCallId: "trajectory:4",
      data: { rawOutput: `${"x".repeat(16_000)}The result.` },
    });
    expect(result?.length).toBeLessThan(8_100);
    expect(result?.endsWith("The result.")).toBe(true);
    expect(
      antigravitySubagentOutput({ toolCallId: "trajectory:4", data: { rawOutput: {} } }),
    ).toBeUndefined();
  });
});

const questionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "interaction_9960062f",
    status: "pending",
    title: "Which result label should be used for the verification?",
    rawInput: {},
  },
  options: [
    { optionId: "1", name: "Verified", kind: "allow_once" },
    { optionId: "2", name: "Needs review", kind: "allow_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

const commandStarted = {
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "fc28d0af6ad14be8bbba20f4258d4d3e",
    title: "run_command",
    kind: "execute",
    status: "in_progress",
    rawInput: { CommandLine: "cat probe.txt", Cwd: "/workspace" },
  },
} satisfies EffectAcpSchema.SessionNotification;

const commandCompleted = {
  sessionId: "session-1",
  update: {
    toolCallId: commandStarted.update.toolCallId,
    status: "completed",
    rawOutput: {
      commandLine: "cat probe.txt",
      workingDir: "/workspace",
      exitCode: 0,
      exit_code: 0,
      combinedOutput: "after\n",
      formatted_output: "after\n",
    },
    sessionUpdate: "tool_call_update",
  },
} satisfies EffectAcpSchema.SessionNotification;

function parseToolUpdate(notification: EffectAcpSchema.SessionNotification) {
  const result = parseSessionUpdateEvent(normalizeAntigravitySessionUpdate(notification));
  const event = result.events[0];
  if (event?._tag !== "ToolCallUpdated") {
    throw new Error("Expected a tool update.");
  }
  return event;
}

describe("Antigravity permissions and questions", () => {
  const permissionRequest = {
    sessionId: "session-1",
    toolCall: { toolCallId: "command-1", kind: "execute", title: "Run command" },
    options: [
      { optionId: "remember-this-command", name: "Allow always", kind: "allow_always" },
      { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
      { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("surfaces the agent's prompt injection warning on the remembered approval", () => {
    const risky = {
      ...permissionRequest,
      options: [
        {
          optionId: "remember-this-command",
          name: "Allow Always (risky)",
          kind: "allow_always",
          _meta: {
            "agy.security.warning": {
              severity: "high",
              risk: "prompt_injection",
              title: "Allowing always can be risky",
              message: "Untrusted files could re-run this action without asking.",
            },
          },
        },
        { optionId: "run-this-time", name: "Allow", kind: "allow_once" },
        { optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(antigravityApprovalOptions(risky)).toEqual([
      { decision: "accept", label: "Allow once" },
      {
        decision: "acceptForSession",
        label: "Allow for this thread",
        warning: "Untrusted files could re-run this action without asking.",
      },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
    expect(antigravityApprovalOptions(permissionRequest)[1]).not.toHaveProperty("warning");
  });

  it("routes the captured native question to single-choice input, not approval", () => {
    expect(isAntigravityUserInputRequest(questionRequest)).toBe(true);
    expect(extractAntigravityUserInputQuestion(questionRequest)).toEqual({
      id: "interaction_9960062f",
      header: "Question",
      question: "Which result label should be used for the verification?",
      multiSelect: false,
      allowCustomAnswer: false,
      options: [
        { value: "1", label: "Verified", description: "Verified" },
        { value: "2", label: "Needs review", description: "Needs review" },
      ],
    });
    expect(extractAntigravityUserInputQuestion(permissionRequest)).toBeUndefined();
  });

  it("returns exact opaque IDs and accepts a unique label from an older client", () => {
    for (const answer of ["1", ["1"], "Verified"]) {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toEqual({ outcome: { outcome: "selected", optionId: "1" } });
    }
    const request = {
      ...questionRequest,
      options: [{ optionId: " choice: opaque ", name: "Keep", kind: "allow_once" as const }],
    };
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: " choice: opaque " }),
    ).toEqual({ outcome: { outcome: "selected", optionId: " choice: opaque " } });
  });

  it("does not treat a question's reject choice as cancellation", () => {
    const request = {
      ...questionRequest,
      options: [{ optionId: "deny", name: "Do not trust", kind: "reject_once" as const }],
    };
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "deny" })).toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
  });

  it("preserves duplicate labels and rejects ambiguous label answers", () => {
    const request = {
      ...questionRequest,
      options: questionRequest.options.map((option) => ({ ...option, name: "Same label" })),
    };
    expect(
      extractAntigravityUserInputQuestion(request)?.options.map((option) => option.value),
    ).toEqual(["1", "2"]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: "Same label" }),
    ).toBeUndefined();
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "2" })).toEqual({
      outcome: { outcome: "selected", optionId: "2" },
    });
  });

  it.each([undefined, null, "", "arbitrary answer", [], ["1", "2"], { answer: "1" }, 1])(
    "keeps the question open for an unsupported answer: %j",
    (answer) => {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toBeUndefined();
    },
  );

  it("rejects missing or duplicate native option IDs", () => {
    for (const optionId of ["", "1"]) {
      const request = {
        ...questionRequest,
        options: [questionRequest.options[0]!, { ...questionRequest.options[1]!, optionId }],
      };
      expect(extractAntigravityUserInputQuestion(request)).toBeUndefined();
      expect(
        makeAntigravityUserInputResponse(request, { interaction_9960062f: "1" }),
      ).toBeUndefined();
    }
  });

  it("bounds question text without changing choice IDs", () => {
    const request = {
      ...questionRequest,
      toolCall: { ...questionRequest.toolCall, title: "Question ".repeat(2_000) },
      options: [
        { optionId: "stable-choice", name: "Choice ".repeat(2_000), kind: "allow_once" as const },
      ],
    };
    const question = extractAntigravityUserInputQuestion(request);
    expect(question?.question.length).toBeLessThanOrEqual(8_000);
    expect(question?.options[0]?.label.length).toBeLessThanOrEqual(512);
    expect(question?.options[0]?.value).toBe("stable-choice");
  });
});

describe("Antigravity tool results", () => {
  it("normalizes the captured command and completed output for the existing clients", () => {
    const initial = parseToolUpdate(commandStarted).toolCall;
    const completed = parseToolUpdate(commandCompleted).toolCall;
    const toolCall = normalizeAntigravityToolCall(mergeToolCallState(initial, completed));

    expect(toolCall).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "cat probe.txt",
      detail: "cat probe.txt",
      data: {
        command: "cat probe.txt",
        cwd: "/workspace",
        item: {
          command: "cat probe.txt",
          cwd: "/workspace",
          aggregatedOutput: "after\n",
          exitCode: 0,
        },
      },
    });
    expect(toolCall.data.rawOutput).not.toHaveProperty("formatted_output");
    expect(commandCompleted.update.rawOutput.formatted_output).toBe("after\n");
  });

  it("keeps the whole diff of an edit to a file longer than the tool text budget", () => {
    const path = "/workspace/runner.py";
    const lines = Array.from({ length: 400 }, (_, i) => `value_${i + 1} = ${"x".repeat(40)}`);
    const before = `${lines.join("\n")}\n`;
    const after = before.replace("value_101 = ", "value_101 = 1 + ");
    const frame = (
      update: Partial<Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "tool_call" }>>,
      sessionUpdate: "tool_call" | "tool_call_update" = "tool_call_update",
    ) =>
      ({
        sessionId: "session-1",
        update: {
          sessionUpdate,
          toolCallId: "edit-1",
          kind: "edit",
          title: "File runner.py",
          locations: [{ path }],
          rawInput: { Path: path, Target: "value_101 = ", Replacement: "value_101 = 1 + " },
          ...update,
        },
      }) as EffectAcpSchema.SessionNotification;
    // The edit reports only its path until it completes; its completion carries both files.
    let toolCall = normalizeAntigravityToolCall(
      parseToolUpdate(frame({ status: "in_progress" }, "tool_call")).toolCall,
    );
    expect(acpToolCallFileChanges(toolCall.data.content)).toEqual([]);
    for (const next of [
      frame({
        status: "completed",
        rawOutput: {},
        content: [{ type: "diff", path, oldText: before, newText: after }],
      }),
      // A later update's text budget leaves the kept patch whole.
      frame({ title: "File runner.py" }),
    ]) {
      toolCall = normalizeAntigravityToolCall(
        mergeToolCallState(toolCall, parseToolUpdate(next).toolCall),
      );
    }
    expect(before.length).toBeGreaterThan(8_000);
    expect(acpToolCallFileChanges(toolCall.data.content)).toEqual([
      {
        operation: "modify",
        path,
        diff: [
          "@@ -98,7 +98,7 @@",
          ...lines.slice(97, 100).map((line) => ` ${line}`),
          `-${lines[100]}`,
          `+${lines[100]!.replace("value_101 = ", "value_101 = 1 + ")}`,
          ...lines.slice(101, 104).map((line) => ` ${line}`),
          "",
        ].join("\n"),
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(acpToolCallDiffPatch(toolCall.data.content)).toMatch(
      new RegExp(`^--- ${path}\n\\+\\+\\+ ${path}\n@@ -98,7 \\+98,7 @@\n`),
    );
    // Beside a Git-framed section, the kept patch takes its own Git header.
    const framed = {
      type: "diff",
      changes: [{ operation: "modify", path: "/workspace/other.py" }],
      patch: { format: "git_patch", text: "@@ -1,1 +1,1 @@\n-a\n+b\n" },
    };
    expect(
      acpToolCallDiffPatch([framed, ...(toolCall.data.content as unknown[])])?.match(
        /^diff --git /gm,
      ),
    ).toHaveLength(2);
    // A result that only looks like a diff is not an edit and stays as reported.
    const result = { type: "diff", path, oldText: "a", newText: "b", status: "draft" };
    const tool = normalizeAntigravityToolCall(
      parseToolUpdate(frame({ status: "completed", rawOutput: { structuredContent: result } }))
        .toolCall,
    );
    expect(tool.data.rawOutput).toEqual({ structuredContent: result });
  });

  it("keeps created and overwritten files whole and leaves a sweeping rewrite unpreviewed", () => {
    const path = "/workspace/notes.md";
    const longFile = `${Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${"y".repeat(30)}`).join("\n")}\n`;
    const changes = (diff: Record<string, unknown>) =>
      acpToolCallFileChanges(
        normalizeAntigravityToolCall(
          parseToolUpdate({
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "write-1",
              kind: "edit",
              status: "completed",
              title: "File notes.md",
              locations: [{ path }],
              rawOutput: {},
              content: [{ type: "diff", path, ...diff } as EffectAcpSchema.ToolCallContent],
            },
          }).toolCall,
        ).data.content,
      );
    expect(changes({ newText: longFile })).toEqual([
      { operation: "add", path, diff: longFile, additions: 300, deletions: 0 },
    ]);
    expect(changes({ oldText: longFile, newText: "short\n" })).toMatchObject([
      { operation: "modify", path, additions: 1, deletions: 300 },
    ]);
    expect(changes({ newText: "" })).toEqual([
      { operation: "add", path, diff: "", additions: 0, deletions: 0 },
    ]);
    // Past the limits, or too far-reaching to search, a change is never cut into a partial diff.
    const rewrite = (word: string) =>
      Array.from({ length: 1_200 }, (_, i) => `${word} ${i}`).join("\n");
    const huge = "z".repeat(300 * 1024);
    for (const [diff, operation] of [
      [{ oldText: rewrite("old"), newText: rewrite("new") }, "modify"],
      [{ oldText: huge.repeat(4), newText: "short\n" }, "modify"],
      [{ newText: huge }, "add"],
    ] as const) {
      expect(changes(diff)).toEqual([{ operation, path }]);
    }
  });

  it.each([
    { CommandLine: "pwd", Cwd: "/one" },
    { CommandLine: "pwd", WorkingDirectory: "/one" },
    { command_line: "pwd", working_dir: "/one" },
    { commandLine: "pwd", workingDir: "/one" },
    { command: "pwd", cwd: "/one" },
  ])("handles native command input aliases: %j", (rawInput) => {
    const event = parseToolUpdate({
      ...commandStarted,
      update: { ...commandStarted.update, rawInput },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      command: "pwd",
      detail: "pwd",
      data: { item: { command: "pwd", cwd: "/one" } },
    });
  });

  it("recovers command fields from history and keeps nonzero exits separate from tool failure", () => {
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          command_line: "test -f missing.txt",
          working_dir: "/workspace",
          combined_output: "",
          exit_code: 1,
        },
      },
    });
    expect(normalizeAntigravityToolCall(event.toolCall)).toMatchObject({
      kind: "execute",
      status: "completed",
      command: "test -f missing.txt",
      data: { item: { cwd: "/workspace", aggregatedOutput: "", exitCode: 1 } },
    });
  });

  it.each([
    { name: "ASCII", boundary: "x", kept: "x", field: "combinedOutput" },
    { name: "split emoji", boundary: "🚀", kept: "", field: "combinedOutput" },
    { name: "split emoji (snake case)", boundary: "🚀", kept: "", field: "combined_output" },
  ])("bounds both canonical and retained raw output at $name", ({ boundary, kept, field }) => {
    const tail = `${"x".repeat(7_989)}last line\n`;
    const output = `${"output line\n".repeat(20_000)}${boundary}${tail}`;
    const expected = `[Earlier output truncated]\n\n${kept}${tail}`;
    const { combinedOutput: _combinedOutput, ...rawOutput } = commandCompleted.update.rawOutput;
    const event = parseToolUpdate({
      ...commandCompleted,
      update: {
        ...commandCompleted.update,
        rawOutput: {
          ...rawOutput,
          [field]: output,
          formatted_output: output,
        },
      },
    });
    const toolCall = normalizeAntigravityToolCall(event.toolCall);
    expect(toolCall.data).toMatchObject({
      item: { aggregatedOutput: expected },
      rawOutput: { [field]: expected },
    });
    expect(event.toolCall.data.rawOutput).toMatchObject({ [field]: expected });
    expect(JSON.stringify(toolCall).length).toBeLessThan(20_000);
    expect(JSON.stringify(event.rawPayload).length).toBeLessThan(10_000);
    expect(JSON.stringify(event.rawPayload)).not.toContain("formatted_output");
  });

  it("keeps 1.5 command output and its content text valid Unicode when cut", () => {
    const tail = `${"x".repeat(7_982)}build completed\r\n`;
    const output = `Command output:\nprefix\r\n🚀${tail}`;
    const expected = `[Earlier output truncated]\n\n${tail}`;
    const toolCall = normalizeAntigravityToolCall(
      parseToolUpdate({
        ...commandCompleted,
        update: {
          ...commandCompleted.update,
          rawOutput: { output, exit_code: 0 },
          content: [{ type: "content", content: { type: "text", text: output } }],
        },
      }).toolCall,
    );
    expect(toolCall.data).toMatchObject({
      rawOutput: { output: expected },
      content: [{ content: { text: expected.trimEnd() } }],
    });
  });

  it("removes inline images while preserving valid tool content and the local image path", () => {
    const inlineImage = "inline-image-bytes".repeat(50_000);
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "image-1",
        status: "completed",
        rawOutput: { imageName: "result", imagePath: "file:///workspace/brain/result%20image.png" },
        content: [
          { type: "content", content: { type: "image", mimeType: "image/png", data: inlineImage } },
          { type: "content", content: { type: "text", text: "Saved the image." } },
          { type: "diff", path: "/workspace/note.txt", oldText: "old", newText: "new" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification;
    const normalized = normalizeAntigravitySessionUpdate(notification);
    expect(JSON.stringify(normalized)).not.toContain("inline-image-bytes");
    expect(normalized.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "Saved the image." } },
        { type: "diff", changes: [{ operation: "modify", path: "/workspace/note.txt" }] },
      ],
    });
    const toolCall = normalizeAntigravityToolCall(parseToolUpdate(normalized).toolCall);
    expect(acpToolCallFileChanges(toolCall.data.content)).toMatchObject([
      { operation: "modify", path: "/workspace/note.txt", additions: 1, deletions: 1 },
    ]);
    expect(toolCall.data.imagePath).toBe("/workspace/brain/result image.png");
  });

  it.each([
    ["/workspace/result.png", "/workspace/result.png"],
    ["C:\\work\\result.png", "C:\\work\\result.png"],
    ["file:///C:/work/result.png", "C:/work/result.png"],
    ["https://example.com/result.png", undefined],
    ["file://another-host/result.png", undefined],
    ["data:image/png;base64,AAAA", undefined],
  ])("only promotes local image references: %s", (imagePath, expected) => {
    const toolCall = normalizeAntigravityToolCall({
      toolCallId: "image-1",
      data: { rawOutput: { imagePath } },
    });
    expect(toolCall.data.imagePath).toBe(expected);
  });

  it("bounds nested tool data and drops image blobs and data URLs", () => {
    const payload = sanitizeAntigravityToolPayload({
      rawOutput: {
        text: "a".repeat(100_000),
        result: { mimeType: "image/png", blob: "image-blob".repeat(100_000) },
        image: { type: "image", data: "inline-image".repeat(100_000) },
        uri: "data:image/png;base64,inline-data-url",
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(9_000);
    expect(serialized).not.toContain("image-blob");
    expect(serialized).not.toContain("inline-image");
    expect(serialized).not.toContain("inline-data-url");
  });
});

describe("Antigravity served reads", () => {
  const flush = (reads: ReturnType<typeof makeAntigravityReadRepair>, toolCallId: string) =>
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: "Tool execution failed",
      },
    }).update;

  it("credits a read Nodex served before the agent announced it", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    const announced = reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_late",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    expect(announced.update).toMatchObject({ status: "completed" });
    expect(flush(reads, "call_late")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_late",
      status: "completed",
    });
  });

  it("forgets an earlier turn's unannounced served read", () => {
    const reads = makeAntigravityReadRepair();
    reads.attempted("/repo/a.ts", true);
    reads.reset();
    reads.repair({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_refused",
        title: "Running client_view_file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/a.ts" }],
      },
    });
    reads.attempted("/repo/a.ts", false);
    expect(flush(reads, "call_refused")).toMatchObject({ status: "failed" });
  });

  it("drops an earlier turn's unanswered read so a new turn's served read gets the credit", () => {
    const reads = makeAntigravityReadRepair();
    const announce = (toolCallId: string) =>
      reads.repair({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Running client_view_file",
          kind: "read",
          status: "in_progress",
          locations: [{ path: "/repo/a.ts" }],
        },
      });
    announce("call_abandoned");
    reads.reset();
    announce("call_current");
    reads.attempted("/repo/a.ts", true);
    expect(flush(reads, "call_current")).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_current",
      status: "completed",
    });
  });
});

describe("Antigravity native tool presentation", () => {
  it("presents run_command output without native timestamps", () => {
    const output =
      "Created At: 2026-11-20T01:00:00Z\nCompleted At: 2026-11-20T01:00:01Z\nCommand exited with code 0.\n\nCommand output:\nhello\n";
    const { toolCall } = parseToolUpdate({
      sessionId: "session-native-command",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "command-1",
        name: "run_command",
        title: "Run command",
        kind: "execute",
        status: "completed",
        rawInput: { CommandLine: "printf hello", Cwd: "/workspace" },
        rawOutput: { output, exit_code: 0 },
        content: [{ type: "content", content: { type: "text", text: output } }],
      },
    });
    const presented = normalizeAntigravityToolCall(toolCall);
    expect(presented.command).toBe("printf hello");
    expect(presented.data.item).toMatchObject({ aggregatedOutput: "hello\n", exitCode: 0 });
    expect(presented.data.rawOutput).toEqual({ output: "hello\n", exit_code: 0 });
    expect(presented.data.content).toEqual([
      { type: "content", content: { type: "text", text: "hello\n" } },
    ]);
  });

  it("keeps command identity when the completion omits its name", () => {
    const initial = parseToolUpdate({
      sessionId: "session-native-command",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "command-2",
        name: "run_command",
        title: "Run command",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "printf hello" },
      },
    }).toolCall;
    const completed = parseToolUpdate({
      sessionId: "session-native-command",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "command-2",
        status: "completed",
        rawOutput: {
          output:
            "Created At: today\nCompleted At: today\nCommand exited with code 0.\n\nCommand output:\nhello\n",
          exit_code: 0,
        },
      },
    }).toolCall;
    const presented = normalizeAntigravityToolCall(mergeToolCallState(initial, completed));
    expect(presented.command).toBe("printf hello");
    expect(presented.data.rawOutput).toEqual({ output: "hello\n", exit_code: 0 });
    expect(presented.data.item).toMatchObject({ aggregatedOutput: "hello\n", exitCode: 0 });
  });

  it.each([
    { name: "mcp_nodex_app_fetch", server: "nodex_app", tool: "fetch" },
    { name: "mcp_node_repl_js", server: "node_repl", tool: "js" },
  ])("preserves MCP identity for $name", ({ name, server, tool }) => {
    const normalized = normalizeAntigravitySessionUpdate({
      sessionId: "session-native-mcp",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "mcp-1",
        name,
        title: `Run ${name}`,
        kind: "other",
        status: "completed",
        rawInput: { toolSummary: "Read context", id: "page-1" },
      },
    });
    expect(normalized.update).toMatchObject({
      rawInput: { server, tool, arguments: { id: "page-1" } },
      _meta: { is_mcp_tool_call: true },
    });
    expect(
      extractMcpToolCallIdentity(parseToolUpdate(normalized).toolCall, {
        antigravityToolIdentity: true,
      }),
    ).toEqual({
      server,
      tool,
    });
  });
});
