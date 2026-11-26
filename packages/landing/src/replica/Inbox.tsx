import { motion, useTransform, type MotionValue } from "motion/react";
import type { ReactNode } from "react";
import { useLumen } from "../demos/demo-locale";
import { useReplicaCopy } from "./copy";
import {
  AGENTS,
  PROVIDER_NAMES,
  type AgentChoice,
  type Dispatch,
  type InboxMessage,
  type ProviderKind,
  type UsageLeft,
} from "../demos/lumen";
import { AgentLabel, UsageRing, cx } from "./Window";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  DispatchIcon,
  MoreIcon,
  NewChatActionIcon,
  NoteIcon,
  PlusIcon,
  RefreshIcon,
  SendToChatIcon,
  SpinnerIcon,
  TodoIcon,
} from "./icons";

/** What every chat the Inbox starts runs on unless a suggestion or the reader picks another. */
export const INBOX_DEFAULT = AGENTS.solHigh;

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
  const copy = useReplicaCopy();
  const strip = phase === "suggested" || phase === "decided";
  const notes = message.dispatch.kind === "save_to_notes";
  const fromUser = source === "user";
  return (
    <div className={cx("flex w-full flex-col gap-1", fromUser ? "items-end" : "items-start")}>
      {!fromUser ? (
        <span className="pl-1 text-[12px] text-app-muted">{copy.commandLine}</span>
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
              <IconButton label={copy.messageActions}>
                <MoreIcon className="size-4" />
              </IconButton>
              {phase === "suggested" ? (
                <>
                  <IconButton label={copy.suggestAgain}>
                    <RefreshIcon className="size-4" />
                  </IconButton>
                  <IconButton label={copy.snooze}>
                    <ClockIcon className="size-4" />
                  </IconButton>
                  {notes ? null : (
                    <IconButton label={copy.addToTodo}>
                      <TodoIcon className="size-4" />
                    </IconButton>
                  )}
                </>
              ) : null}
              <IconButton label={copy.markDone}>
                <CheckIcon className="size-4" />
              </IconButton>
              {phase === "waiting" ? (
                <IconButton label={copy.handleManually}>
                  <DispatchIcon className="size-4" />
                </IconButton>
              ) : null}
            </div>
            {phase === "waiting" ? (
              <span className="mr-5 flex text-app-muted" aria-label={copy.findingDestination}>
                <SpinnerIcon className="size-4" />
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

/**
 * What a suggestion sends: the prompt, read like the message above it, then each sentence the
 * suggestion adds on its own with a checkbox, all checked. Other decisions say what they do.
 */
function Suggestion({ dispatch }: { readonly dispatch: Dispatch }) {
  if (dispatch.kind === "save_to_notes")
    return <p className="text-[13px] leading-[1.375]">{dispatch.summary}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-[14px] leading-[1.625]">
      <p>{dispatch.prompt}</p>
      {dispatch.kind === "new_chat" && dispatch.additions?.length ? (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {dispatch.additions.map((addition, index) => (
            <motion.li
              key={addition}
              role="checkbox"
              aria-checked="true"
              aria-readonly="true"
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 + index * 0.08, duration: 0.22 }}
              className="flex min-w-0 items-start gap-2"
            >
              <span
                aria-hidden="true"
                className="mt-[5px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-app-primary text-app-on-primary"
              >
                <svg viewBox="0 0 10 9" className="h-[9px] w-2.5" fill="none" aria-hidden="true">
                  <path
                    d="M1.5 4.6 3.9 7 8.5 1.8"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="min-w-0">{addition}</span>
            </motion.li>
          ))}
        </ul>
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
  const copy = useReplicaCopy();
  const icon =
    dispatch.kind === "save_to_notes" ? (
      <NoteIcon className="size-3.5" />
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
        data-cursor-pressed={pressed || undefined}
        className={cx(
          "flex h-6 min-w-0 items-center gap-1.5 bg-app-primary px-2 text-[12px] leading-4 text-app-on-primary",
          dispatch.kind === "new_chat" ? "rounded-s-[10px]" : "rounded-[10px]",
        )}
      >
        {icon}
        <span className="truncate">{copy.decisionLabel(dispatch)}</span>
      </span>
      {dispatch.kind === "new_chat" ? (
        <span className="relative flex min-w-0">
          <span
            data-cursor-target={modelTarget}
            aria-label={copy.chooseModel}
            className="flex h-6 min-w-0 items-center gap-1 rounded-e-[10px] bg-app-primary px-1.5 text-[12px] leading-4 text-app-on-primary"
          >
            {/* The menu half names the model only when it is not the Inbox's own; a newly
            chosen one settles in where the suggested one was. */}
            {sameAgent(agent ?? dispatch.agent, INBOX_DEFAULT) ? null : (
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
            )}
            <ChevronDownIcon className="size-3.5" />
          </span>
          {modelMenu}
        </span>
      ) : null}
    </motion.div>
  );
}

const sameAgent = (a: AgentChoice, b: AgentChoice) =>
  a.provider === b.provider && a.model === b.model && a.effort === b.effort;

function Outcome({ dispatch }: { readonly dispatch: Dispatch }) {
  const copy = useReplicaCopy();
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-muted">
      {dispatch.kind === "save_to_notes" ? (
        <NoteIcon className="size-3.5" />
      ) : (
        <SpinnerIcon className="size-3.5" />
      )}
      <span className="min-w-0 truncate">{copy.outcomeLabel(dispatch)}</span>
    </div>
  );
}

/**
 * The cleared Inbox, and how it plans the next burst, as the app shows it: the model that
 * suggests, each family of Nodex's model guide beside what is left of its plan this week, then
 * each other Agent the reader has connected by name, such as a DeepSeek key with its balance, and
 * the reader's own routing preferences, which suggestions follow first. Antigravity is not a
 * branded runtime, so its family names it.
 */
export function InboxAllClear({
  usage,
  suggestedBy,
}: {
  readonly usage: UsageLeft;
  readonly suggestedBy: AgentChoice;
}) {
  const copy = useReplicaCopy();
  const story = useLumen();
  const guide: readonly {
    readonly kind: ProviderKind;
    readonly title: string;
    readonly left: number | null;
    readonly note?: string;
    /** A prepaid balance reads the amount left rather than a share. */
    readonly balance?: string;
  }[] = [
    { kind: "codex", title: "GPT-6.2 Sol", left: usage.codex, note: copy.gptNote },
    { kind: "claude", title: "Claude Opus 5.5", left: usage.claude, note: copy.opusNote },
    {
      kind: "antigravity",
      title: `Gemini 4 Neon · ${PROVIDER_NAMES.antigravity}`,
      left: usage.antigravity,
      note: copy.geminiNote,
    },
    {
      kind: "deepseek",
      title: PROVIDER_NAMES.deepseek,
      left: usage.deepseek,
      balance: story.deepseekBalance.amount,
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
          <p className="text-[16px] font-medium text-app-fg">{copy.allClear}</p>
          <p className="text-[14px]">{copy.emptyInbox}</p>
        </div>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
        className="flex w-full max-w-[496px] flex-col gap-2.5 rounded-[16px] bg-app-fg/[0.025] px-4 pt-3.5 pb-3 text-[12px] leading-[17px] ring-[0.5px] ring-app-line [corner-shape:superellipse(1.5)]"
      >
        <dl className="grid grid-cols-[124px_minmax(0,1fr)] gap-x-3 gap-y-3">
          <dt className="text-app-faint">{copy.suggestedBy}</dt>
          <dd className="flex min-w-0 items-center gap-1 text-app-fg">
            <AgentLabel agent={suggestedBy} className="gap-1.5 [&>svg]:size-3.5" />
            <ChevronDownIcon className="size-3 text-app-muted" />
          </dd>
          <dt className="pt-[3px] text-app-faint">{copy.modelGuide}</dt>
          <dd className="flex min-w-0 flex-col gap-2">
            {guide.map((entry) => (
              <div key={entry.title} className="flex min-w-0 items-start gap-2.5">
                <span className="text-app-fg">
                  <UsageRing left={entry.left} kind={entry.kind} className="size-[22px]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col pt-[2px]">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium text-app-fg">{entry.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-app-faint tabular-nums">
                      {entry.balance
                        ? copy.amountLeft(entry.balance)
                        : entry.left === null
                          ? copy.notReported
                          : copy.budgetLeft(Math.round(entry.left * 100))}
                    </span>
                  </span>
                  {entry.note ? <span className="text-app-muted">{entry.note}</span> : null}
                </span>
              </div>
            ))}
          </dd>
          <dt className="text-app-faint">{copy.routingPreferences}</dt>
          <dd className="text-app-fg">“{story.routingPreferences}”</dd>
        </dl>
        <p className="border-t-[0.5px] border-app-line pt-2.5 text-[11.5px] text-app-faint">
          {copy.suggestionCriteria}
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
  const copy = useReplicaCopy();
  const sendOpacity = useTransform(placeholderOpacity, (value) => 1 - value * 0.5);
  return (
    <div className="flex items-end gap-1 rounded-[25px] bg-app-menu p-2 shadow-[0_3px_7.5px_rgb(0_0_0/0.04),0_0_20px_rgb(0_0_0/0.05)] ring-[0.5px] ring-[rgb(13_13_13/0.118)] [corner-shape:superellipse(1.5)] dark:ring-white/[0.157]">
      <span
        className="flex size-[34px] shrink-0 items-center justify-center text-app-muted"
        aria-label={copy.addImages}
      >
        <PlusIcon className="size-5" />
      </span>
      <div className="relative min-h-[34px] flex-1 py-[7px] text-[14px] leading-5">
        <motion.span
          className="pointer-events-none absolute inset-y-[7px] left-[3px] text-app-faint"
          style={{ opacity: placeholderOpacity }}
        >
          {copy.inboxPlaceholder}
        </motion.span>
        <motion.span>{text}</motion.span>
        <span className="ml-px inline-block h-4 w-px translate-y-[3px] animate-pulse bg-app-fg" />
      </div>
      <motion.span
        style={{ opacity: sendOpacity }}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-app-accent p-0.5 text-white"
        aria-label={copy.sendToInbox}
      >
        <ArrowUpIcon className="size-5" />
      </motion.span>
    </div>
  );
}
