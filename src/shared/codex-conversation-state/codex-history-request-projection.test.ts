import { expect, test } from "vite-plus/test";
import type { CodexItemView } from "../types";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
} from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  agentActivityV2CommandApprovalRequest,
  agentActivityV2FileApprovalRequest,
  agentActivityV2PermissionRequest,
  agentActivityV2UserInputRequest,
} from "./test-fixtures/agent-activity-v2-request-family-corpus";
import { projectCodexHistoryRequestViews } from "./codex-history-request-projection";

function patchItem(): CodexItemView {
  return {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    itemId: "patch-mixed",
    callId: "patch-mixed",
    type: "fileChange",
    normalizedKind: "fileChange",
    semanticKind: "patch",
    status: "inProgress",
    fileChange: { changes: {} },
    createdAt: 1,
    updatedAt: 1,
  };
}

test("projects and attaches exact history request families", () => {
  const projected = projectCodexHistoryRequestViews({
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    cwd: "/workspace/turn-cwd",
    items: [patchItem()],
    requests: [
      agentActivityV2CommandApprovalRequest,
      agentActivityV2FileApprovalRequest,
      agentActivityV2UserInputRequest,
      agentActivityV2PermissionRequest,
    ],
    observedAtMs: 5_000,
  });
  const patch = projected.find((item) => item.callId === "patch-mixed");
  const command = projected.find((item) => item.callId === "pending-command-approval");
  const userInput = projected.find((item) => item.callId === "request-user-input");
  const permission = projected.find((item) => item.semanticKind === "permissionRequest");

  expect(projected.length).toBe(4);
  expect(patch?.approvalRequestId).toBe("file-approval-202");
  expect(patch?.grantRoot).toBe("/workspace/shared");
  expect(command?.approvalRequestId).toBe(201);
  expect(command?.cwd).toBe("/workspace/turn-cwd");
  expect(command?.parsedCmd?.isFinished).toBe(false);
  expect(command?.proposedNetworkPolicyAmendments?.[0]?.host).toBe("example.invalid");
  expect(userInput?.requestId).toBe(203);
  expect(userInput?.userInputQuestions?.[0]?.isOther).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(userInput?.userInputQuestions?.[0] ?? {}, "isSecret"),
  ).toBe(false);
  expect(permission?.requestId).toBe("permission-204");

  const deduped = projectCodexHistoryRequestViews({
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    cwd: null,
    items: [permission!],
    requests: [agentActivityV2PermissionRequest],
  });
  expect(deduped.length).toBe(1);
});
