import { expect, test, vi } from "vite-plus/test";
import {
  prepareAgentMessage,
  appendAgentAppContext,
  agentMessageDisplayText,
  retainAgentAppContext,
} from "./agent-prompt";
import { prepareCodexPrompt } from "./codex-prompt-preparation";
import {
  ResponseTextAnnotationSchema,
  readRuntimeThreadTextSelections,
  readThreadTextSelectionAdditionalContext,
  serializeThreadTextSelections,
  withoutThreadTextSelectionInput,
  type ThreadTextSelectionContext,
} from "./thread-text-selection";

const selections: ThreadTextSelectionContext = {
  responseTextAnnotations: [
    {
      id: "annotation",
      text: "Second occurrence",
      annotation: "Explain why",
      source: {
        threadId: "thread",
        messageId: "message",
        startOffset: 15,
        endOffset: 32,
        rangeText: "Second occurrence",
      },
    },
  ],
  selectedTextAttachments: [{ id: "selection", text: "Side context" }],
};

test("sends response annotations and side selections as context while preserving the user's words", async () => {
  const result = await prepareAgentMessage(
    "My own words",
    { text: "My own words", ...selections },
    vi.fn(),
  );
  expect(agentMessageDisplayText(result.text)).toBe("My own words");
  expect(readRuntimeThreadTextSelections(result.context)).toEqual(selections);
  const serialized = serializeThreadTextSelections(selections);
  expect(serialized).toContain(':codex-annotation{index="N"}');
  expect(serialized).toContain('"source":{"messageId":"message","startOffset":15,"endOffset":32}');
  expect(serialized).toContain("## Selection 1\nSide context");
  expect(result.context?.records[0]).toMatchObject({ payload: { prompt: serialized } });
});

test("accepts selection-only sends and keeps native display input separate from the model context", async () => {
  const prepared = await prepareCodexPrompt(
    "",
    { text: "", ...selections },
    { resolveImageInput: vi.fn() },
  );
  expect(prepared.promptText).toBe("");
  expect(prepared.inputItems).toEqual([
    { type: "text", text: serializeThreadTextSelections(selections), text_elements: [] },
  ]);
  const restored = readThreadTextSelectionAdditionalContext(prepared.additionalContext);
  expect(restored).toEqual(selections);
  expect(withoutThreadTextSelectionInput(prepared.inputItems, restored)).toEqual([]);
  expect(
    withoutThreadTextSelectionInput(
      [{ type: "text", text: "# Response annotations:\nAuthored example" }],
      restored,
    ),
  ).toEqual([{ type: "text", text: "# Response annotations:\nAuthored example" }]);
});

test("text-only edits retain original context but an attachment edit can remove every selection", async () => {
  const original = await prepareAgentMessage("Before", { text: "Before", ...selections }, vi.fn());
  const revised = { text: "After" };
  expect(readRuntimeThreadTextSelections(retainAgentAppContext(revised, original).context)).toEqual(
    selections,
  );
  expect(retainAgentAppContext(revised, original, false)).toEqual(revised);
});

test("rejects invalid source bounds at the input boundary", async () => {
  const annotation = selections.responseTextAnnotations[0]!;
  const invalid = { ...annotation, source: { ...annotation.source, endOffset: 10 } };
  expect(ResponseTextAnnotationSchema.safeParse(invalid).success).toBe(false);
  await expect(
    prepareAgentMessage("", { text: "", responseTextAnnotations: [invalid] }, vi.fn()),
  ).rejects.toThrow();
});

test("editing selections preserves independent app context under its original identity", async () => {
  const original = appendAgentAppContext<Awaited<ReturnType<typeof prepareAgentMessage>>>(
    { text: "Before" },
    [{ text: "App evidence" }],
    "Evidence",
  );
  const revised = await prepareAgentMessage("After", { text: "After", ...selections }, vi.fn());
  const merged = retainAgentAppContext(revised, original, false);
  expect(merged.context?.records).toHaveLength(2);
  expect(merged.context?.records).toContainEqual(original.context?.records[0]);
  expect(readRuntimeThreadTextSelections(merged.context)).toEqual(selections);
  expect(agentMessageDisplayText(merged.text)).toBe("After");
});
