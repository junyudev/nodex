import { createReactBlockSpec, useEditorState } from "@blocknote/react";
import { useEffect, useState, type MouseEvent } from "react";
import { ActivitySpinnerIcon, ChevronRightIcon, UpArrowIcon } from "@/components/shared/icons";
import { CornerDownRight } from "@/components/shared/icons/generic-icons";
import { PageChatActivityGlyph } from "@/components/shared/page-chat-activity-glyph";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useAgentRuntimeSessionStatus } from "@/lib/agent-runtime-session-activity";
import { cn } from "@/lib/utils";
import { promptBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { reportNfmChatSendFailure } from "./nfm-chat-send-feedback";
import {
  describeNfmPromptSend,
  findNfmPromptBlockAtCaret,
  resolveNfmPromptSentPresentation,
} from "./nfm-prompt-block-model";
import { useNfmPromptCollapsed, writeNfmPromptCollapsed } from "./nfm-prompt-collapse-store";
import { useNfmPromptRuntime } from "./nfm-prompt-runtime";
import { resolveNfmSendToThreadTitle } from "./nfm-send-to-thread-menu-model";
import { useThreadMentionRuntime } from "./thread-mention-chip";

const PROMPT_SEND_SHORTCUT_LABEL = "⌘↵";

function keepEditorSelection(event: MouseEvent<HTMLElement>) {
  if (event.button === 0) event.preventDefault();
}

/** A minute clock for relative send times, shared by nothing else and stopped on unmount. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function PromptMarker({
  hasChildren,
  collapsed,
  onToggle,
}: {
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const glyph = <CornerDownRight className="size-4" aria-hidden="true" />;
  if (!hasChildren) {
    return (
      <span
        contentEditable={false}
        className="flex h-6 w-5 shrink-0 select-none items-center justify-center text-token-description-foreground"
      >
        {glyph}
      </span>
    );
  }
  // Like a sidebar folder, the marker becomes the disclosure under the pointer.
  return (
    <button
      type="button"
      contentEditable={false}
      aria-label={collapsed ? "Expand prompt" : "Collapse prompt"}
      aria-expanded={!collapsed}
      className="group/prompt-marker flex h-6 w-5 shrink-0 cursor-interaction select-none items-center justify-center rounded-[5px] text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-secondary"
      onMouseDown={keepEditorSelection}
      onClick={onToggle}
    >
      {collapsed ? (
        <ChevronRightIcon className="size-4" />
      ) : (
        <>
          <span className="group-hover/prompt-marker:hidden">{glyph}</span>
          <ChevronRightIcon className="hidden size-4 rotate-90 group-hover/prompt-marker:block" />
        </>
      )}
    </button>
  );
}

function PromptSentStatus({ sessionId, sentAt }: { sessionId: string; sentAt: string }) {
  const status = useAgentRuntimeSessionStatus(sessionId);
  const mentions = useThreadMentionRuntime();
  const now = useMinuteNow();
  const thread = mentions.sessions[sessionId] ?? null;
  const resolveSession = mentions.resolveSession;
  useEffect(() => {
    if (thread || !resolveSession) return;
    void resolveSession(sessionId).catch(() => null);
  }, [resolveSession, sessionId, thread]);

  const presentation = resolveNfmPromptSentPresentation({ status, sentAt, nowMs: now });
  const title = thread ? resolveNfmSendToThreadTitle(thread) : null;
  const openSession = mentions.openSession;
  return (
    <NodexTooltip tooltipContent={title ? `Open ${title}` : "Open chat"} side="top" delay={0}>
      <button
        type="button"
        contentEditable={false}
        data-nfm-prompt-status={presentation.tone}
        disabled={!openSession}
        className={cn(
          "inline-flex h-6 max-w-56 shrink-0 cursor-interaction select-none items-center gap-0.5 rounded-[6px] pr-1.5 text-xs text-token-description-foreground",
          "hover:bg-token-foreground/5 hover:text-token-text-secondary disabled:cursor-default",
          presentation.tone === "attention" && "text-token-warning-foreground",
        )}
        onMouseDown={keepEditorSelection}
        onClick={() => openSession?.(sessionId)}
      >
        <PageChatActivityGlyph
          activity={{
            execution:
              status === "running"
                ? "working"
                : status === "background"
                  ? "background"
                  : status === "waiting"
                    ? "input"
                    : "idle",
            unread: false,
          }}
          className={presentation.tone === "attention" ? "text-current" : undefined}
        />
        <span className="truncate">{presentation.label}</span>
      </button>
    </NodexTooltip>
  );
}

function PromptSendButton({
  label,
  disabled,
  visible,
  onSend,
}: {
  label: string;
  disabled: boolean;
  visible: boolean;
  onSend: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <NodexTooltip
      tooltipContent={label}
      shortcutLabel={PROMPT_SEND_SHORTCUT_LABEL}
      side="top"
      delay={0}
    >
      <button
        type="button"
        contentEditable={false}
        aria-label={label}
        aria-busy={pending || undefined}
        disabled={disabled || pending}
        data-nfm-prompt-send=""
        className={cn(
          "flex size-6 shrink-0 cursor-interaction select-none items-center justify-center rounded-full bg-composer-primary text-composer-primary transition-opacity duration-150",
          "disabled:cursor-default disabled:opacity-40",
          visible || pending ? "opacity-100" : "opacity-0 group-hover/prompt:opacity-100",
          "focus-visible:opacity-100",
        )}
        onMouseDown={keepEditorSelection}
        onClick={() => {
          if (pending) return;
          setPending(true);
          void onSend()
            .catch((error: unknown) => reportNfmChatSendFailure("send", error))
            .finally(() => setPending(false));
        }}
      >
        {pending ? (
          <ActivitySpinnerIcon className="size-3.5" />
        ) : (
          <UpArrowIcon className="size-3.5" />
        )}
      </button>
    </NodexTooltip>
  );
}

export const createPromptBlockSpec = createReactBlockSpec(promptBlockConfig, {
  render: function PromptBlockView({ block, editor, contentRef }) {
    const runtime = useNfmPromptRuntime();
    const hasChildren = block.children.length > 0;
    const collapsed = useNfmPromptCollapsed(block.id) && hasChildren;
    const caretWithin = useEditorState({
      editor,
      selector: ({ editor: current }) =>
        findNfmPromptBlockAtCaret(current as Parameters<typeof findNfmPromptBlockAtCaret>[0]) ===
        block.id,
    });
    const isEmpty = !hasChildren && (!Array.isArray(block.content) || block.content.length === 0);
    const sentSessionId = block.props.sentSessionId;
    const destination = editor.isEditable ? runtime.destination : null;

    return (
      <div
        data-nfm-prompt=""
        data-prompt-collapsed={collapsed ? "true" : "false"}
        className="group/prompt flex w-full min-w-0 items-start gap-1.5"
      >
        <PromptMarker
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggle={() => writeNfmPromptCollapsed(block.id, !collapsed)}
        />
        <div ref={contentRef} className="min-w-0 flex-1" />
        <div contentEditable={false} className="flex h-6 shrink-0 items-center gap-1">
          {sentSessionId ? (
            <PromptSentStatus sessionId={sentSessionId} sentAt={block.props.sentAt} />
          ) : null}
          {destination ? (
            <PromptSendButton
              label={describeNfmPromptSend(destination, Boolean(sentSessionId))}
              disabled={isEmpty}
              visible={caretWithin}
              onSend={() => runtime.send(block.id)}
            />
          ) : null}
        </div>
      </div>
    );
  },
  toExternalHTML: (props) => <p ref={props.contentRef} />,
});
