import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { AgentChoice } from "../demos/lumen";
import { ProviderMark, cx } from "./Window";
import { PROVIDER_NAMES } from "../demos/lumen";
import {
  ActivitySearchIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  EditFilesIcon,
  PlusIcon,
  ReadFilesIcon,
  StopIcon,
  TerminalActivityIcon,
  WorkedChevronIcon,
} from "./icons";

export type SubagentStatus = "working" | "finished";

export interface Subagent {
  readonly name: string;
  readonly avatar: string;
  readonly agent: AgentChoice;
  readonly objective: string;
  readonly status: SubagentStatus;
}

export interface ToolRow {
  readonly verb: string;
  readonly target: string;
  /** Replaces the icon the verb implies. */
  readonly icon?: ReactNode;
  readonly added?: number;
  readonly removed?: number;
}

/** The sentence a transcript writes about its delegated work, as the conversation shows it. */
export function subagentGroupLabel(subagents: readonly Subagent[]): string {
  const finished = subagents.filter((agent) => agent.status === "finished").length;
  const working = subagents.length - finished;
  if (working === 0) return "finished";
  if (finished === 0) return subagents.length === 1 ? "is working" : "are working";
  return `— ${working} working · ${finished} done`;
}

/**
 * The app's own subagent artwork, read from its asset folder at build time so the replica
 * always shows the current icons.
 */
const AVATAR_URLS = import.meta.glob<string>(
  "../../../../src/renderer/assets/subagent-avatars/*.svg",
  { eager: true, query: "?no-inline", import: "default" },
);

function avatarUrl(avatar: string, theme: "dark" | "light"): string {
  const url =
    AVATAR_URLS[`../../../../src/renderer/assets/subagent-avatars/${avatar}-${theme}.svg`];
  if (!url) throw new Error(`Unknown subagent avatar: ${avatar}`);
  return url;
}

export function SubagentAvatar({
  avatar,
  className = "size-4",
}: {
  /** An app avatar slot name, such as `04-aperture`. */
  readonly avatar: string;
  readonly className?: string;
}) {
  return (
    <span className={cx("relative inline-block shrink-0", className)}>
      <img
        src={avatarUrl(avatar, "dark")}
        alt=""
        className="absolute inset-0 hidden size-full dark:block"
      />
      <img
        src={avatarUrl(avatar, "light")}
        alt=""
        className="absolute inset-0 size-full dark:hidden"
      />
    </span>
  );
}

/** The quiet transcript line for delegated work: avatars, names, then where they stand. */
export function SubagentLine({
  subagents,
  cursorTarget,
}: {
  readonly subagents: readonly Subagent[];
  readonly cursorTarget?: string;
}) {
  if (subagents.length === 0) return null;
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-[14px] leading-5 text-app-muted">
      <span className="inline-flex h-5 shrink-0 items-center gap-1.5">
        {subagents.slice(0, 4).map((agent, index) => (
          <motion.span
            key={agent.name}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: index * 0.12, type: "spring", stiffness: 500, damping: 22 }}
          >
            <SubagentAvatar avatar={agent.avatar} />
          </motion.span>
        ))}
      </span>
      <span className="min-w-0">
        {subagents.slice(0, subagents.length > 3 ? 2 : 3).map((agent, index, named) => (
          <span key={agent.name}>
            {index === 0
              ? ""
              : index === named.length - 1 && subagents.length <= 3
                ? " and "
                : ", "}
            <span
              data-cursor-target={index === 0 ? cursorTarget : undefined}
              className="inline-block max-w-[min(24ch,100%)] truncate rounded-sm align-bottom text-start"
            >
              {agent.name}
            </span>
          </span>
        ))}
        {subagents.length > 3 ? ` and ${subagents.length - 2} more` : null}{" "}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={subagentGroupLabel(subagents)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {subagentGroupLabel(subagents)}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}

/** The hover card on one subagent: who runs it, which harness, and what it was asked. */
export function SubagentCard({ subagent }: { readonly subagent: Subagent }) {
  const harness = PROVIDER_NAMES[subagent.agent.provider];
  const metadata = subagent.agent.model.toLowerCase().startsWith(harness.toLowerCase())
    ? subagent.agent.model
    : `${harness} · ${subagent.agent.model}`;
  return (
    <div className="flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2 rounded-[15px] bg-app-menu/90 p-3 text-[14px] leading-[21px] text-app-muted shadow-[0_8px_24px_rgb(0_0_0/0.12)] ring-[0.5px] ring-app-line backdrop-blur-sm [corner-shape:superellipse(1.5)]">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 font-medium text-app-fg">{subagent.name}</span>
        <span className="shrink-0">{subagent.status === "finished" ? "Done" : "Running"}</span>
      </div>
      <p className="line-clamp-4 break-words whitespace-pre-wrap">{subagent.objective}</p>
      <span className="flex items-center gap-1.5 text-[12px] leading-4 break-words text-app-faint">
        <ProviderMark kind={subagent.agent.provider} className="size-3 shrink-0" />
        {metadata}
      </span>
      {subagent.status === "working" ? (
        <div className="flex justify-end text-[12px] leading-4 text-app-faint">
          <span className="inline-flex items-center gap-1 px-1">
            <StopIcon className="size-2.5" />
            Stop
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The chat's own model, shown on pointing at the composer's model button: the main thread that
 * leads, whatever its subagents run on.
 */
export function LeadCard({ agent }: { readonly agent: AgentChoice }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 2 }}
      transition={{ duration: 0.18 }}
      className="absolute right-0 bottom-[calc(100%+8px)] z-10 flex w-max flex-col gap-1 rounded-[15px] bg-app-menu/90 px-3 py-2.5 text-[13px] leading-[18px] shadow-[0_8px_24px_rgb(0_0_0/0.12)] ring-[0.5px] ring-app-line backdrop-blur-sm [corner-shape:superellipse(1.5)]"
    >
      <span className="flex items-center gap-1.5 font-medium text-app-fg">
        <ProviderMark kind={agent.provider} className="size-3.5" />
        {agent.model}
        <span className="font-normal text-app-muted">{agent.effort}</span>
      </span>
      <span className="text-[12px] leading-4 text-app-faint">
        Leads this chat in {PROVIDER_NAMES[agent.provider]}
      </span>
    </motion.div>
  );
}

export function ToolLine({ row }: { readonly row: ToolRow }) {
  const Icon =
    row.verb === "Edited"
      ? EditFilesIcon
      : row.verb === "Read"
        ? ReadFilesIcon
        : row.verb === "Searched"
          ? ActivitySearchIcon
          : TerminalActivityIcon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex min-w-0 items-center gap-1.5 text-[14px] leading-[21px] text-app-muted"
    >
      {row.icon ?? <Icon className="size-3.5" />}
      <span className="shrink-0">{row.verb}</span>
      <span className="min-w-0 truncate">{row.target}</span>
      {row.added !== undefined ? (
        <span className="shrink-0 text-[12px] text-[#1a7f37] dark:text-[#72bc8f]">
          +{row.added}
        </span>
      ) : null}
      {row.removed !== undefined ? (
        <span className="shrink-0 text-[12px] text-[#cf222e] dark:text-[#ff7b72]">
          −{row.removed}
        </span>
      ) : null}
    </motion.div>
  );
}

export function UserBubble({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[77%] rounded-[20px] bg-app-user px-3 py-2 text-[14px] leading-[1.625] text-app-on-user [corner-shape:superellipse(1.5)]">
        {children}
      </div>
    </div>
  );
}

export function ChatComposer({
  agent,
  placeholder = "Ask for follow-up changes",
  input,
  modelTarget,
  modelPopover,
}: {
  readonly agent: AgentChoice;
  readonly placeholder?: string;
  /** Text being typed; the placeholder shows without it and the send button wakes with it. */
  readonly input?: ReactNode;
  readonly modelTarget?: string;
  /** What opens above the model button, anchored as the app anchors its menu. */
  readonly modelPopover?: ReactNode;
}) {
  return (
    <div className="relative flex flex-col rounded-[25px] bg-white text-[14px] leading-[21px] shadow-[0_3px_7.5px_rgb(0_0_0/0.04),0_0_20px_rgb(0_0_0/0.05)] ring-[0.5px] ring-[rgb(26_28_31/0.118)] [corner-shape:superellipse(1.5)] dark:bg-[#363636] dark:ring-white/[0.157]">
      <span className="min-h-[50px] px-3 pt-3 pb-1">
        {input ?? <span className="text-app-faint">{placeholder}</span>}
      </span>
      <div className="flex items-center justify-between gap-[5px] px-2 pt-3 pb-2">
        <span
          className="flex size-7 items-center justify-center text-app-muted"
          aria-label="Add files and more"
        >
          <PlusIcon className="size-5" />
        </span>
        <span className="flex min-w-0 items-center gap-[5px]">
          <span
            className="mr-1 inline-flex size-3.5 items-center justify-center text-app-muted"
            aria-label="Context window"
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
              <circle
                cx="6"
                cy="6"
                r="5"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                opacity="0.16"
              />
            </svg>
          </span>
          <span className="relative flex min-w-0">
            <span
              data-cursor-target={modelTarget}
              className="flex h-7 min-w-0 items-center gap-1 rounded-[10px] px-1 text-[13px] text-app-fg"
            >
              {agent.model} <span className="text-app-muted">{agent.effort}</span>
              <ChevronDownIcon className="size-3 text-app-muted" />
            </span>
            {modelPopover}
          </span>
          <span
            className={cx(
              "flex size-7 shrink-0 items-center justify-center rounded-full bg-app-accent p-0.5 text-white",
              !input && "opacity-50",
            )}
            aria-label="Send"
          >
            <ArrowUpIcon className="size-5" />
          </span>
        </span>
      </div>
    </div>
  );
}

export function WorkingLine({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center text-[14px] leading-[21px] text-app-muted">
      <span className="bg-[linear-gradient(90deg,var(--app-muted),var(--app-fg),var(--app-muted))] bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer">
        {label}
      </span>
    </div>
  );
}

/** A completed turn's disclosure and divider, above its assistant work. */
export function WorkedFor({ duration }: { readonly duration: string }) {
  return (
    <div className="flex flex-col gap-1 text-[14px] leading-[21px]">
      <span className="inline-flex items-center gap-1 text-app-muted">
        Worked for {duration}
        <WorkedChevronIcon className="size-3 rotate-90 text-app-faint" />
      </span>
      <div className="border-t border-app-line/60" />
    </div>
  );
}

/**
 * Where the chat continued on another Agent: a rule across the transcript naming who handed the
 * conversation to whom. What was carried explains itself on hover.
 */
export function HandoffDivider({
  from,
  to,
  cursorTarget,
  explained = false,
}: {
  readonly from: AgentChoice;
  readonly to: AgentChoice;
  readonly cursorTarget?: string;
  /** Shows what the handoff carried, as hovering it does. */
  readonly explained?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="my-1 flex items-center gap-2 text-[14px] leading-[21px] text-app-muted"
    >
      <div className="flex-1 border-t border-current/20" />
      <span
        data-cursor-target={cursorTarget}
        className="relative inline-flex min-w-0 items-center gap-1 whitespace-nowrap"
      >
        <span>Context handoff</span>
        <span aria-hidden="true">·</span>
        <HandoffAgent agent={from} />
        <span aria-hidden="true">→</span>
        <HandoffAgent agent={to} />
        <AnimatePresence>
          {explained ? (
            <motion.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="absolute bottom-[calc(100%+8px)] left-1/2 z-10 w-max max-w-[300px] -translate-x-1/2 rounded-[8px] bg-[#1d1d1f] px-2.5 py-1.5 text-center text-[12px] leading-4 whitespace-normal text-white shadow-[0_6px_16px_-6px_rgb(0_0_0/0.4)]"
            >
              Carried the conversation so far. Longer history stays readable to the Agent.
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
      <div className="flex-1 border-t border-current/20" />
    </motion.div>
  );
}

function HandoffAgent({ agent }: { readonly agent: AgentChoice }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-app-fg">
      <ProviderMark kind={agent.provider} className="size-3" />
      <span className="truncate">{agent.model}</span>
    </span>
  );
}
