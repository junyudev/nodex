import { expect, it, vi } from "vite-plus/test";
import {
  agentMessageDisplayText,
  prepareAgentAppContext,
  prepareAgentMessage,
  retainAgentAppContext,
} from "./agent-prompt";

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
          { label: "app.ts", path: "app.ts", fsPath: "/project/app.ts", startLine: 5, endLine: 10 },
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
  expect(agentMessageDisplayText(message.text)).toBe("Explain this");
  expect(message.text).toMatch(
    /^Explain this\n\n\[[^\]]+\]\(t3-context:\/\/v1\/nodex-app-context\/\w+\)$/u,
  );
  const record = (message.context as unknown as { records: { kind: string; payload: unknown }[] })
    .records[0]!;
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
  expect(prepareAgentAppContext(input).images).toEqual([{ source: "data:image/png;base64,AA==" }]);
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
  expect(agentMessageDisplayText(message.text)).toBe("Follow-up");
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
  expect(agentMessageDisplayText(rewritten.text)).toBe("Compare only the first two");
  expect(rewritten.context).toEqual(original.context);
  expect(rewritten.text.replace("Compare only the first two", "Compare these")).toBe(original.text);

  // New app data replaces the old; a message that had none gains none.
  const fresh = await prepareAgentMessage("Compare", undefined, vi.fn(), {
    untrustedAppMessage: { ...untrustedAppMessage, sourceId: "chart-2" },
  });
  expect(retainAgentAppContext(fresh, original)).toBe(fresh);
  expect(retainAgentAppContext({ text: "Plain" }, { text: "Before" })).toEqual({ text: "Plain" });
});
