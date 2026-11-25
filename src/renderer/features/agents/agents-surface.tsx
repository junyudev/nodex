import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import {
  ActivitySpinnerIcon,
  DelegationMapIcon,
  ProjectFolderIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { SURFACE_TOOLBAR_ROW_CLASS } from "@/components/workbench/surface-toolbar";
import { ProjectMarker } from "@/components/workbench/project-marker";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { conversationIdentityQueryOptions } from "@/lib/conversation-identity";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";
import {
  AGENTS_MAP_MAX_RECENT_LIMIT,
  AGENTS_MAP_RECENT_PAGE,
  type AgentsMapChat,
  type AgentsMapScope,
} from "../../../shared/agents-map";
import type { Project } from "../../../shared/types";
import { InboxProjectLabel } from "../inbox/inbox-project-label";
import type { ThreadStageActions } from "../local-conversation/thread-stage-types";
import { useAgentIdentity } from "../local-conversation/view/shared/agent-identity";
import { HarnessMark } from "../local-conversation/view/subagents-panel/delegation-map";
import { AgentsChatBand } from "./agents-chat-band";
import {
  agentsChatSettledAtMs,
  agentsChatStatus,
  agentsClockIntervalMs,
} from "./agents-chat-status";
import { useAgentsMap, useAgentsMapPulse } from "./agents-map-source";

export interface AgentsSurfaceProps {
  /** Which chats the view shows; the tab keeps it. */
  readonly scope: AgentsMapScope;
  readonly onScopeChange: (scope: AgentsMapScope) => void;
  /**
   * Opens a chat from its lead card. A Project Scene shows it in its Agent Dock and keeps the
   * view in place; elsewhere the window goes to the chat.
   */
  readonly onOpenChat: (chat: {
    readonly sessionId: string;
    readonly rootThreadId: string;
  }) => void;
  /** Opens a subagent where it lives, beside its chat. */
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  /** Whether the tab is showing; a hidden view stops following live work. */
  readonly visible: boolean;
}

/**
 * Every chat in scope with its work tree. Chats with live work keep the order their work started
 * in, so a chat holds its place while its state changes; chats that finished in the last day
 * follow, one line each.
 */
export function AgentsSurface({
  scope,
  onScopeChange,
  onOpenChat,
  onOpenThread,
  visible,
}: AgentsSurfaceProps) {
  const intl = useIntl();
  const reducedMotion = useResolvedReducedMotion();
  const [recentLimit, setRecentLimit] = useState(AGENTS_MAP_RECENT_PAGE);
  const { snapshot, error, retry } = useAgentsMap({ scope, recentLimit, enabled: visible });
  const { projects } = useProjects();
  const projectOf = (projectId: string | null) =>
    scope.projectId === null && projectId !== null
      ? (projects.find((project) => project.id === projectId) ?? null)
      : null;
  const nowMs = useAgentsClock(visible ? agentsClockIntervalMs(snapshot) : null);
  const active = snapshot?.active ?? [];
  const recent = snapshot?.recent ?? [];

  return (
    <div className="flex size-full min-h-0 flex-col" data-agents-surface="">
      <header className={cn(SURFACE_TOOLBAR_ROW_CLASS, "shrink-0")}>
        <AgentsScopePicker
          scope={scope}
          projects={projects.filter((project) => project.lifecycle !== "archived")}
          onScopeChange={onScopeChange}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-10">
        <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-8">
          {error ? (
            <div
              role="alert"
              className="flex items-center gap-2 px-1 text-sm text-token-text-secondary"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                className="shrink-0 cursor-interaction rounded-md px-1 text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                onClick={retry}
              >
                <FormattedMessage id="agents.agentsSurface.retry" defaultMessage="Retry" />
              </button>
            </div>
          ) : null}
          {!snapshot ? (
            error ? null : (
              <p role="status" className="px-1 text-sm text-token-text-tertiary">
                <FormattedMessage
                  id="agents.agentsSurface.loading"
                  defaultMessage="Loading Agents…"
                />
              </p>
            )
          ) : active.length === 0 && recent.length === 0 ? (
            <AgentsEmptyState />
          ) : (
            <>
              <AgentsSection
                title={intl.formatMessage({
                  id: "agents.agentsSurface.active",
                  defaultMessage: "Active",
                })}
                count={active.length}
                id="active"
              >
                {active.length === 0 ? (
                  <p className="px-1 text-sm text-token-text-tertiary">
                    <FormattedMessage
                      id="agents.agentsSurface.noneActive"
                      defaultMessage="No Agent is working right now."
                    />
                  </p>
                ) : (
                  <div className="flex flex-col gap-7">
                    <AnimatePresence initial={false}>
                      {active.map((chat) => (
                        <motion.div
                          key={chat.sessionId}
                          layout={reducedMotion ? false : "position"}
                          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                          <AgentsChatBand
                            chat={chat}
                            project={projectOf(chat.projectId)}
                            nowMs={nowMs}
                            still={!visible}
                            onOpenChat={onOpenChat}
                            onOpenThread={onOpenThread}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                )}
                {snapshot.complete ? null : (
                  <p className="px-1 text-xs text-token-text-tertiary">
                    <FormattedMessage
                      id="agents.agentsSurface.incomplete"
                      defaultMessage="More chats are working than this view can show."
                    />
                  </p>
                )}
              </AgentsSection>
              {recent.length > 0 ? (
                <AgentsSection
                  title={intl.formatMessage({
                    id: "agents.agentsSurface.recent",
                    defaultMessage: "Recent",
                  })}
                  id="recent"
                >
                  <ol className="-mx-2 flex flex-col">
                    {recent.map((chat) => (
                      <li key={chat.sessionId}>
                        <AgentsRecentRow
                          chat={chat}
                          project={projectOf(chat.projectId)}
                          nowMs={nowMs}
                          onOpenChat={onOpenChat}
                        />
                      </li>
                    ))}
                  </ol>
                  {snapshot.hasMoreRecent && recentLimit < AGENTS_MAP_MAX_RECENT_LIMIT ? (
                    <button
                      type="button"
                      className="self-start cursor-interaction rounded-md px-1 py-1 text-xs text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                      onClick={() =>
                        setRecentLimit((limit) =>
                          Math.min(limit + AGENTS_MAP_RECENT_PAGE, AGENTS_MAP_MAX_RECENT_LIMIT),
                        )
                      }
                    >
                      <FormattedMessage
                        id="conversation.subagentsPanel.showMore"
                        defaultMessage="Show more"
                      />
                    </button>
                  ) : null}
                </AgentsSection>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The tab's clock, ticking at the cadence what it shows needs, and only while in sight. */
function useAgentsClock(intervalMs: number | null): number {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (intervalMs === null) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);
  return nowMs;
}

function AgentsSection({
  id,
  title,
  count,
  children,
}: {
  readonly id: "active" | "recent";
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-agents-section={id}>
      <h2 className="flex items-center gap-1.5 px-1 text-sm text-token-text-tertiary">
        {title}
        {count ? <span className="tabular-nums opacity-80">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function AgentsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-24 text-center">
      <DelegationMapIcon className="icon-md text-token-text-tertiary" />
      <p className="text-sm font-medium text-token-foreground">
        <FormattedMessage
          id="agents.agentsSurface.emptyTitle"
          defaultMessage="No Agent is working"
        />
      </p>
      <p className="max-w-80 text-sm text-token-text-tertiary">
        <FormattedMessage
          id="agents.agentsSurface.emptyDescription"
          defaultMessage="Chats appear here while their Agents work, each with the subagents it delegates to."
        />
      </p>
    </div>
  );
}

/** A chat whose work ended lately: its Agent, its title, and how and when it ended. */
function AgentsRecentRow({
  chat,
  project,
  nowMs,
  onOpenChat,
}: {
  readonly chat: AgentsMapChat;
  readonly project: Pick<Project, "id" | "name" | "appearance"> | null;
  readonly nowMs: number;
  readonly onOpenChat: AgentsSurfaceProps["onOpenChat"];
}) {
  const intl = useIntl();
  const conversation = useQuery(conversationIdentityQueryOptions(chat.rootThreadId)).data ?? null;
  const agentBinding = chat.agent ?? conversation?.agent;
  const agent = useAgentIdentity(agentBinding);
  const settledAtMs = agentsChatSettledAtMs(chat);
  const ending = chat.outcome === "completed" ? null : agentsChatStatus(chat, nowMs, intl);
  return (
    <button
      type="button"
      onClick={() => onOpenChat({ sessionId: chat.sessionId, rootThreadId: chat.rootThreadId })}
      data-agents-recent-chat={chat.sessionId}
      className="flex h-8 w-full min-w-0 cursor-interaction items-center gap-1.5 rounded-lg px-2 text-left text-xs text-token-text-tertiary hover:bg-token-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <HarnessMark agent={agentBinding} identity={agent} />
      <span className="min-w-0 truncate text-sm text-token-foreground">{conversation?.title}</span>
      {chat.unread ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-info-solid"
          aria-label={intl.formatMessage({
            id: "workbench.sessionChatTabIcon.unread",
            defaultMessage: "Unread",
          })}
        />
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 tabular-nums">
        {chat.subagentCount.total > 0 ? (
          <span>
            <FormattedMessage
              id="agents.agentsSurface.subagentCount"
              defaultMessage="{count, plural, one {# subagent} other {# subagents}}"
              values={{ count: chat.subagentCount.total }}
            />
          </span>
        ) : null}
        {project ? <InboxProjectLabel project={project} /> : null}
        <span className={cn(ending?.tone === "failed" && "text-danger")}>
          {[
            ending?.text,
            settledAtMs === null ? null : formatCompactRelativeTime(settledAtMs, nowMs),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </button>
  );
}

/** Chooses one Project's chats, or every Project's together with chats that belong to none. */
function AgentsScopePicker({
  scope,
  projects,
  onScopeChange,
}: {
  readonly scope: AgentsMapScope;
  readonly projects: readonly Project[];
  readonly onScopeChange: (scope: AgentsMapScope) => void;
}) {
  const intl = useIntl();
  const selected = projects.find((project) => project.id === scope.projectId) ?? null;
  const allProjects = intl.formatMessage({
    id: "agents.agentsScopePicker.allProjects",
    defaultMessage: "All Projects",
  });
  const untitled = intl.formatMessage({
    id: "inbox.inboxProjectLabel.untitled",
    defaultMessage: "Untitled",
  });
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="menuWide"
      contentMaxHeight="list"
      triggerButton={
        <NodexDropdownButtonTrigger
          chrome="transparent"
          size="sm"
          aria-label={intl.formatMessage({
            id: "agents.agentsScopePicker.label",
            defaultMessage: "Show Agents in",
          })}
          leadingVisual={
            selected ? (
              <ProjectMarker
                appearance={selected.appearance}
                fallbackIcon={<ProjectFolderIcon />}
                className="size-4 [&>svg]:size-3.5"
              />
            ) : undefined
          }
        >
          <span className="truncate font-medium">
            {selected ? selected.name.trim() || untitled : allProjects}
          </span>
        </NodexDropdownButtonTrigger>
      }
    >
      <NodexDropdownItem
        onSelect={() => onScopeChange({ projectId: null })}
        rightSlot={scope.projectId === null ? <NodexDropdownSelectedIcon /> : undefined}
      >
        {allProjects}
      </NodexDropdownItem>
      {projects.length > 0 ? <NodexDropdownSeparator /> : null}
      {projects.map((project) => (
        <NodexDropdownItem
          key={project.id}
          onSelect={() => onScopeChange({ projectId: project.id })}
          leftSlot={
            <ProjectMarker
              appearance={project.appearance}
              fallbackIcon={<ProjectFolderIcon />}
              className="size-4 [&>svg]:size-3.5"
            />
          }
          rightSlot={project.id === scope.projectId ? <NodexDropdownSelectedIcon /> : undefined}
        >
          {project.name.trim() || untitled}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

/**
 * The Agents tab's glyph. Like a chat's own tab, it says how work in scope stands: a question
 * bubble while a chat waits on its person, a spinner while any works, the map's glyph otherwise.
 */
export function AgentsTabIcon({
  scope,
  className,
}: {
  readonly scope: AgentsMapScope;
  readonly className?: string;
}) {
  const pulse = useAgentsMapPulse(scope);
  if (pulse === "waiting")
    return (
      <span data-agents-tab-status={pulse} className={cn("flex", className)}>
        <ChatWaitingIcon className="icon-xs" />
      </span>
    );
  if (pulse === "working")
    return (
      <span data-agents-tab-status={pulse} className={cn("flex", className)}>
        <ActivitySpinnerIcon
          className="icon-xs shrink-0 text-token-foreground/70"
          animationDurationMs={2_000}
        />
      </span>
    );
  return (
    <span data-agents-tab-status={pulse} className={cn("flex", className)}>
      <DelegationMapIcon className="icon-xs" />
    </span>
  );
}
