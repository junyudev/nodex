import type { CodexProtocolRequestId, CodexUserInputRequest } from "../../../../../lib/types";
import { useEffect, useState } from "react";
import {
  REQUEST_INPUT_COMPOSER_POLICY,
  RequestComposerView,
  buildUserInputAnswers,
  type RequestComposerRequest,
  type RequestQuestionnaireDraft,
} from "../../shared/request-cards/local-conversation-request-cards";
import { useCodexUserInputDraft } from "../../../user-input-draft-state";
import {
  isUserInputAutoResolutionTracked,
  recordUserInputActivity,
  snoozeUserInput,
  useUserInputAutoResolution,
} from "../../../user-input-auto-resolution-state";
import type { CodexUserInputAutoResolutionEntry } from "../../../../../../shared/codex-user-input-auto-resolution";

interface CodexUserInputRequestCardProps {
  conversationId: string;
  request: CodexUserInputRequest;
  onRespond: (
    requestId: CodexProtocolRequestId,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  onInterrupt?: () => Promise<void>;
}

interface CodexUserInputRequestCardViewProps {
  request: RequestComposerRequest;
  autoResolution: CodexUserInputAutoResolutionEntry | null;
  initialDraft?: RequestQuestionnaireDraft;
  onDraftChange?: (draft: RequestQuestionnaireDraft) => void;
  onUserInteraction?: () => void;
  onRespond: (
    requestId: CodexProtocolRequestId,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  onDismiss?: (request: RequestComposerRequest) => Promise<void>;
  onResolved?: () => void;
}

export function CodexUserInputAutoResolutionCountdown({ deadlineMs }: { deadlineMs: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return;

    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      remainingMs > 60_000 ? remainingMs - 60_000 : Math.min(1_000, remainingMs),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [deadlineMs, now]);

  const seconds = Math.max(0, Math.ceil((deadlineMs - now) / 1_000));
  if (seconds <= 0 || seconds > 60) return null;

  return (
    <span
      className="inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-full bg-token-charts-orange/10 px-1.5 text-xs leading-none font-medium text-token-charts-orange tabular-nums"
      aria-label={`Auto-resolving in ${seconds} seconds`}
    >
      {seconds}s
    </span>
  );
}

export function CodexUserInputRequestCardView({
  request,
  autoResolution,
  initialDraft,
  onDraftChange,
  onUserInteraction,
  onRespond,
  onDismiss,
  onResolved,
}: CodexUserInputRequestCardViewProps) {
  return (
    <RequestComposerView
      request={request}
      policy={REQUEST_INPUT_COMPOSER_POLICY}
      headerAccessory={
        autoResolution?.phase.type === "scheduled" ? (
          <CodexUserInputAutoResolutionCountdown deadlineMs={autoResolution.phase.deadlineMs} />
        ) : null
      }
      initialDraft={initialDraft}
      onDraftChange={onDraftChange}
      onUserInteraction={onUserInteraction}
      onSubmit={async (nextRequest, state) => {
        await onRespond(nextRequest.requestId, buildUserInputAnswers(nextRequest, state));
        onResolved?.();
      }}
      onEscapeDismiss={async (nextRequest) => {
        if (onDismiss) {
          await onDismiss(nextRequest);
        } else {
          await onRespond(nextRequest.requestId, {});
        }
        onResolved?.();
      }}
      submitErrorMessage="Could not submit input request"
      dismissErrorMessage="Could not dismiss input request"
    />
  );
}

export function CodexUserInputRequestCard({
  conversationId,
  request,
  onRespond,
  onInterrupt,
}: CodexUserInputRequestCardProps) {
  const viewRequest = request.isOnboardingDynamicInput
    ? {
        ...request,
        questions: request.questions.map((question) => ({
          ...question,
          isOther: true,
          otherPlaceholder: "Something else",
        })),
      }
    : request;
  const { initialDraft, saveDraft, clearDraft } = useCodexUserInputDraft(
    conversationId,
    viewRequest,
  );
  const usesNativeAutoResolution = request.executionOwner !== "agent-runtime";
  const autoResolution = useUserInputAutoResolution(
    conversationId,
    request.requestId,
    usesNativeAutoResolution,
  );

  useEffect(() => {
    if (!usesNativeAutoResolution) return;
    const recordActivity = (event: KeyboardEvent | PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-user-input-auto-resolution]")) {
        return;
      }
      void recordUserInputActivity(conversationId);
    };
    window.addEventListener("keydown", recordActivity);
    window.addEventListener("pointerdown", recordActivity);
    return () => {
      window.removeEventListener("keydown", recordActivity);
      window.removeEventListener("pointerdown", recordActivity);
    };
  }, [conversationId, usesNativeAutoResolution]);

  return (
    <CodexUserInputRequestCardView
      request={viewRequest}
      autoResolution={autoResolution}
      initialDraft={initialDraft}
      onDraftChange={saveDraft}
      onUserInteraction={() => {
        if (!usesNativeAutoResolution) return;
        void snoozeUserInput(conversationId, request.requestId);
      }}
      onRespond={onRespond}
      onDismiss={async (nextRequest) => {
        if (!usesNativeAutoResolution) {
          await onInterrupt?.();
          return;
        }
        const claimed = await snoozeUserInput(conversationId, request.requestId);
        const tracked =
          claimed ||
          autoResolution !== null ||
          (await isUserInputAutoResolutionTracked(conversationId, request.requestId));
        if (request.isOnboardingDynamicInput || tracked) {
          await onRespond(nextRequest.requestId, {});
          return;
        }
        await onInterrupt?.();
      }}
      onResolved={clearDraft}
    />
  );
}
