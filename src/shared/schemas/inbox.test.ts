import { describe, expect, it } from "vitest";
import { createBoundedOperationId } from "../operation-identity";
import { agentRuntimeProviderId } from "../agent-runtime-provider";
import { decodeInboxAgentBinding, encodeInboxAgentBinding } from "../inbox";
import {
  InboxEditInputSchema,
  InboxPreparedConfirmationSchema,
  InboxSendInputSchema,
  InboxSuggestionRequestInputSchema,
  UpdateInboxSettingsInputSchema,
} from "./inbox";

const basis = { pageId: "page-a", contentHash: "a".repeat(64) };

describe("Inbox boundary contracts", () => {
  it("accepts an optional boolean preference for showing the Page beside new chats", () => {
    expect(UpdateInboxSettingsInputSchema.parse({})).toEqual({});
    for (const showPageBesideNewChats of [true, false]) {
      const input = { showPageBesideNewChats };
      expect(UpdateInboxSettingsInputSchema.parse(input)).toEqual(input);
    }
    expect(
      UpdateInboxSettingsInputSchema.safeParse({ showPageBesideNewChats: "false" }).success,
    ).toBe(false);
    expect(UpdateInboxSettingsInputSchema.safeParse({ showPageBesideNewChats: null }).success).toBe(
      false,
    );
  });

  it("keeps an already prepared confirmation unchanged when replayed", () => {
    const prepared = {
      kind: "direct",
      storeEpoch: "epoch-a",
      operationId: createBoundedOperationId("inbox.dispatch"),
      proposalId: "proposal-a",
      sessionId: "session-a",
      pageIds: [basis.pageId],
      basis: [basis],
      action: { type: "new_chat", projectId: null, prompt: "Research only; do not change code." },
      executionSelection: {
        modelSelection: { instanceId: "codex", model: "reviewed-model" },
        interactionMode: "plan",
      },
    };
    const first = InboxPreparedConfirmationSchema.parse(prepared);
    expect(InboxPreparedConfirmationSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    // A decision saved before new chats could be planned still replays, as an unplanned chat.
    expect(first.action).toEqual({
      type: "new_chat",
      projectId: null,
      prompt: "Research only; do not change code.",
      agent: null,
      delegates: [],
      plan: null,
    });
  });

  it("rejects a capture without a replayable operation identity and measures UTF-8 bytes", () => {
    const capture = {
      scope: { kind: "library" },
      operationId: createBoundedOperationId("inbox.send"),
      pageId: "page-a",
      documentId: "document-a",
      issuedAt: Date.now(),
      storeEpoch: "epoch-a",
      body: "中".repeat(21_845),
    };
    expect(InboxSendInputSchema.safeParse(capture).success).toBe(true);
    expect(InboxSendInputSchema.safeParse({ ...capture, body: `${capture.body}中` }).success).toBe(
      false,
    );
    expect(
      InboxSendInputSchema.safeParse({ ...capture, operationId: "new-on-every-retry" }).success,
    ).toBe(false);
  });

  it("refuses to edit with another Page's revision", () => {
    expect(
      InboxEditInputSchema.safeParse({
        pageId: "page-b",
        basis,
        originalBody: "Before",
        body: "After",
      }).success,
    ).toBe(false);
  });

  it("keeps grouped membership exact and requires a versioned correction for refine", () => {
    const request = {
      requestId: "request-a",
      mode: "grouped",
      pageIds: [basis.pageId],
      basis: [basis],
    };
    expect(InboxSuggestionRequestInputSchema.safeParse(request).success).toBe(true);
    expect(
      InboxSuggestionRequestInputSchema.safeParse({ ...request, pageIds: ["page-b"] }).success,
    ).toBe(false);
    expect(
      InboxSuggestionRequestInputSchema.safeParse({ ...request, mode: "refine" }).success,
    ).toBe(false);
    expect(
      InboxSuggestionRequestInputSchema.safeParse({
        ...request,
        mode: "refine",
        proposalId: "proposal-a",
        expectedRevision: 2,
        correction: "Keep this as a note",
      }).success,
    ).toBe(true);
    expect(
      InboxSuggestionRequestInputSchema.safeParse({ ...request, correction: "Unexpected" }).success,
    ).toBe(false);
  });

  it("reads old native preferences once and stores the exact Runtime instance", () => {
    const instanceId = agentRuntimeProviderId({ kind: "claude", instanceConfigId: "work-account" });
    expect(decodeInboxAgentBinding("claude:work-account")).toEqual({ instanceId });
    expect(encodeInboxAgentBinding({ instanceId: instanceId! })).toBe(instanceId);
    expect(decodeInboxAgentBinding("codex")).toEqual({ instanceId: "codex" });
    expect(decodeInboxAgentBinding("claude:")).toBeNull();
  });
});
