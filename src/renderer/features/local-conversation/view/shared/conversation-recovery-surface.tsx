import { getIntl, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useEffect, useRef, useState } from "react";
import type { ConversationRecoveryState } from "../../../../../shared/conversation-recovery";
import type { CodexTranscriptEntry } from "../../../../../shared/types";
import { CheckmarkIcon, CopyIcon } from "@/components/shared/icons";
import { writeTextToClipboard } from "@/lib/clipboard";
import { useCopyFeedback } from "@/lib/use-copy-feedback";
import { cn } from "@/lib/utils";
import {
  RECOVERY_CONFIRMATION_MS,
  RECOVERY_REVEAL_DELAY_MS,
  recoveryAction,
  recoveryDiagnosticSummary,
  recoveryDiagnosticText,
  recoveryProgressLabel,
  recoveryStatusLabel,
} from "../../projection/conversation-recovery-presentation";
import { ThreadActionIconButton } from "./thread-message-actions";
import { ThreadActivityHeader, ThreadActivityShell } from "./tools/tool-primitives";
import { useRecoveryNow } from "./use-recovery-now";

export interface ConversationRecoverySurfaceProps {
  entry: CodexTranscriptEntry;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  onCompactAndRetry?: () => void | Promise<void>;
  onContinue?: () => void | Promise<void>;
  onManageProvider?: () => void | Promise<void>;
  continuationState?: { readonly pending: boolean; readonly error: string | null };
}

interface RecoveryPresence {
  identity: string;
  state: ConversationRecoveryState | undefined;
  visible: boolean;
  expanded: boolean;
}

function RecoveryActionButton({
  eligible,
  actionState,
  label,
  onAction,
}: {
  eligible: boolean;
  actionState?: ConversationRecoverySurfaceProps["continuationState"];
  label: string;
  onAction: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleAction = async () => {
    if (!eligible || actionState?.pending || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    return runWithCleanup(
      async () => {
        await onAction();
      },
      {
        onError: (cause) => {
          if (mounted.current)
            setError(
              cause instanceof Error
                ? cause.message
                : getIntl().formatMessage({
                    id: "conversation.conversationRecoverySurface.actionFailed",
                    defaultMessage: "Could not complete this action.",
                  }),
            );
        },
        cleanup: () => {
          inFlight.current = false;
          if (mounted.current) setPending(false);
        },
      },
    );
  };

  // A submitted optimistic turn can temporarily make this failed turn historical.
  // Keep its controller alive so a rejected submission is visible after rollback.
  if (!eligible) return null;
  const isPending = actionState?.pending ?? pending;
  const actionError = actionState ? actionState.error : error;

  return (
    <>
      <button
        type="button"
        className="cursor-interaction rounded-sm text-size-chat text-token-foreground underline decoration-token-border underline-offset-4 hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border disabled:cursor-wait disabled:opacity-50"
        disabled={isPending}
        aria-busy={isPending}
        onClick={handleAction}
      >
        {label}
      </button>
      {actionError ? (
        <span className="text-size-chat-sm text-danger" role="alert">
          {actionError}
        </span>
      ) : null}
    </>
  );
}

export function ConversationRecoverySurface({
  entry,
  isLatestTurn,
  isStreamingTurn,
  onContinue,
  onCompactAndRetry,
  onManageProvider,
  continuationState,
}: ConversationRecoverySurfaceProps) {
  const intl = useIntl();
  const recovery = entry.recovery;
  const state = recovery?.state;
  const identity = `${entry.threadId}:${entry.entryId ?? entry.itemId}`;
  const [presence, setPresence] = useState<RecoveryPresence>(() => ({
    identity,
    state,
    visible: state !== "retrying" && state !== "recovered",
    expanded: false,
  }));
  const now = useRecoveryNow(recovery);
  const { copied, copy } = useCopyFeedback(1500);

  // Only a recovery observed in this mounted row receives transient confirmation.
  if (presence.identity !== identity || presence.state !== state) {
    const sameEntry = presence.identity === identity;
    setPresence({
      identity,
      state,
      visible:
        state === "recovered"
          ? sameEntry && presence.state === "retrying" && presence.visible
          : state !== "retrying",
      expanded: sameEntry && presence.expanded,
    });
  }

  useEffect(() => {
    if (state !== "retrying" && state !== "recovered") return;
    const visible = state === "retrying";
    const timeout = window.setTimeout(
      () =>
        setPresence((current) =>
          current.identity === identity && current.state === state
            ? { ...current, visible }
            : current,
        ),
      visible ? RECOVERY_REVEAL_DELAY_MS : RECOVERY_CONFIRMATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [identity, state]);

  const visible = presence.visible || presence.expanded;
  if (!visible) return null;

  const label =
    recovery?.reason === "model_not_applied" && entry.markdownText
      ? entry.markdownText
      : recovery
        ? recoveryStatusLabel(recovery, intl)
        : (entry.markdownText ??
          intl.formatMessage({
            id: "conversation.conversationRecoverySurface.requestFailed",
            defaultMessage: "Request failed",
          }));
  const progress = recovery ? recoveryProgressLabel(recovery, now, intl) : null;
  const details = recoveryDiagnosticText(entry);
  // The status row already says the state, cause and attempt; copying keeps all of them.
  const summary = recoveryDiagnosticSummary(entry) || details;
  const action = recoveryAction(recovery, true, false);
  const eligible = recoveryAction(recovery, isLatestTurn, isStreamingTurn) !== null;
  const actionCallback =
    action === "manage-provider"
      ? onManageProvider
      : action === "compact-and-retry"
        ? onCompactAndRetry
        : onContinue;
  const actionLabel =
    action === "manage-provider"
      ? intl.formatMessage({
          id: "conversation.conversationRecoverySurface.agentSettings",
          defaultMessage: "Agent settings",
        })
      : action === "compact-and-retry"
        ? intl.formatMessage({
            id: "conversation.conversationRecoverySurface.compactAndRetry",
            defaultMessage: "Compact and retry",
          })
        : intl.formatMessage({
            id: "conversation.conversationRecoverySurface.continue",
            defaultMessage: "Continue",
          });

  return (
    <ThreadActivityShell
      header={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <ThreadActivityHeader
            className={cn(
              "min-h-5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",
              state === "failed" ? "text-danger" : "semantic-text-secondary",
            )}
            disclosure={
              details
                ? {
                    expanded: presence.expanded,
                    onToggle: () =>
                      setPresence((current) => ({ ...current, expanded: !current.expanded })),
                  }
                : undefined
            }
          >
            <span>
              <span role={isLatestTurn ? "status" : undefined}>{label}</span>
              {progress ? ` · ${progress}` : null}
            </span>
          </ThreadActivityHeader>
          {action && actionCallback ? (
            <RecoveryActionButton
              key={`${identity}:${action}`}
              eligible={eligible}
              actionState={action !== "manage-provider" ? continuationState : undefined}
              label={actionLabel}
              onAction={actionCallback}
            />
          ) : null}
        </div>
      }
      body={
        presence.expanded && details ? (
          <div className="mt-1 flex min-w-0 items-start gap-1">
            <pre
              className="max-h-48 min-w-0 overflow-auto rounded-sm font-sans text-size-chat-sm whitespace-pre-wrap break-words semantic-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
              role="region"
              aria-label={intl.formatMessage({
                id: "conversation.conversationRecoverySurface.diagnostics",
                defaultMessage: "Recovery diagnostics",
              })}
              tabIndex={0}
            >
              {summary}
            </pre>
            <ThreadActionIconButton
              className="-mt-0.5 shrink-0"
              label={
                copied
                  ? intl.formatMessage({
                      id: "conversation.conversationRecoverySurface.copied",
                      defaultMessage: "Copied",
                    })
                  : intl.formatMessage({
                      id: "conversation.conversationRecoverySurface.copyDiagnostics",
                      defaultMessage: "Copy diagnostics",
                    })
              }
              tooltip={
                copied
                  ? intl.formatMessage({
                      id: "conversation.conversationRecoverySurface.copied",
                      defaultMessage: "Copied",
                    })
                  : intl.formatMessage({
                      id: "conversation.conversationRecoverySurface.copyDiagnostics",
                      defaultMessage: "Copy diagnostics",
                    })
              }
              onClick={() => void copy(() => writeTextToClipboard(details))}
            >
              {copied ? <CheckmarkIcon className="icon-xs" /> : <CopyIcon className="icon-xs" />}
            </ThreadActionIconButton>
          </div>
        ) : null
      }
    />
  );
}
