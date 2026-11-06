import { MOBILE_FILE_CHUNK_BYTES } from "@nodex/mobile-protocol";
import { expect, test } from "vitest";
import type { InboxItem, InboxProposal, InboxScope } from "../../shared/inbox";
import { isBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";
import { attachmentRef, decodeUploadChunk, parseAttachmentRef } from "./files";
import { inboxBody, mobileOperationId, projectInboxMessage } from "./inbox";

test("Inbox capture uses the same File image Markdown and stable operation identity", () => {
  expect(inboxBody("Keep this", ["file-id"])).toBe("![](nodex://files/file-id)\n\nKeep this");
  const timestamp = 1_000;
  const id = createUuidV7FromTimestamp(timestamp);
  const operation = mobileOperationId("mobile.inbox.capture", id, timestamp);
  expect(operation && isBoundedOperationId(operation)).toBe(true);
  expect(mobileOperationId("mobile.inbox.capture", id, timestamp)).toBe(operation);
  expect(mobileOperationId("mobile.inbox.capture", id, timestamp + 1)).toBeNull();
});

const suggestion: InboxProposal = {
  failureKind: null,
  proposalId: "proposal",
  revision: 2,
  origin: "agent",
  state: "open",
  pageIds: ["page"],
  basis: [{ pageId: "page", contentHash: "hash" }],
  outdated: false,
  action: { type: "move_to_project", projectId: "project" },
  kind: null,
  summary: "File this",
  rationale: null,
  producedBy: null,
  targetProjectName: "Project",
  chat: null,
  failureMessage: null,
  createdAt: "2026-11-04",
  updatedAt: "2026-11-04",
};

const inboxItem = (scope: InboxScope): InboxItem => ({
  outcome: null,
  pageId: "page",
  pageKey: "P-1",
  pageStatus: null,
  title: "Title",
  body: "Content",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-11-04",
  source: { kind: "user" },
  kind: "question",
  important: true,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  scope,
  location: { kind: "inbox" },
  firing: null,
  revision: 3,
  basis: { pageId: "page", contentHash: "hash" },
  proposal: suggestion,
});

test("Inbox projections expose the decision without revealing its internal classification", () => {
  const scope = { kind: "project" as const, projectId: "project" };
  const message = projectInboxMessage(inboxItem(scope));
  expect(message).toMatchObject({
    scope,
    revision: 3,
    source: { kind: "user", label: null },
    proposal: {
      revision: 2,
      action: { type: "move_to_project", projectId: "project", projectName: "Project" },
    },
  });
  expect(message).not.toHaveProperty("kind");
});

test("a chat suggestion reaches the phone whole", () => {
  const { proposal } = projectInboxMessage({
    ...inboxItem({ kind: "library" }),
    proposal: {
      ...suggestion,
      action: {
        type: "new_chat",
        projectId: "project",
        prompt: "Fix the flaky test",
        agent: { instanceId: "codex", model: "gpt", reasoningEffort: null, serviceTier: null },
        additions: ["Open a pull request when it passes"],
      },
      summary: "Start on the flaky test",
      rationale: "It failed three times this week",
      producedBy: "GPT",
      targetProjectName: "Nodex",
    },
  });
  expect(proposal).toMatchObject({
    summary: "Start on the flaky test",
    rationale: "It failed three times this week",
    origin: "agent",
    producedBy: "GPT",
    action: {
      type: "new_chat",
      projectName: "Nodex",
      prompt: "Fix the flaky test",
      additions: ["Open a pull request when it passes"],
      agent: { providerInstanceId: "codex", model: "gpt" },
    },
  });
});

test("file refs carry locators and chunks have a strict decoded byte ceiling", () => {
  expect(parseAttachmentRef(attachmentRef(["session", "thread", "item", "attachment"]))).toEqual([
    "session",
    "thread",
    "item",
    "attachment",
  ]);
  expect(parseAttachmentRef("nodex://chat-attachments/../private")).toBeNull();
  expect(decodeUploadChunk("AQID")).toEqual(Buffer.from([1, 2, 3]));
  expect(decodeUploadChunk("A QID")).toBeNull();
  expect(decodeUploadChunk(Buffer.alloc(MOBILE_FILE_CHUNK_BYTES).toString("base64"))?.length).toBe(
    MOBILE_FILE_CHUNK_BYTES,
  );
  expect(
    decodeUploadChunk(Buffer.alloc(MOBILE_FILE_CHUNK_BYTES + 1).toString("base64")),
  ).toBeNull();
});
