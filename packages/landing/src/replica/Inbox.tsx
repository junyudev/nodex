import { motion, useTransform, type MotionValue } from "motion/react";
import type { ReactNode } from "react";
import {
  ROUTING_PREFERENCES,
  decisionLabel,
  outcomeLabel,
  type AgentChoice,
  type Dispatch,
  type InboxMessage,
} from "../demos/lumen";
import { AgentLabel, ProviderMark, UsageRing, cx } from "./Window";
import {
  ArchiveIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  DispatchIcon,
  MoreIcon,
  NewChatActionIcon,
  PlusIcon,
  SendToChatIcon,
  SpinnerIcon,
} from "./icons";

export type CardPhase = "waiting" | "suggested" | "decided";

/**
 * One captured message: the message on top and, joined beneath it in one outline, what Nodex
 * made of it. The ways to act sit in a row under the card, with the decision at its end.
 */
export function InboxCard({
  message,
  phase,
  pressed = false,
  source = "user",
  agent,
  modelMenu,
}: {
  readonly message: InboxMessage;
  readonly phase: CardPhase;
  readonly pressed?: boolean;
  readonly source?: "user" | "command_line";
  /** The model a new chat will run on, when it is not yet the plan's own. */
  readonly agent?: AgentChoice;
  /** The model menu, opening from the decision's model half. */
  readonly modelMenu?: ReactNode;
}) {
  const strip = phase === "suggested" || phase === "decided";
  const fromUser = source === "user";
  return (
    <div className={cx("flex w-full flex-col gap-1", fromUser ? "items-end" : "items-start")}>
      {!fromUser ? (
        <span className="pl-1 text-[12px] text-app-muted">From Command line</span>
      ) : null}
      <div className="flex w-fit max-w-[80%] min-w-[min(18rem,80%)] flex-col gap-1.5">
        <div
          className={cx(
            "overflow-hidden rounded-[20px] border [corner-shape:superellipse(1.5)]",
            fromUser ? "border-app-user" : "border-app-line",
          )}
        >
          <div
            className={cx(
              "px-3 py-2 text-[14px] leading-[1.625] break-words",
              fromUser ? "bg-app-user text-app-on-user" : strip && "border-b border-app-line",
            )}
          >
            {message.text}
          </div>
          {strip ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.38, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <div className="px-3 py-2.5">
                {phase === "decided" ? (
                  <Outcome dispatch={message.dispatch} />
                ) : (
                  <Suggestion dispatch={message.dispatch} />
                )}
              </div>
            </motion.div>
          ) : null}
        </div>
        {phase === "decided" ? null : (
          <div className="flex min-h-6 items-center gap-2 pl-1">
            <div className="ml-auto flex shrink-0 items-center gap-0.5 text-app-muted">
              <IconButton label="Message actions">
                <MoreIcon className="size-3.5" />
              </IconButton>
              {phase === "suggested" && message.dispatch.kind !== "keep" ? (
                <IconButton label="Keep">
                  <ArchiveIcon className="size-3.5" />
                </IconButton>
              ) : null}
              <IconButton label="Mark done">
                <CheckIcon className="size-3.5" />
              </IconButton>
              {phase === "waiting" ? (
                <IconButton label="Handle manually">
                  <DispatchIcon className="size-3.5" />
                </IconButton>
              ) : null}
            </div>
            {phase === "waiting" ? (
              <span className="mr-5 flex text-app-muted" aria-label="Finding where this goes">
                <SpinnerIcon className="size-3.5" />
              </span>
            ) : phase === "suggested" ? (
              <Decision
                dispatch={message.dispatch}
                agent={agent}
                pressed={pressed}
                cursorTarget={`decision:${message.id}`}
                modelTarget={`model:${message.id}`}
                modelMenu={modelMenu}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <span
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-[10px]"
    >
      {children}
    </span>
  );
}

function Suggestion({ dispatch }: { readonly dispatch: Dispatch }) {
  if (dispatch.kind === "keep")
    return <p className="text-[14px] leading-snug">{dispatch.summary}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-[14px] leading-[1.625]">{dispatch.prompt}</p>
      {dispatch.kind === "new_chat" && (dispatch.delegates?.length || dispatch.plan) ? (
        <div className="flex min-w-0 flex-col gap-1 text-[13px] leading-5 text-app-muted">
          {dispatch.delegates?.map((delegate, index) => (
            <motion.div
              key={delegate.work}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.18 + index * 0.09, duration: 0.3 }}
              className="flex min-h-6 min-w-0 items-center gap-1.5"
            >
              <span aria-hidden="true" className="shrink-0">
                ↳
              </span>
              <span className="line-clamp-2 min-w-0 flex-1 text-app-fg">{delegate.work}</span>
              <AgentLabel
                agent={delegate.agent}
                className="max-w-[45%] shrink-0 gap-1 [&>svg]:size-3.5"
              />
            </motion.div>
          ))}
          {dispatch.plan ? (
            <p className="line-clamp-3 whitespace-pre-line">{dispatch.plan}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Decision({
  dispatch,
  agent,
  pressed,
  cursorTarget,
  modelTarget,
  modelMenu,
}: {
  readonly dispatch: Dispatch;
  readonly agent?: AgentChoice;
  readonly pressed: boolean;
  readonly cursorTarget: string;
  readonly modelTarget: string;
  readonly modelMenu?: ReactNode;
}) {
  const icon =
    dispatch.kind === "keep" ? (
      <ArchiveIcon className="size-3.5" />
    ) : dispatch.kind === "new_chat" ? (
      <NewChatActionIcon className="size-3.5" />
    ) : (
      <SendToChatIcon className="size-3.5" />
    );
  return (
    <motion.div
      animate={{ scale: pressed ? 0.96 : 1 }}
      transition={{ duration: 0.12 }}
      className="flex min-w-0 items-center gap-px"
    >
      <span
        data-cursor-target={cursorTarget}
        className={cx(
          "flex h-6 min-w-0 items-center gap-1.5 bg-app-primary px-2 text-[12px] leading-4 text-app-on-primary",
          dispatch.kind === "new_chat" ? "rounded-s-[10px]" : "rounded-[10px]",
        )}
      >
        {icon}
        <span className="truncate">{decisionLabel(dispatch)}</span>
      </span>
      {dispatch.kind === "new_chat" ? (
        <span className="relative flex min-w-0">
          <span
            data-cursor-target={modelTarget}
            aria-label="Choose the model for this chat"
            className="flex h-6 min-w-0 items-center gap-1 rounded-e-[10px] bg-app-primary px-1.5 text-[12px] leading-4 text-app-on-primary"
          >
            {/* A newly chosen model settles in where the suggested one was. */}
            <motion.span
              key={(agent ?? dispatch.agent).model}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="flex min-w-0"
            >
              <AgentLabel
                agent={agent ?? dispatch.agent}
                className="max-w-44 gap-1 [&>svg]:size-3.5"
              />
            </motion.span>
            <ChevronDownIcon className="size-3" />
          </span>
          {modelMenu}
        </span>
      ) : null}
    </motion.div>
  );
}

function Outcome({ dispatch }: { readonly dispatch: Dispatch }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-muted">
      {dispatch.kind === "keep" ? (
        <ArchiveIcon className="size-3.5" />
      ) : (
        <SpinnerIcon className="size-3.5" />
      )}
      <span className="min-w-0 truncate">{outcomeLabel(dispatch)}</span>
    </div>
  );
}

/**
 * The cleared Inbox, and how it plans the next burst: the model that suggests, Nodex's model
 * guide with what is left of each plan this week, and the reader's own routing preferences.
 */
export function InboxAllClear({
  usage,
  suggestedBy,
}: {
  readonly usage: { readonly claude: number; readonly codex: number };
  readonly suggestedBy: AgentChoice;
}) {
  const guide = [
    {
      icon: <UsageRing left={usage.claude} kind="claude" className="size-[22px]" />,
      model: "Claude Opus 5.5",
      note: "Frontend, UI and copy, with real taste. Spends the Claude budget faster.",
      detail: `${Math.round(usage.claude * 100)}% left`,
    },
    {
      icon: <UsageRing left={usage.codex} kind="codex" className="size-[22px]" />,
      model: "GPT-6.1 Sol",
      note: "Backend, systems and data. Very economical, even at its highest effort.",
      detail: `${Math.round(usage.codex * 100)}% left`,
    },
    {
      icon: (
        <span className="flex size-[22px] items-center justify-center">
          <ProviderMark kind="opencode" className="size-3.5" />
        </span>
      ),
      model: "OpenCode free models",
      note: null,
      detail: "Free",
    },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6"
    >
      <div className="flex flex-col items-center gap-3 text-center text-app-muted">
        <motion.span
          initial={{ scale: 0.6, rotate: -12 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.08 }}
          className="flex size-10 items-center justify-center rounded-full bg-app-fg/[0.05] text-app-fg"
        >
          <CheckIcon className="size-5" />
        </motion.span>
        <div className="flex flex-col gap-1">
          <p className="text-[16px] font-medium text-app-fg">All clear</p>
          <p className="text-[14px]">Everything you dropped here has somewhere to be.</p>
        </div>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
        className="flex w-full max-w-[496px] flex-col gap-2.5 rounded-[16px] bg-app-fg/[0.025] px-4 pt-3.5 pb-3 text-[12px] leading-[17px] ring-[0.5px] ring-app-line [corner-shape:superellipse(1.5)]"
      >
        <dl className="grid grid-cols-[124px_minmax(0,1fr)] gap-x-3 gap-y-3">
          <dt className="text-app-faint">Suggested by</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-app-fg">
            <AgentLabel agent={suggestedBy} className="gap-1.5 [&>svg]:size-3.5" />
          </dd>
          <dt className="pt-[3px] text-app-faint">Model guide</dt>
          <dd className="flex min-w-0 flex-col gap-2">
            {guide.map((entry) => (
              <div key={entry.model} className="flex min-w-0 items-start gap-2.5">
                <span className="text-app-fg">{entry.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col pt-[2px]">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium text-app-fg">{entry.model}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-app-faint tabular-nums">
                      {entry.detail}
                    </span>
                  </span>
                  {entry.note ? <span className="text-app-muted">{entry.note}</span> : null}
                </span>
              </div>
            ))}
          </dd>
          <dt className="text-app-faint">Routing preferences</dt>
          <dd className="text-app-fg">“{ROUTING_PREFERENCES}”</dd>
        </dl>
        <p className="border-t-[0.5px] border-app-line pt-2.5 text-[11.5px] text-app-faint">
          Each suggestion weighs what a model does well and how much of its weekly budget is left.
        </p>
      </motion.div>
    </motion.div>
  );
}

/** The Inbox composer; its text is driven frame by frame while a message is being typed. */
export function InboxComposer({
  text,
  placeholderOpacity,
}: {
  readonly text: MotionValue<string>;
  readonly placeholderOpacity: MotionValue<number>;
}) {
  const sendOpacity = useTransform(placeholderOpacity, (value) => 1 - value * 0.5);
  return (
    <div className="flex items-end gap-1 rounded-[25px] bg-app-menu p-2 shadow-[0_3px_7.5px_rgb(0_0_0/0.04),0_0_20px_rgb(0_0_0/0.05)] ring-[0.5px] ring-[rgb(26_28_31/0.118)] [corner-shape:superellipse(1.5)] dark:ring-white/[0.157]">
      <span
        className="flex size-[34px] shrink-0 items-center justify-center text-app-muted"
        aria-label="Add images"
      >
        <PlusIcon className="size-5" />
      </span>
      <div className="relative min-h-[34px] flex-1 py-[7px] text-[14px] leading-5">
        <motion.span
          className="pointer-events-none absolute inset-y-[7px] left-0 text-app-faint"
          style={{ opacity: placeholderOpacity }}
        >
          Drop a thought, task, or question…
        </motion.span>
        <motion.span>{text}</motion.span>
        <span className="ml-px inline-block h-4 w-px translate-y-[3px] animate-pulse bg-app-fg" />
      </div>
      <motion.span
        style={{ opacity: sendOpacity }}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-app-accent p-0.5 text-white"
        aria-label="Send to Inbox"
      >
        <ArrowUpIcon className="size-5" />
      </motion.span>
    </div>
  );
}
