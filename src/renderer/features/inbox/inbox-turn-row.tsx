import { FormattedMessage, useIntl, defineMessage } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { SPACE_ACTION_REASON_MESSAGES } from "../../../shared/space-connection";
import type { InboxItem } from "../../../shared/inbox";
import { PageTurnChip } from "@/components/workbench/page-turn-chip";
import {
  ChatIcon,
  ChevronDownIcon,
  ClockIcon,
  NodexLogoMarkIcon,
  OpenExternalIcon,
} from "@/components/shared/icons";
import { Reply } from "@/components/shared/icons/generic-icons";
import { InboxIconAction } from "./inbox-icon-action";
import { describeBackFromSnooze } from "./inbox-snooze";
import { SnoozeMenu } from "@/components/shared/snooze-menu";
import { useInboxClock } from "./use-inbox-clock";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { FileReferenceIntentProvider } from "@/lib/file-reference-intent";
import { useLibraryFileReadAuthority } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { extractMarkdownText, readMarkdown } from "../../../shared/nodex-markdown";
import { readableIpcError } from "@/lib/ipc-error-message";

/** An Inbox turn is always the reader's own. */
const READER = defineMessage({ id: "inbox.inboxTurnRow.readerName", defaultMessage: "You" });

/** The row explains Core's current episode and submits its exact action fence. */
export function InboxTurnRow({
  item,
  project = null,
  onOpenPage,
  onOpenChat,
  onReply,
  onAnswer,
  onAccept,
  onStart,
  onOpenPR,
  onSnooze,
}: {
  readonly item: InboxItem;
  /** Names the work's Project, where rows from every Project share the stream. */
  readonly project?: ReactNode;
  readonly onOpenPage: () => void;
  readonly onOpenChat: () => void;
  readonly onReply: () => void;
  readonly onAnswer: (label: string) => Promise<unknown>;
  readonly onAccept: () => Promise<unknown>;
  readonly onStart: () => Promise<unknown>;
  readonly onOpenPR: () => void;
  /** Sets this move aside until a time; a new reason to need the reader shows at once. */
  readonly onSnooze: (until: string) => void;
}) {
  const intl = useIntl();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostAvailable = useSpaceHostAvailable();
  const backFromSnooze = describeBackFromSnooze(
    item.snooze,
    new Date(useInboxClock()),
    intl.locale,
  );
  const data = item.turn;
  if (!data) return null;
  const reason = data.turn.reason;
  const act = (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    void runWithCleanup(action, {
      onError: (cause) => {
        setError(
          readableIpcError(
            cause,
            intl.formatMessage({
              id: "inbox.inboxTurnRow.couldnTCompleteThisAction",
              defaultMessage: "Couldn’t complete this action",
            }),
          ),
        );
      },
      cleanup: () => setPending(false),
    });
  };
  const replyable =
    reason === "question" ||
    reason === "review" ||
    reason === "blocked" ||
    reason === "failed" ||
    reason === "stalled";
  const unavailable = replyable && !data.active_chat;
  const openChatAsIcon = reason === "question" && data.options.length > 0;
  // A pending question is the Agent's exact words; everything else is written as Markdown.
  const exactQuestion = reason === "question" && !data.note_id;
  const problem =
    error ??
    data.delivery_error ??
    (unavailable
      ? intl.formatMessage({
          id: "inbox.inboxTurnRow.noActiveChatCanReceive",
          defaultMessage: "No active chat can receive a reply.",
        })
      : null);
  return (
    <div className="flex flex-col items-start gap-1">
      {backFromSnooze ? (
        <p
          data-testid="inbox-back-from-snooze"
          className="flex max-w-[80%] items-center gap-1 px-1 text-xs text-token-description-foreground"
        >
          <ClockIcon className="icon-2xs shrink-0" />
          <span className="truncate">{backFromSnooze}</span>
        </p>
      ) : null}
      {project ? <div className="flex max-w-[80%] min-w-0 px-1">{project}</div> : null}
      {/* One object, as a message is: what the Turn says on top and, joined to it, what to do
          about it. It keeps to its own words' width, so the reply never drifts away from what it
          answers. */}
      <article
        data-inbox-turn={reason}
        data-inbox-page-id={item.pageId}
        className="flex w-fit max-w-[80%] min-w-[min(18rem,80%)] flex-col overflow-hidden rounded-2xl border border-token-border"
      >
        <div className="flex flex-col gap-1 border-b border-token-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm font-medium"
              onClick={onOpenPage}
            >
              {item.title}
            </button>
            <PageTurnChip
              turn={data.turn}
              holder={{ you: true, name: intl.formatMessage(READER) }}
            />
          </div>
          <div className="flex min-w-0 items-start gap-1.5 text-sm text-token-description-foreground">
            {data.note_id ? (
              <span
                role="img"
                aria-label={intl.formatMessage({
                  id: "inbox.inboxTurnRow.noteFromNodex",
                  defaultMessage: "Note from Nodex",
                })}
                className="shrink-0"
              >
                <NodexLogoMarkIcon monochrome className="mt-0.5 size-3.5 shrink-0" />
              </span>
            ) : null}
            <TurnBody key={item.body} body={item.body} markdown={!exactQuestion} />
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
          {problem ? (
            <p role="status" className="min-w-0 flex-[1_1_12rem] text-xs text-danger">
              {problem}
            </p>
          ) : null}
          <div className="ml-auto flex min-h-6 flex-wrap items-center justify-end gap-1.5">
            <SnoozeMenu onChoose={onSnooze} />
            {openChatAsIcon ? (
              <InboxIconAction
                label={intl.formatMessage({
                  id: "inbox.inboxTurnRow.openChat",
                  defaultMessage: "Open chat",
                })}
                icon={ChatIcon}
                onClick={onOpenChat}
              />
            ) : null}
            {reason === "review" && data.pull_request_url ? (
              <InboxIconAction
                label={intl.formatMessage({
                  id: "inbox.inboxTurnRow.openPR",
                  defaultMessage: "Open PR",
                })}
                icon={OpenExternalIcon}
                onClick={onOpenPR}
              />
            ) : null}
            {replyable && data.active_chat ? (
              <NodexButton size="xs" variant="outline" className="gap-1.5" onClick={onReply}>
                <Reply className="icon-xs shrink-0" />
                <FormattedMessage id="inbox.inboxTurnRow.reply" defaultMessage="Reply" />
              </NodexButton>
            ) : null}
            {reason !== "ready_to_start" && !openChatAsIcon ? (
              <NodexButton
                size="xs"
                variant={reason === "review" ? "outline" : "primary"}
                className="gap-1.5"
                onClick={onOpenChat}
              >
                {reason === "review" ? <ChatIcon className="icon-xs shrink-0" /> : null}
                <FormattedMessage id="inbox.inboxTurnRow.openChat" defaultMessage="Open chat" />
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
                        <FormattedMessage id="inbox.inboxTurnRow.more" defaultMessage="More…" />
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
              </>
            ) : reason === "review" ? (
              <NodexButton
                size="xs"
                variant="primary"
                disabled={pending}
                onClick={() => act(onAccept)}
              >
                <FormattedMessage id="inbox.inboxTurnRow.accept" defaultMessage="Accept" />
              </NodexButton>
            ) : reason === "ready_to_start" ? (
              <NodexButton
                size="xs"
                variant="primary"
                disabled={pending || !hostAvailable}
                onClick={() => act(onStart)}
              >
                {hostAvailable
                  ? intl.formatMessage({ id: "inbox.inboxTurnRow.start", defaultMessage: "Start" })
                  : intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteAgent)}
              </NodexButton>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * What the Turn says: an excerpt of two lines that opens in place to the whole text, read as it
 * was written. Only a clipped excerpt offers to open.
 */
function TurnBody({ body, markdown }: { readonly body: string; readonly markdown: boolean }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {!expanded ? (
        <TurnExcerpt text={markdown ? extractMarkdownText(body) : body} onClipped={setClipped} />
      ) : markdown ? (
        <TurnDocument body={body} />
      ) : (
        <p className="min-w-0 whitespace-pre-wrap text-token-foreground">{body}</p>
      )}
      {expanded || clipped ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="cursor-interaction inline-flex items-center gap-1 text-xs hover:text-token-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? intl.formatMessage({ id: "inbox.inboxTurnRow.showLess", defaultMessage: "Show less" })
            : intl.formatMessage({
                id: "inbox.inboxTurnRow.showMore",
                defaultMessage: "Show more",
              })}
          <ChevronDownIcon
            className={cn("icon-2xs transition-transform duration-150", expanded && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}

/** The first two lines, telling its owner whether they leave any of the text out. */
function TurnExcerpt({
  text,
  onClipped,
}: {
  readonly text: string;
  readonly onClipped: (clipped: boolean) => void;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const excerpt = ref.current;
    if (!excerpt) return;
    const measure = () => onClipped(excerpt.scrollHeight > excerpt.clientHeight + 1);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(excerpt);
    return () => resize.disconnect();
  }, [onClipped]);
  return (
    <p ref={ref} className="line-clamp-2 min-w-0 whitespace-pre-wrap">
      {text}
    </p>
  );
}

/** The whole text as Markdown, with the Library's own access to the Files it links. */
function TurnDocument({ body }: { readonly body: string }) {
  const fileAuthority = useLibraryFileReadAuthority();
  return (
    <FileReferenceIntentProvider sidePanel={false} markdownContext>
      <FileReadBoundary authority={fileAuthority}>
        <NfmDocument
          blocks={readMarkdown(body)}
          density="message"
          className="codex-markdown min-w-0"
        />
      </FileReadBoundary>
    </FileReferenceIntentProvider>
  );
}
