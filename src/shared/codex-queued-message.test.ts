import { expect, test } from "vitest";
import { queuedMessagePromptInput, type CodexQueuedMessage } from "./codex-queued-message";

function captured(untrustedAppMessage?: unknown): CodexQueuedMessage {
  return {
    id: "captured-message",
    cwd: "/workspace",
    context: {
      prompt: "Inspect selection",
      fileAttachments: [],
      addedFiles: [],
      commentAttachments: [],
      imageAttachments: [],
      ...(untrustedAppMessage === undefined ? {} : { untrustedAppMessage }),
    },
  };
}

test("decodes persisted app provenance into editable typed input without retaining unrecognized fields", () => {
  const message: unknown = {
    source: "visualization",
    sourceId: "widget-a",
    text: "Inspect selection",
    structuredContent: { selected: [1, 3] },
    extra: "not a prompt field",
  };
  const restored = JSON.parse(JSON.stringify(captured(message))) as CodexQueuedMessage;
  const input = queuedMessagePromptInput(restored);
  expect(input.text).toBe("Inspect selection");
  expect(input.untrustedAppMessage).toEqual({
    source: "visualization",
    sourceId: "widget-a",
    text: "Inspect selection",
    structuredContent: { selected: [1, 3] },
  });
  expect(restored.context.untrustedAppMessage).toEqual(message);
});

test.each([undefined, null])(
  "omits absent app provenance in ordinary queued input: %s",
  (value) => {
    expect(queuedMessagePromptInput(captured(value)).untrustedAppMessage).toBeUndefined();
  },
);

test.each([
  "untrusted text",
  { source: "trusted_user", sourceId: "widget-a", text: "Inspect selection" },
  {
    source: "visualization",
    sourceId: "widget-a",
    text: "Inspect selection",
    structuredContent: [],
  },
])("rejects malformed persisted app provenance at the typed prompt boundary: %j", (value) => {
  expect(() => queuedMessagePromptInput(captured(value))).toThrow("app");
});

test("restores validated model context from both authored controls and captured app cards", () => {
  const attachments: unknown = [
    {
      id: "file-widget",
      kind: "context",
      sourceName: "Visualization changes",
      text: null,
      structuredContent: { edits: [{ target: "panel", changes: [{ label: "Size", value: 11 }] }] },
      imageAttachments: [],
      untrusted: false,
      extra: "not a prompt field",
    },
    {
      id: "app-card",
      title: "Map selection",
      text: "Selected one location",
      imageAttachments: [{ src: "data:image/png;base64,YQ==" }],
      composerAttachmentLayout: "pill",
      composerIcon: { alt: "Map", logoUrl: null },
      untrusted: true,
    },
  ];
  const message = captured();
  const restored = queuedMessagePromptInput({
    ...message,
    context: { ...message.context, mcpAppModelContextAttachments: attachments },
  }).mcpAppModelContextAttachments;
  expect(restored).toEqual([
    {
      id: "file-widget",
      kind: "context",
      sourceName: "Visualization changes",
      title: "Visualization changes",
      text: null,
      structuredContent: { edits: [{ target: "panel", changes: [{ label: "Size", value: 11 }] }] },
      imageAttachments: [],
      untrusted: true,
    },
    {
      id: "app-card",
      title: "Map selection",
      text: "Selected one location",
      imageAttachments: [{ src: "data:image/png;base64,YQ==" }],
      composerAttachmentLayout: "pill",
      composerIcon: { alt: "Map", logoUrl: null },
      untrusted: true,
    },
  ]);
  expect(attachments).not.toEqual(restored);
});

test.each([
  "context",
  [
    {
      id: "file-widget",
      sourceName: "Changes",
      text: null,
      imageAttachments: [],
      structuredContent: [],
    },
  ],
  [
    {
      id: "file-widget",
      title: "Changes",
      text: null,
      imageAttachments: [{ src: "https://example.com/image.png" }],
    },
  ],
  [
    {
      id: "file-widget",
      title: "Changes",
      text: null,
      imageAttachments: [],
      composerAttachmentLayout: "panel",
    },
  ],
])(
  "rejects malformed restored model context before editable prompt consumers: %j",
  (attachments) => {
    const message = captured();
    expect(() =>
      queuedMessagePromptInput({
        ...message,
        context: { ...message.context, mcpAppModelContextAttachments: attachments },
      }),
    ).toThrow(/app/i);
  },
);
