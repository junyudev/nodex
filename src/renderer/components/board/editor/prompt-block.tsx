import { createReactBlockSpec, useEditorState } from "@blocknote/react";
import { useEffect, useState, type MouseEvent } from "react";
import { ActivitySpinnerIcon, ChevronRightIcon, UpArrowIcon } from "@/components/shared/icons";
import { CornerDownRight } from "@/components/shared/icons/generic-icons";
import { PageChatActivityGlyph } from "@/components/shared/page-chat-activity-glyph";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverTrigger } from "@/components/ui/popover";
import { useOpenChatAtMessage } from "@/features/local-conversation/chat-message-navigation";
import { usePromptTurn } from "@/lib/prompt-turn";
import { pageChatWindowQueryOptions } from "@/lib/query-options";
import { useInfiniteQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatAcceleratorLabel } from "../../../../shared/command-keybindings";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
import { promptBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { reportNfmChatSendFailure } from "./nfm-chat-send-feedback";
import {
  describeNfmPromptSend,
  describeNfmPromptSentAt,
  describeNfmPromptTurnState,
  findNfmPromptBlockAtCaret,
  nfmPromptStartsNewTurn,
  resolveNfmPromptSentPresentation,
} from "./nfm-prompt-block-model";
import { NfmEditorPopoverContent } from "./nfm-editor-popover-content";
import { NfmChatSendTooltip } from "./nfm-chat-send-tooltip";
import { useNfmPromptCollapsed, writeNfmPromptCollapsed } from "./nfm-prompt-collapse-store";
import { useNfmPromptRuntime } from "./nfm-prompt-runtime";
import { resolveNfmSendToThreadTitle } from "./nfm-send-to-thread-menu-model";
import { useThreadMentionRuntime } from "./thread-mention-chip";

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

function PromptSentRecord({
  promptBlockId,
  sessionId,
  messageId,
  sentAt,
  editable,
}: {
  promptBlockId: string;
  sessionId: string;
  messageId: string;
  sentAt: string;
  editable: boolean;
}) {
  const runtime = useNfmPromptRuntime();
  const turn = usePromptTurn({ sessionId, messageId });
  const openChatAtMessage = useOpenChatAtMessage();
  const mentions = useThreadMentionRuntime();
  const now = useMinuteNow();
  const [open, setOpen] = useState(false);
  const thread = mentions.sessions[sessionId] ?? null;
  const resolveSession = mentions.resolveSession;
  useEffect(() => {
    if (thread || !resolveSession) return;
    void resolveSession(sessionId).catch(() => null);
  }, [resolveSession, sessionId, thread]);
  // A sent Prompt links its Page to the chat, so the Page's Linked chats carry its live title.
  const linkedChats = useInfiniteQuery({
    ...pageChatWindowQueryOptions({
      pageId: runtime.pageId ?? "",
      includeArchived: false,
      first: 20,
    }),
    enabled: Boolean(runtime.pageId),
  });
  const linkedTitle = linkedChats.data?.pages
    .flatMap((window) => window.items)
    .find((chat) => chat.sessionId === sessionId)?.displayTitle;

  // A record that names its message follows that message's own Turn; older ones only tell time.
  const phase = messageId ? turn.phase : null;
  const presentation = resolveNfmPromptSentPresentation({ phase, sentAt, nowMs: now });
  const title = linkedTitle || (thread ? resolveNfmSendToThreadTitle(thread) : "its chat");
  const reply = phase === "done" ? turn.reply : null;
  const insertReply = editable ? runtime.insertReply : null;
  const openChat = () => {
    setOpen(false);
    if (messageId) void openChatAtMessage({ sessionId, messageId });
    else mentions.openSession?.(sessionId);
  };

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <button
          type="button"
          contentEditable={false}
          data-nfm-prompt-status={presentation.tone}
          className={cn(
            "inline-flex h-6 max-w-56 shrink-0 cursor-interaction select-none items-center gap-0.5 rounded-[6px] pr-1.5 text-xs text-token-description-foreground",
            "hover:bg-token-foreground/5 hover:text-token-text-secondary aria-expanded:bg-token-foreground/5",
            presentation.tone === "attention" && "text-token-warning-foreground",
            presentation.tone === "done" && "text-token-text-secondary",
          )}
          onMouseDown={keepEditorSelection}
        >
          <PageChatActivityGlyph
            activity={{
              execution: phase === "working" ? "working" : phase === "waiting" ? "input" : "idle",
              unread: false,
            }}
            className={presentation.tone === "attention" ? "text-current" : undefined}
          />
          <span className="truncate">{presentation.label}</span>
        </button>
      </NodexPopoverTrigger>
      <NfmEditorPopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label="Prompt reply"
        className="flex w-[min(30rem,calc(100vw-24px))] flex-col overflow-hidden p-0 text-sm"
      >
        <div className="truncate px-3 pt-2.5 pb-2 text-xs text-token-description-foreground">
          {describeNfmPromptSentAt(sentAt, now)} to {title}
        </div>
        {reply && runtime.renderReply ? (
          <div className="max-h-80 overflow-auto border-y-[0.5px] border-token-border px-3 py-1">
            {runtime.renderReply(reply)}
          </div>
        ) : (
          <p className="px-3 pb-1 text-token-text-secondary">{describeNfmPromptTurnState(phase)}</p>
        )}
        <div className="flex justify-end gap-1 p-2">
          <NodexButton variant="ghostSecondary" size="xs" onClick={openChat}>
            Open in chat
          </NodexButton>
          {reply && insertReply ? (
            <NodexButton
              variant="primary"
              size="xs"
              onClick={() => {
                setOpen(false);
                insertReply(promptBlockId, reply);
              }}
            >
              Insert reply
            </NodexButton>
          ) : null}
        </div>
      </NfmEditorPopoverContent>
    </NodexPopover>
  );
}

function PromptSendButton({
  label,
  sessionId,
  startsNewTurn,
  disabled,
  visible,
  onSend,
}: {
  label: string;
  sessionId: string | null;
  startsNewTurn: boolean;
  disabled: boolean;
  visible: boolean;
  onSend: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <NodexTooltip
      tooltipContent={
        <NfmChatSendTooltip label={label} sessionId={sessionId} startsNewTurn={startsNewTurn} />
      }
      shortcutLabel={formatAcceleratorLabel(
        "CmdOrCtrl+Enter",
        resolveCodexRendererCommandPlatform(),
      )}
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
            <PromptSentRecord
              promptBlockId={block.id}
              sessionId={sentSessionId}
              messageId={block.props.sentMessageId}
              sentAt={block.props.sentAt}
              editable={editor.isEditable}
            />
          ) : null}
          {destination ? (
            <PromptSendButton
              label={describeNfmPromptSend(destination, Boolean(sentSessionId))}
              sessionId={destination.kind === "beside" ? destination.sessionId : null}
              startsNewTurn={nfmPromptStartsNewTurn(block)}
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
