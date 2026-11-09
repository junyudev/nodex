import type { InboxPlanStep } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InboxAgentLabel, type InboxAgents } from "./inbox-agent-picker";
import { describeInboxAgent } from "./inbox-agent-model";

/**
 * The cards a plan would create, in order: each one's title, where it lands, what it runs on,
 * and which steps it waits for. The body each card starts with is a hover away.
 */
export function InboxPlanSteps({
  steps,
  projects,
  agents,
}: {
  readonly steps: readonly InboxPlanStep[];
  readonly projects: readonly Project[];
  readonly agents: InboxAgents;
}) {
  const numbers = new Map(steps.map((step, index) => [step.key, index + 1]));
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? "Project";
  return (
    <ol data-testid="inbox-plan-steps" className="flex min-w-0 flex-col">
      {steps.map((step, index) => {
        const after = step.blockedBy.flatMap((key) => {
          const number = numbers.get(key);
          return number === undefined ? [] : [number];
        });
        const agent = describeInboxAgent(
          agents,
          step.agent
            ? {
                instanceId: step.agent.instanceId,
                model: step.agent.model,
                reasoningEffort: step.agent.effort,
                serviceTier: null,
              }
            : agents.settings.chatAgent,
          "chat",
        );
        return (
          <li
            key={step.key}
            data-plan-step={step.key}
            className={cn(
              "grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1 text-[13px] leading-5",
              index > 0 && "border-t-[0.5px] border-token-border",
            )}
          >
            <span className="text-token-description-foreground tabular-nums">{index + 1}</span>
            <NodexTooltip
              tooltipContent={<span className="line-clamp-6 max-w-80">{step.body}</span>}
              side="top"
            >
              <span className="min-w-0 truncate text-token-foreground">{step.title}</span>
            </NodexTooltip>
            <span className="flex min-w-0 items-center gap-2 text-xs text-token-description-foreground">
              <span className="truncate">{projectName(step.projectId)}</span>
              <InboxAgentLabel presentation={agent} className="max-w-36" />
              {after.length > 0 ? (
                <span className="shrink-0 whitespace-nowrap">after {after.join(", ")}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
