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
