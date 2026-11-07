import { expect, test, vi } from "vite-plus/test";
import { prepareAgentMessage, retainAgentAppContext } from "./agent-prompt";
import { prepareCodexPrompt } from "./codex-prompt-preparation";
import {
  PAGE_REFERENCE_CONTEXT_KIND,
  PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY,
  pageReferencePayload,
  readRuntimePageReferences,
  readPageReferencesAdditionalContext,
  serializePageReferences,
  withoutPageReferenceInput,
  type PageReference,
} from "./page-reference";
import { projectMessageForProvider } from "../../packages/agent-runtime/vendor/shared/src/messageContextProjection";

const references: readonly PageReference[] = [
  { pageId: "page-a", titleSnapshot: "Plan [v2]", selectedBlockIds: ["block-1", "block-2"] },
];

test("Runtime retains only Page identity, title and highlighted Block identities as provider-readable data", async () => {
  const prepared = await prepareAgentMessage(
    "Review",
    { text: "Review", pageReferences: references },
    vi.fn(),
  );
  expect(prepared.context?.records).toEqual([
    {
      kind: PAGE_REFERENCE_CONTEXT_KIND,
      label: "Plan [v2]",
      payload: {
        pageId: "page-a",
        title: "Plan [v2]",
        url: "nodex://pages/page-a",
        selectedBlockIds: ["block-1", "block-2"],
      },
    },
  ]);
  expect(readRuntimePageReferences(prepared.context)).toEqual(references);
  expect(prepared.text).toBe("Review");
  const projected = projectMessageForProvider(prepared);
  expect(projected).toContain(JSON.stringify(pageReferencePayload(references[0]!)));
  expect(projected.startsWith("Review\n\n<nodex_context>")).toBe(true);
  expect(
    readRuntimePageReferences(retainAgentAppContext({ text: "Revise" }, prepared).context),
  ).toEqual(references);
});

test("Codex uses an ordinary companion text input and typed display sidecar, including reference-only sends", async () => {
  const prepared = await prepareCodexPrompt(
    "",
    { text: "", pageReferences: references },
    { resolveImageInput: vi.fn() },
  );
  expect(prepared.inputItems).toEqual([
    { type: "text", text: serializePageReferences(references), text_elements: [] },
  ]);
  expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
  expect(prepared.additionalContext).toEqual({
    [PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY]: {
      kind: "application",
      value: JSON.stringify(references),
    },
  });
  const restored = readPageReferencesAdditionalContext(prepared.additionalContext);
  expect(restored).toEqual(references);
  expect(withoutPageReferenceInput(prepared.inputItems, restored)).toEqual([]);
  expect(withoutPageReferenceInput(prepared.inputItems, [])).toEqual(prepared.inputItems);
  expect(
    withoutPageReferenceInput(
      [{ type: "text", text: "# Page references:\nMy own example" }],
      restored,
    ),
  ).toEqual([{ type: "text", text: "# Page references:\nMy own example" }]);
});

test("malformed stored references do not become transcript context", () => {
  expect(
    readPageReferencesAdditionalContext({
      [PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY]: { value: "{" },
    }),
  ).toEqual([]);
  expect(
    readRuntimePageReferences({
      records: [{ kind: PAGE_REFERENCE_CONTEXT_KIND, payload: { pageId: "bad", title: "Bad" } }],
    }),
  ).toEqual([]);
});
