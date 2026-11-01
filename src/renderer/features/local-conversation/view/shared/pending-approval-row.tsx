import type { ComponentType } from "react";
import {
  AppActivityIcon,
  EditFilesIcon,
  MoreActionsIcon,
  PermissionAskForApprovalIcon,
  PermissionFullAccessIcon,
  ReadFilesIcon,
  TerminalActivityIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AGENT_APPROVAL_KIND_LABEL,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
  agentApprovalOptionKey,
  splitAgentApprovalOptions,
  type AgentApprovalKind,
  type AgentApprovalOption,
  type AgentApprovalResponse,
  type AgentPendingApproval,
} from "../../agent-approval";

const KIND_PRESENTATION: Record<
  AgentApprovalKind,
  { icon: ComponentType<{ className?: string }>; question: (appName: string | null) => string }
> = {
  command: { icon: TerminalActivityIcon, question: () => "Run this command?" },
  "file-change": { icon: EditFilesIcon, question: () => "Make these changes?" },
  "file-read": { icon: ReadFilesIcon, question: () => "Read these files?" },
  permission: { icon: PermissionFullAccessIcon, question: () => "Grant this access?" },
  "mcp-elicitation": {
    icon: AppActivityIcon,
    question: (appName) => (appName ? `Let ${appName} do this?` : "Allow this app action?"),
  },
};

export interface PendingApprovalRowProps {
  approval: AgentPendingApproval;
  /** A response for this request is in flight. */
  responding: boolean;
  /** Another surface owns input, such as a read-only follower view. */
  disabled?: boolean;
  onRespond: (requestId: string, response: AgentApprovalResponse) => void;
}

/**
 * A native action waiting for the person, shown where the Agent stopped. The composer stays
 * available: a message declines the request and redirects the Agent.
 */
export function PendingApprovalRow({
  approval,
  responding,
  disabled = false,
  onRespond,
}: PendingApprovalRowProps) {
  const presentation = KIND_PRESENTATION[approval.kind];
  const KindIcon = presentation.icon;
  const { primary, more } = splitAgentApprovalOptions(approval.options);
  const inert = disabled || responding || !approval.live;
  const reason =
    approval.reason && approval.reason.trim() !== approval.detail.trim() ? approval.reason : null;
  const respond = (option: AgentApprovalOption) => {
    if (!inert)
      onRespond(approval.requestId, {
        decision: option.decision,
        ...(option.optionId ? { optionId: option.optionId } : {}),
      });
  };

  return (
    <div
      role="group"
      aria-label={AGENT_APPROVAL_KIND_LABEL[approval.kind]}
      data-agent-approval-request={approval.requestId}
      className="flex min-w-0 flex-col gap-2 rounded-xl px-3 py-2.5 text-sm shadow-[inset_0_0_0_0.5px_var(--border)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon className="icon-sm shrink-0 text-token-description-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-token-foreground">
          {presentation.question(approval.appName)}
        </span>
        {approval.fullAccessOverride ? (
          <NodexTooltip
            hoverable
            side="top"
            tooltipContent={
              <span className="block max-w-72 whitespace-normal">
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </span>
            }
          >
            <button
              type="button"
              className="shrink-0 cursor-interaction text-xs text-token-description-foreground underline-offset-2 hover:text-token-foreground hover:underline"
            >
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </button>
          </NodexTooltip>
        ) : null}
      </div>

      <code
        tabIndex={0}
        aria-label="Requested action"
        className="scrollbar-token block max-h-40 min-w-0 overflow-auto rounded-md bg-token-foreground/4 px-2 py-1.5 font-mono text-size-code whitespace-pre-wrap wrap-anywhere text-token-foreground select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
      >
        {approval.detail || AGENT_APPROVAL_KIND_LABEL[approval.kind]}
      </code>

      {reason ? (
        <p className="min-w-0 text-token-description-foreground select-text wrap-anywhere">
          {reason}
        </p>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        {approval.live ? (
          <span className="me-auto inline-flex min-w-0 items-center gap-1.5 text-xs text-token-editor-warning-foreground">
            <PermissionAskForApprovalIcon className="icon-xs shrink-0" />
            Waiting for approval
          </span>
        ) : (
          <span className="me-auto min-w-0 text-xs text-token-editor-warning-foreground">
            The Agent stopped before this was answered. Stop or retry the turn.
          </span>
        )}
        {more.length > 0 ? (
          <NodexDropdownMenu
            disabled={inert}
            side="top"
            align="end"
            triggerButton={
              <NodexButton
                variant="ghostSecondary"
                size="icon-xs"
                aria-label="More approval options"
                disabled={inert}
              >
                <MoreActionsIcon className="icon-xs" />
              </NodexButton>
            }
          >
            {more.map((option) => (
              <NodexDropdownItem
                key={agentApprovalOptionKey(option)}
                onSelect={() => respond(option)}
                tooltipText={option.warning}
              >
                {option.label}
              </NodexDropdownItem>
            ))}
          </NodexDropdownMenu>
        ) : null}
        {primary.map((option) => (
          <NodexTooltip
            key={agentApprovalOptionKey(option)}
            disabled={!option.warning}
            side="top"
            tooltipContent={option.warning}
          >
            <NodexButton
              variant={option.decision === "accept" ? "default" : "ghostSecondary"}
              size="xs"
              disabled={inert}
              aria-description={option.warning}
              className={cn(option.warning && "text-token-editor-warning-foreground")}
              onClick={() => respond(option)}
            >
              {option.label}
            </NodexButton>
          </NodexTooltip>
        ))}
      </div>
    </div>
  );
}
