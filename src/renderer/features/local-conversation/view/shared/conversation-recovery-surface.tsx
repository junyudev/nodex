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
  recoveryDiagnosticText,
  recoveryProgressLabel,
  recoveryStatusLabel,
} from "../../projection/conversation-recovery-presentation";
import { ThreadActionIconButton } from "./thread-message-actions";
import { ThreadActivityHeader, ThreadActivityShell } from "./tools/tool-primitives";

export interface ConversationRecoverySurfaceProps {
  entry: CodexTranscriptEntry;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
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
    try {
      await onAction();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not complete this action.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
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
  onManageProvider,
  continuationState,
}: ConversationRecoverySurfaceProps) {
  const recovery = entry.recovery;
  const state = recovery?.state;
  const identity = `${entry.threadId}:${entry.entryId ?? entry.itemId}`;
  const [presence, setPresence] = useState<RecoveryPresence>(() => ({
    identity,
    state,
    visible: state !== "retrying" && state !== "recovered",
    expanded: false,
  }));
  const [now, setNow] = useState(Date.now);
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

  const retryAt = recovery?.retryAt;
  useEffect(() => {
    if (state !== "retrying" || retryAt == null || !Number.isFinite(retryAt)) return;
    const update = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= retryAt) window.clearInterval(interval);
    };
    const interval = window.setInterval(update, 1000);
    update();
    return () => window.clearInterval(interval);
  }, [retryAt, state]);

  const visible = presence.visible || presence.expanded;
  if (!visible) return null;

  const label = recovery ? recoveryStatusLabel(recovery) : (entry.markdownText ?? "Request failed");
  const progress = recovery ? recoveryProgressLabel(recovery, now) : null;
  const details = recoveryDiagnosticText(entry);
  const action = recoveryAction(recovery, true, false);
  const eligible = recoveryAction(recovery, isLatestTurn, isStreamingTurn) !== null;
  const actionCallback = action === "manage-provider" ? onManageProvider : onContinue;
  const actionLabel = action === "manage-provider" ? "Agent settings" : "Continue";

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
              actionState={action === "continue" ? continuationState : undefined}
              label={actionLabel}
              onAction={actionCallback}
            />
          ) : null}
        </div>
      }
      body={
        presence.expanded && details ? (
          <div className="mt-1 flex min-w-0 items-start gap-2">
            <pre
              className="max-h-48 min-w-0 flex-1 overflow-auto rounded-sm font-sans text-size-chat-sm whitespace-pre-wrap break-words semantic-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
              role="region"
              aria-label="Recovery diagnostics"
              tabIndex={0}
            >
              {details}
            </pre>
            <ThreadActionIconButton
              label={copied ? "Copied" : "Copy diagnostics"}
              tooltip={copied ? "Copied" : "Copy diagnostics"}
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
