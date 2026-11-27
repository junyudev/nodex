import { useIntl, type IntlShape } from "@/lib/i18n";
import type { ChatRequest, ChatState } from "@nodex/mobile-protocol";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  CloseIcon,
  PermissionFullAccessWarningIcon,
  QuestionIcon,
  SendToChatIcon,
  StopIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { companion } from "./mini-host";
import { pageTurnAskOfReader } from "@/lib/page-turn-phrase";
import type { MiniCard as MiniCardModel, MiniTurnReason } from "./mini-model";
import { sendToChat, stopChat, useMiniChatState } from "./use-mini-chat";

/**
 * Mini's one material, in the app's light or dark: an opaque elevated surface with a hairline and
 * a shadow deep enough to lift it off whatever app is beneath.
 */
export const MINI_SURFACE_CLASS =
  "bg-background-composer-surface text-token-foreground ring-1 ring-token-foreground/[0.08] shadow-[0_10px_28px_-10px_rgb(0_0_0/0.22),0_2px_6px_-2px_rgb(0_0_0/0.1)] dark:shadow-[0_12px_32px_-12px_rgb(0_0_0/0.6),0_2px_8px_-2px_rgb(0_0_0/0.3)]";

const CARD_ACTION_CLASS =
  "cursor-interaction inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs text-token-foreground bg-token-foreground/[0.07] hover:bg-token-foreground/[0.12] disabled:opacity-40";
const CARD_PRIMARY_ACTION_CLASS =
  "cursor-interaction inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-medium bg-token-foreground text-token-bg-primary hover:opacity-90 disabled:opacity-40";
const CARD_ICON_CLASS =
  "cursor-interaction flex size-6 items-center justify-center rounded-full text-token-text-secondary hover:bg-token-foreground/[0.08] hover:text-token-foreground";

/**
 * One chat or Page Turn that is the person's concern. Its glyph says how it stands, its line what
 * it asks or is doing, and it answers in place what a short answer can settle: a choice, an
 * approval, Accept, a reply, Stop. Anything longer opens in Nodex.
 */
export function MiniCard({
  card,
  front,
  replying,
  onReply,
  onOpen,
  onDismiss,
  onRetryStart,
  onTakeBackStart,
}: {
  readonly card: MiniCardModel;
  /** The card in front follows its chat live; the ones behind only show how they stand. */
  readonly front: boolean;
  readonly replying: boolean;
  /** Opens or closes this card's reply, which needs the keyboard. */
  readonly onReply: (open: boolean) => void;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
  /** For a chat Mini could not start: send it again as it was. */
  readonly onRetryStart: () => void;
  /** For a chat Mini could not start: put its message back in the composer. */
  readonly onTakeBackStart: () => void;
}) {
  const intl = useIntl();
  const chatId = card.kind === "turn" ? null : card.sessionId;
  const following =
    front && card.kind === "chat" && (card.tone === "attention" || card.tone === "working");
  const state = useMiniChatState(chatId ?? "", following && chatId !== null);
  const [busy, setBusy] = useState(false);
  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void task()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const canReply =
    card.kind === "turn" ? card.canReply : card.kind === "chat" ? card.canSend : false;
  const runId = state?.activeRunId ?? null;
  const canStop =
    card.kind === "chat" && card.tone === "working" && runId !== null && !state?.stopBlockedReason;

  return (
    <div
      data-mini-drawn
      data-mini-card={card.key}
      className={cn("group/card relative w-full rounded-[18px] px-3.5 py-2.5", MINI_SURFACE_CLASS)}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center">
          <CardGlyph tone={card.tone} />
        </span>
        <button
          type="button"
          className="cursor-interaction min-w-0 flex-1 text-left outline-none"
          onClick={onOpen}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium">
              {card.title ||
                intl.formatMessage({ id: "mini.card.untitled", defaultMessage: "New chat" })}
            </span>
            {card.project ? (
              <span className="shrink-0 truncate text-[11px] text-token-description-foreground group-hover/card:hidden">
                {card.project}
              </span>
            ) : null}
          </span>
          <CardLine card={card} intl={intl} />
        </button>
        <span className="-mr-1 hidden shrink-0 items-center gap-0.5 group-hover/card:flex">
          {canReply ? (
            <CardIcon
              label={intl.formatMessage({ id: "mini.card.reply", defaultMessage: "Reply" })}
              onClick={() => onReply(!replying)}
            >
              <SendToChatIcon className="icon-xs" />
            </CardIcon>
          ) : null}
          {canStop ? (
            <CardIcon
              label={intl.formatMessage({ id: "mini.card.stop", defaultMessage: "Stop" })}
              onClick={() => run(() => stopChat(card.sessionId, runId))}
            >
              <StopIcon className="icon-xs" />
            </CardIcon>
          ) : null}
          <CardIcon
            label={intl.formatMessage({ id: "mini.card.dismiss", defaultMessage: "Dismiss" })}
            onClick={onDismiss}
          >
            <CloseIcon className="icon-2xs" />
          </CardIcon>
        </span>
      </div>
      {card.kind === "starting" && card.tone === "failed" ? (
        <CardActions>
          <button type="button" className={CARD_PRIMARY_ACTION_CLASS} onClick={onRetryStart}>
            {intl.formatMessage({ id: "mini.start.retry", defaultMessage: "Try again" })}
          </button>
          <button type="button" className={CARD_ACTION_CLASS} onClick={onTakeBackStart}>
            {intl.formatMessage({ id: "mini.start.edit", defaultMessage: "Edit" })}
          </button>
        </CardActions>
      ) : front ? (
        <CardDecision card={card} state={state} busy={busy} run={run} onOpen={onOpen} intl={intl} />
      ) : null}
      {replying && canReply ? (
        <CardReply
          placeholder={
            card.kind === "turn"
              ? intl.formatMessage({ id: "mini.card.replyToTurn", defaultMessage: "Reply…" })
              : intl.formatMessage({
                  id: "mini.card.replyToChat",
                  defaultMessage: "Reply to this chat…",
                })
          }
          onCancel={() => onReply(false)}
          onSend={(text) =>
            run(async () => {
              if (card.kind === "turn")
                await companion("inbox.decide", {
                  operationId: createUuidV7(),
                  entryId: card.entryId,
                  decision: { type: "turn_reply", episode: card.episode, text },
                });
              else await sendToChat(card.sessionId, text);
              onReply(false);
            })
          }
        />
      ) : null}
    </div>
  );
}

function CardGlyph({ tone }: { readonly tone: MiniCardModel["tone"] }) {
  switch (tone) {
    case "attention":
      return <QuestionIcon className="icon-xs text-token-text-link-foreground" />;
    case "failed":
      return <PermissionFullAccessWarningIcon className="icon-xs text-warning" />;
    case "done":
      return <CheckmarkIcon className="icon-xs text-token-charts-green" />;
    case "starting":
    case "working":
      return <ActivitySpinnerIcon className="icon-xs text-token-text-secondary" />;
  }
}

function CardLine({ card, intl }: { readonly card: MiniCardModel; readonly intl: IntlShape }) {
  const fallback = (() => {
    switch (card.tone) {
      case "starting":
        return intl.formatMessage({ id: "mini.card.starting", defaultMessage: "Starting chat…" });
      case "working":
        return intl.formatMessage({ id: "mini.card.working", defaultMessage: "Working…" });
      case "done":
        return intl.formatMessage({ id: "mini.card.done", defaultMessage: "Finished" });
      case "failed":
        return card.kind === "starting"
          ? intl.formatMessage({
              id: "mini.card.startFailed",
              defaultMessage: "Couldn’t start this chat",
            })
          : intl.formatMessage({ id: "mini.card.failed", defaultMessage: "Couldn’t finish" });
      case "attention":
        return card.kind === "turn"
          ? turnAsk(card.reason)
          : intl.formatMessage({ id: "mini.card.needsYou", defaultMessage: "Needs you" });
    }
  })();
  return (
    <span
      className={cn(
        "mt-0.5 block text-[12.5px] leading-[1.35] text-token-text-secondary",
        card.tone === "attention" ? "line-clamp-3 text-token-foreground/80" : "line-clamp-2",
      )}
    >
      {card.kind === "turn" && card.tone === "attention" ? (
        <>
          <span className="text-token-text-link-foreground">{turnAsk(card.reason)}</span>
          {card.line ? ` · ${card.line}` : null}
        </>
      ) : (
        (card.line ?? fallback)
      )}
    </span>
  );
}

const turnAsk = (reason: MiniTurnReason): string => pageTurnAskOfReader(reason) ?? "";

/** What the front card can settle in place, as the phone settles it. */
function CardDecision({
  card,
  state,
  busy,
  run,
  onOpen,
  intl,
}: {
  readonly card: MiniCardModel;
  readonly state: ChatState | null;
  readonly busy: boolean;
  readonly run: (task: () => Promise<unknown>) => void;
  readonly onOpen: () => void;
  readonly intl: IntlShape;
}) {
  const decide = (decision: Parameters<typeof companion<"inbox.decide">>[1]["decision"]) => {
    if (card.kind !== "turn") return;
    run(() =>
      companion("inbox.decide", { operationId: createUuidV7(), entryId: card.entryId, decision }),
    );
  };
  if (card.kind === "turn") {
    if (card.reason === "review")
      return (
        <CardActions>
          <button
            type="button"
            disabled={busy}
            className={CARD_PRIMARY_ACTION_CLASS}
            onClick={() => decide({ type: "turn_accept", episode: card.episode })}
          >
            {intl.formatMessage({ id: "mini.turn.accept", defaultMessage: "Accept" })}
          </button>
          <OpenAction onOpen={onOpen} intl={intl} />
        </CardActions>
      );
    if (card.reason === "question" && card.options.length > 0)
      return (
        <CardActions>
          {card.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              className={CARD_ACTION_CLASS}
              onClick={() => decide({ type: "turn_reply", episode: card.episode, text: option })}
            >
              {option}
            </button>
          ))}
        </CardActions>
      );
    return null;
  }
  if (card.kind !== "chat" || card.tone !== "attention") return null;
  const request = state?.requests[0] ?? null;
  if (!request) return null;
  const answer = answerableOptions(request);
  if (!answer)
    return (
      <CardActions>
        <OpenAction onOpen={onOpen} intl={intl} primary />
      </CardActions>
    );
  return (
    <CardActions>
      {request.kind === "approval" && request.detail ? (
        <code className="mb-1 block w-full truncate rounded-md bg-token-foreground/[0.05] px-2 py-1 font-mono text-[11px] text-token-text-secondary">
          {request.detail}
        </code>
      ) : null}
      {answer.options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={busy}
          className={option.tone === "primary" ? CARD_PRIMARY_ACTION_CLASS : CARD_ACTION_CLASS}
          onClick={() =>
            run(() =>
              companion("chat.respond", {
                sessionId: card.sessionId,
                requestId: request.requestId,
                runId: request.runId,
                submissionId: createUuidV7(),
                response: answer.respond(option.id),
              }),
            )
          }
        >
          {option.label}
        </button>
      ))}
    </CardActions>
  );
}

/**
 * A request Mini can answer with one press: an approval's choices, or a single question whose
 * answer is one of its options. Anything that needs writing or several answers opens in Nodex.
 */
function answerableOptions(request: ChatRequest) {
  if (request.kind === "approval")
    return {
      options: request.options,
      respond: (optionId: string) => ({ kind: "option" as const, optionId, feedback: null }),
    };
  const [question] = request.questions;
  if (request.questions.length !== 1 || !question || question.options.length === 0) return null;
  return {
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      tone: "default" as const,
    })),
    respond: (optionId: string) => ({
      kind: "answers" as const,
      answers: { [question.id]: [optionId] },
    }),
  };
}

function CardActions({ children }: { readonly children: ReactNode }) {
  return <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[26px]">{children}</div>;
}

function OpenAction({
  onOpen,
  intl,
  primary = false,
}: {
  readonly onOpen: () => void;
  readonly intl: IntlShape;
  readonly primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? CARD_PRIMARY_ACTION_CLASS : CARD_ACTION_CLASS}
      onClick={onOpen}
    >
      {intl.formatMessage({ id: "mini.card.openInNodex", defaultMessage: "Open in Nodex" })}
    </button>
  );
}

function CardIcon({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <button type="button" aria-label={label} className={CARD_ICON_CLASS} onClick={onClick}>
        {children}
      </button>
    </NodexTooltip>
  );
}

function CardReply({
  placeholder,
  onSend,
  onCancel,
}: {
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Enter" || !text.trim()) return;
    event.preventDefault();
    onSend(text.trim());
  };
  return (
    <div className="mt-2 pl-[26px]">
      <input
        autoFocus
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-full bg-token-foreground/[0.06] px-3 text-[13px] text-token-foreground outline-none placeholder:text-token-description-foreground"
      />
    </div>
  );
}
