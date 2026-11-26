import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { AgentChoice, ProjectName } from "../demos/lumen";
import { useReplicaCopy } from "./copy";
import {
  AerialLead,
  DelegationMap,
  HarnessMark,
  type MapSubagent,
  type StatusTone,
} from "./Subagents";
import { ChevronDownIcon, NodexMarkIcon, ProjectFolderIcon } from "./icons";

/** One chat with live work, as Aerial view draws it: a band with its lead and its whole tree. */
export interface AerialChat {
  readonly id: string;
  readonly project: ProjectName;
  /** The work Page it is the active chat of. */
  readonly pageKey: string;
  readonly agent: AgentChoice;
  readonly title: string;
  readonly status: ReactNode;
  readonly tone?: StatusTone;
  readonly line?: string;
  readonly back?: ReactNode;
  readonly subagents: readonly MapSubagent[];
}

/** A chat whose work ended lately: one line in Recent. */
export interface AerialRecent {
  readonly id: string;
  readonly project: ProjectName;
  readonly agent: AgentChoice;
  readonly title: string;
  readonly subagents: number;
  readonly ended: string;
  readonly unread?: boolean;
}

/**
 * Aerial view (agents/agents-surface.tsx), scoped to every Project: each chat with live work in
 * the order its work started, then the chats that finished lately.
 */
export function AerialView({
  active,
  recent,
  still = false,
}: {
  readonly active: readonly AerialChat[];
  readonly recent: readonly AerialRecent[];
  readonly still?: boolean;
}) {
  const copy = useReplicaCopy();
  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <header className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <span className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-app-fg">
          {copy.allProjects}
          <ChevronDownIcon className="size-3 text-app-faint" />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-2 pb-10">
        <div className="mx-auto flex w-full max-w-[672px] flex-col gap-8">
          <AerialSection title={copy.active} count={active.length}>
            <div className="flex flex-col">
              <AnimatePresence initial={false}>
                {active.map((chat, index) => (
                  <motion.section
                    key={chat.id}
                    exit={{ opacity: 0, height: 0, paddingTop: 0 }}
                    transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
                    className={index === 0 ? "overflow-hidden" : "overflow-hidden pt-7"}
                  >
                    <AerialBand chat={chat} still={still} />
                  </motion.section>
                ))}
              </AnimatePresence>
            </div>
          </AerialSection>
          {recent.length > 0 ? (
            <AerialSection title={copy.recent}>
              <ol className="-mx-2 flex flex-col">
                <AnimatePresence initial={false}>
                  {recent.map((chat) => (
                    <motion.li
                      key={chat.id}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 32 }}
                      transition={{ duration: 0.3 }}
                      className="overflow-hidden"
                    >
                      <RecentRow chat={chat} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>
            </AerialSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One chat's band (agents-chat-band.tsx): the quiet caption, then its lead and its whole tree. */
export function AerialBand({
  chat,
  leadWidth = 256,
  still = false,
}: {
  readonly chat: AerialChat;
  readonly leadWidth?: number;
  readonly still?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <AerialCaption chat={chat} />
      <DelegationMap
        subagents={chat.subagents}
        lead={
          <AerialLead
            agent={chat.agent}
            title={chat.title}
            status={chat.status}
            tone={chat.tone}
            line={chat.line}
            back={chat.back}
          />
        }
        leadPlacement="top"
        leadWidth={leadWidth}
        still={still}
      />
    </div>
  );
}

function AerialSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-1.5 px-1 text-[13px] leading-5 text-app-faint">
        {title}
        {count ? <span className="tabular-nums opacity-80">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** The quiet line above a band: its Project, its work Page, and the mark Nodex watches it under. */
function AerialCaption({ chat }: { readonly chat: AerialChat }) {
  return (
    <div className="flex h-4 min-w-0 items-center gap-1.5 px-1 text-[12px] text-app-faint">
      <ProjectLabel project={chat.project} />
      <span className="shrink-0 tabular-nums">{chat.pageKey}</span>
      <NodexMarkIcon className="size-3.5 shrink-0" />
    </div>
  );
}

function ProjectLabel({ project }: { readonly project: ProjectName }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <ProjectFolderIcon className="size-3.5 shrink-0" />
      <span className="truncate">{project}</span>
    </span>
  );
}

function RecentRow({ chat }: { readonly chat: AerialRecent }) {
  const copy = useReplicaCopy();
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-app-faint">
      <HarnessMark provider={chat.agent.provider} />
      <span className="min-w-0 truncate text-[13px] text-app-fg">{chat.title}</span>
      {chat.unread ? <span className="size-1.5 shrink-0 rounded-full bg-[#3a83f7]" /> : null}
      <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 tabular-nums">
        {chat.subagents > 0 ? <span>{copy.subagentCount(chat.subagents)}</span> : null}
        <ProjectLabel project={chat.project} />
        <span>{chat.ended}</span>
      </span>
    </div>
  );
}
