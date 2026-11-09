import { useState } from "react";
import type { InboxItem } from "../../../shared/inbox";
import { PageTurnChip } from "@/components/workbench/page-turn-chip";
import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { extractMarkdownText } from "../../../shared/nodex-markdown";
import { readableIpcError } from "@/lib/ipc-error-message";

/** An Inbox turn is always the reader's own. */
const READER = { you: true, name: "You" } as const;

/** The row explains Core's current episode and submits its exact action fence. */
export function InboxTurnRow({
  item,
  onOpenPage,
  onOpenChat,
  onReply,
  onAnswer,
  onAccept,
  onStart,
  onOpenPR,
}: {
  readonly item: InboxItem;
  readonly onOpenPage: () => void;
  readonly onOpenChat: () => void;
  readonly onReply: () => void;
  readonly onAnswer: (label: string) => Promise<unknown>;
  readonly onAccept: () => Promise<unknown>;
  readonly onStart: () => Promise<unknown>;
  readonly onOpenPR: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = item.turn;
  if (!data) return null;
  const reason = data.turn.reason;
  const act = (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    void runWithCleanup(action, {
      onError: (cause) => {
        setError(readableIpcError(cause, "Couldn’t complete this action"));
      },
      cleanup: () => setPending(false),
    });
  };
  const open = (
    <NodexButton size="xs" variant="primary" onClick={onOpenChat}>
      Open chat
    </NodexButton>
  );
  const replyable =
    reason === "question" ||
    reason === "review" ||
    reason === "blocked" ||
    reason === "failed" ||
    reason === "stalled";
  const unavailable = replyable && !data.active_chat;
  return (
    <article data-inbox-turn={reason} data-inbox-page-id={item.pageId} className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium"
          onClick={onOpenPage}
        >
          {item.pageKey ? (
            <span className="mr-2 text-tertiary tabular-nums">{item.pageKey}</span>
          ) : null}{" "}
          {item.title}
        </button>
        <PageTurnChip turn={data.turn} holder={READER} />
      </div>
      {error || data.delivery_error || unavailable ? (
        <p role="status" className="mt-1 text-xs text-danger">
          {error ?? data.delivery_error ?? "No active chat can receive a reply."}
        </p>
      ) : null}
      <div className="mt-1 flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-[1_1_18rem] items-start gap-1.5 pt-0.5 text-sm text-token-description-foreground">
          {data.note_id ? (
            <span role="img" aria-label="Note from Nodex" className="shrink-0">
              <NodexLogoMarkIcon monochrome className="mt-0.5 size-3.5 shrink-0" />
            </span>
          ) : null}
          <p className="line-clamp-2 min-w-0 whitespace-pre-wrap">
            {reason === "question" && !data.note_id ? item.body : extractMarkdownText(item.body)}
          </p>
        </div>
        <div className="ml-auto flex min-h-6 flex-wrap items-center justify-end gap-1.5">
          {replyable && data.active_chat ? (
            <NodexButton size="xs" variant="ghost" onClick={onReply}>
              Reply
            </NodexButton>
          ) : null}
          {reason === "review" && (unavailable || data.delivery_error) ? (
            <NodexButton size="xs" variant="ghost" onClick={onOpenChat}>
              Open chat
            </NodexButton>
          ) : null}
          {reason === "review" && data.pull_request_url ? (
            <NodexButton size="xs" variant="ghost" onClick={onOpenPR}>
              Open PR
            </NodexButton>
          ) : null}
          {reason === "question" ? (
            <>
              {data.options.slice(0, 4).map((label) => (
                <NodexButton
                  key={label}
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => act(() => onAnswer(label))}
                >
                  {label}
                </NodexButton>
              ))}
              {data.options.length > 4 ? (
                <NodexDropdownMenu
                  align="end"
                  triggerButton={
                    <NodexButton size="xs" variant="ghost" disabled={pending}>
                      More…
                    </NodexButton>
                  }
                >
                  {data.options.slice(4).map((label) => (
                    <NodexDropdownItem key={label} onSelect={() => act(() => onAnswer(label))}>
                      {label}
                    </NodexDropdownItem>
                  ))}
                </NodexDropdownMenu>
              ) : null}
              {data.options.length === 0 || unavailable || data.delivery_error ? open : null}
            </>
          ) : reason === "review" ? (
            <NodexButton
              size="xs"
              variant="primary"
              disabled={pending}
              onClick={() => act(onAccept)}
            >
              Accept
            </NodexButton>
          ) : reason === "ready_to_start" ? (
            <NodexButton
              size="xs"
              variant="primary"
              onClick={() => act(onStart)}
            >
            </NodexButton>
          ) : (
            open
          )}
        </div>
      </div>
    </article>
  );
}
