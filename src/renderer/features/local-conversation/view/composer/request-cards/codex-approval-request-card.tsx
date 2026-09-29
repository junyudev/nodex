import type {
  CodexApprovalResponse,
  CodexApprovalRequest,
  CodexConversationItem,
  CodexProtocolRequestId,
} from "../../../../../lib/types";
import type { ReactNode } from "react";
import {
  EXPLICIT_REQUEST_FORM_POLICY,
  RequestComposerView,
  getRequestQuestionnaireAnswer,
  type RequestComposerRequest,
} from "../../shared/request-cards/local-conversation-request-cards";
import {
  buildCodexFileChangePatchRows,
  type CodexFileChangePatchAction,
} from "../../../../../../shared/codex-file-change";
import {
  buildCodexCommandApprovalPreview,
  formatCodexExecPolicyAmendmentMenuSummary,
} from "../../../../../../shared/codex-command-execution";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../../../shared/codex-conversation-state/codex-conversation-state";

interface CodexApprovalRequestCardProps {
  request: CodexApprovalRequest;
  requestItem?: CodexConversationItem | null;
  actorName?: string | null;
  approvalQuestionActor?: ReactNode;
  onRespond: (requestId: CodexProtocolRequestId, response: CodexApprovalResponse) => Promise<void>;
  onSubmitLocalFollowup?: (prompt: string) => Promise<void>;
}

function buildPromptText(request: CodexApprovalRequest, actorName: string | null): string {
  const actorPrefix = actorName?.trim() ? `${actorName} ` : "";
  if (request.kind === "command" && request.networkApprovalContext?.host) {
    return actorPrefix
      ? `Do you want ${actorPrefix}to approve network access to "${request.networkApprovalContext.host}"?`
      : `Do you want to approve network access to "${request.networkApprovalContext.host}"?`;
  }

  const explicitReason = request.approvalReason?.trim() || request.reason?.trim();
  if (explicitReason) return explicitReason;

  if (request.kind === "command") {
    return actorPrefix
      ? `Do you want ${actorPrefix}to run this command?`
      : "Do you want to run this command?";
  }

  return actorPrefix
    ? `Do you want ${actorPrefix}to make these changes?`
    : "Do you want to make these changes?";
}

function buildPromptNode(
  request: CodexApprovalRequest,
  actorName: string | null,
  approvalQuestionActor?: ReactNode,
): ReactNode {
  const explicitReason = request.approvalReason?.trim() || request.reason?.trim();
  if (explicitReason) {
    return explicitReason;
  }

  const actor = actorName?.trim() ? (approvalQuestionActor ?? actorName.trim()) : null;
  if (request.kind === "command" && request.networkApprovalContext?.host) {
    return actor ? (
      <>
        Do you want {actor} to approve network access to "{request.networkApprovalContext.host}"?
      </>
    ) : (
      `Do you want to approve network access to "${request.networkApprovalContext.host}"?`
    );
  }

  if (request.kind === "command") {
    return actor ? (
      <>Do you want {actor} to run this command?</>
    ) : (
      "Do you want to run this command?"
    );
  }

  return actor ? (
    <>Do you want {actor} to make these changes?</>
  ) : (
    "Do you want to make these changes?"
  );
}

function buildExecAmendmentSummary(request: CodexApprovalRequest): string | null {
  return formatCodexExecPolicyAmendmentMenuSummary(request.proposedExecpolicyAmendment);
}

function buildRequestQuestion(
  request: CodexApprovalRequest,
  actorName: string | null,
): RequestComposerRequest {
  const prompt = buildPromptText(request, actorName);
  const execAmendmentSummary = buildExecAmendmentSummary(request);
  const questionId = buildCodexCanonicalRequestIdentityKey(request.requestId);

  const options =
    request.kind === "command"
      ? request.networkApprovalContext
        ? [
            { label: "Yes, just this once", description: "" },
            { label: "Yes, and allow this host for this conversation", description: "" },
            ...((request.proposedNetworkPolicyAmendments?.length ?? 0) > 0
              ? [{ label: "Yes, and allow this host in the future", description: "" }]
              : []),
          ]
        : [
            { label: "Yes", description: "" },
            ...(execAmendmentSummary
              ? [
                  {
                    label: "Yes, and don't ask again for commands that start with this",
                    description: execAmendmentSummary,
                  },
                ]
              : [{ label: "Yes, and don't ask again this session", description: "" }]),
          ]
      : [
          { label: "Yes", description: "" },
          { label: "Yes, and don't ask again this session", description: "" },
        ];

  return {
    requestId: request.requestId,
    questions: [
      {
        id: questionId,
        header: prompt,
        question: prompt,
        isOther: true,
        isSecret: false,
        otherPlaceholder: "No, and tell Nodex what to do differently",
        options: options.filter((option) => {
          if (!request.availableDecisions) return true;
          const decision = mapApprovalResponse(request, option.label).decision;
          return request.availableDecisions.includes(
            typeof decision === "string" ? decision : Object.keys(decision)[0]!,
          );
        }),
      },
    ],
  };
}

function mapApprovalResponse(
  request: CodexApprovalRequest,
  selectedOptionLabel: string,
): CodexApprovalResponse {
  const scalarDecision =
    selectedOptionLabel === "Yes" || selectedOptionLabel === "Yes, just this once"
      ? "accept"
      : selectedOptionLabel === "Yes, and allow this host for this conversation" ||
          selectedOptionLabel === "Yes, and don't ask again this session"
        ? "acceptForSession"
        : null;
  if (scalarDecision) return { kind: request.kind, decision: scalarDecision };

  if (
    request.kind === "command" &&
    selectedOptionLabel === "Yes, and allow this host in the future"
  ) {
    const amendment =
      request.proposedNetworkPolicyAmendments?.find((candidate) => candidate.action === "allow") ??
      request.proposedNetworkPolicyAmendments?.[0] ??
      null;
    if (!amendment) return { kind: "command", decision: "acceptForSession" };
    return {
      kind: "command",
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      },
    };
  }

  if (
    request.kind === "command" &&
    selectedOptionLabel === "Yes, and don't ask again for commands that start with this"
  ) {
    const execPolicyAmendment = request.proposedExecpolicyAmendment ?? null;
    if (!execPolicyAmendment || execPolicyAmendment.length === 0) {
      return { kind: "command", decision: "acceptForSession" };
    }
    return {
      kind: "command",
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execPolicyAmendment,
        },
      },
    };
  }

  return { kind: request.kind, decision: "decline" };
}

function CommandPreviewBody({ request }: { request: CodexApprovalRequest }) {
  const preview = buildCodexCommandApprovalPreview(request);
  if (!preview) return null;

  if (preview.kind === "network") {
    return (
      <div className="px-3 py-2 text-sm text-token-description-foreground">{preview.reason}</div>
    );
  }

  return (
    <div className="px-3">
      <div className="bg-token-editor-background text-token-input-placeholder-foreground text-size-code flex w-full flex-col gap-1.5 rounded-md px-2 pt-2 pb-2 font-mono font-medium">
        <span className="block break-words whitespace-pre-wrap">{preview.commandText}</span>
      </div>
    </div>
  );
}

function formatPatchPreviewLabel(action: CodexFileChangePatchAction): string {
  if (action === "create") return "Created file";
  if (action === "delete") return "Deleted file";
  return "Edited file";
}

function PatchPreviewBody({ item }: { item: CodexConversationItem | null | undefined }) {
  if (!item) return null;
  const rows = buildCodexFileChangePatchRows(item.fileChange?.changes);
  if (rows.length === 0) return null;

  return (
    <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto px-2 py-2 text-sm">
      {rows.map((row) => (
        <div
          key={row.key}
          className="border-token-border bg-token-text-code-block-background flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-token-foreground">{formatPatchPreviewLabel(row.action)}</div>
            <div className="truncate text-token-description-foreground">
              {row.path || "Changed file"}
            </div>
          </div>
          {row.summary ? (
            <div className="shrink-0 text-xs text-token-description-foreground">
              +{row.summary.additions} -{row.summary.deletions}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function CodexApprovalRequestCard({
  request,
  requestItem,
  actorName = null,
  approvalQuestionActor,
  onRespond,
  onSubmitLocalFollowup,
}: CodexApprovalRequestCardProps) {
  const composerRequest = buildRequestQuestion(request, actorName);
  const prompt = buildPromptNode(request, actorName, approvalQuestionActor);
  const body =
    request.kind === "command" ? (
      <CommandPreviewBody request={request} />
    ) : (
      <PatchPreviewBody item={requestItem} />
    );

  return (
    <RequestComposerView
      header={prompt}
      body={body}
      showQuestionBodyWhenHeader={false}
      request={composerRequest}
      policy={EXPLICIT_REQUEST_FORM_POLICY}
      onSubmit={async (nextRequest, state) => {
        const questionId = nextRequest.questions[0]?.id;
        if (!questionId) {
          await onRespond(request.requestId, { kind: request.kind, decision: "decline" });
          return;
        }
        const answer = getRequestQuestionnaireAnswer(nextRequest, state, questionId);
        const selected = answer?.selectedOptionId;
        const freeform = answer?.freeformText?.trim() ?? "";

        if (selected === null) {
          await onRespond(request.requestId, { kind: request.kind, decision: "decline" });
          if (freeform && onSubmitLocalFollowup) {
            await onSubmitLocalFollowup(freeform);
          }
          return;
        }

        if (!selected) {
          await onRespond(request.requestId, { kind: request.kind, decision: "decline" });
          return;
        }

        await onRespond(request.requestId, mapApprovalResponse(request, selected));
      }}
      onSkip={async () => {
        await onRespond(request.requestId, { kind: request.kind, decision: "decline" });
      }}
      submitErrorMessage="Could not submit approval request"
      skipErrorMessage="Could not skip approval request"
    />
  );
}
