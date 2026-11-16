import { useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import { AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  SkillAgentAvailability,
  SkillInventoryContext,
  SkillInventoryEntry,
  SkillReader,
} from "../../../../shared/skill-inventory";
import { useSkillCommands } from "../skill-inventory";
import {
  AGENT_LABEL,
  describeSkillAvailability,
  describeSkillReaders,
  orderSkillReaders,
} from "../skill-presentation";

const MARK_CLASS = "flex size-6 shrink-0 items-center justify-center rounded-md";

/** Which Agents read a folder: their marks, plain, named by one tooltip. */
export function SkillReaderMarks({ readers }: { readonly readers: readonly SkillReader[] }) {
  const intl = useIntl();
  const agents = [...new Set(orderSkillReaders(readers).map((reader) => reader.agent))];
  if (agents.length === 0) return null;
  return (
    <NodexTooltip tooltipContent={describeSkillReaders(readers, intl)} side="top">
      <span
        role="img"
        aria-label={describeSkillReaders(readers, intl)}
        className="flex items-center gap-1.5 text-token-description-foreground"
      >
        {agents.map((agent) => (
          <AgentProviderIcon key={agent} kind={agent} className="size-3.5" />
        ))}
      </span>
    </NodexTooltip>
  );
}

function AgentMark({
  context,
  skill,
  agent,
}: {
  readonly context: SkillInventoryContext;
  readonly skill: SkillInventoryEntry;
  readonly agent: SkillAgentAvailability;
}) {
  const intl = useIntl();
  const commands = useSkillCommands(context);
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? agent.state !== "disabled";
  const shadowed = agent.discovery === "shadowed";
  const dimmed = !on || shadowed;
  const icon = (
    <AgentProviderIcon
      kind={agent.agent}
      className={cn("size-3.5 transition-opacity", dimmed && "opacity-35")}
    />
  );
  const label = AGENT_LABEL[agent.agent];

  if (agent.toggle.status !== "available") {
    const explanation =
      agent.state === "unknown" && !shadowed
        ? describeSkillAvailability(agent, intl)
        : intl.formatMessage(
            {
              id: "skills.skillAgentMarks.unavailableReason",
              defaultMessage: "{status}. {reason}",
            },
            { status: describeSkillAvailability(agent, intl), reason: agent.toggle.reason },
          );
    return (
      <NodexTooltip tooltipContent={explanation} side="top">
        <span role="img" aria-label={explanation} className={MARK_CLASS}>
          {icon}
        </span>
      </NodexTooltip>
    );
  }

  const { scope } = agent.toggle;
  const toggle = async () => {
    const next = !on;
    setPending(next);
    await runWithCleanup(
      async () => {
        const result = await commands.setEnabled({
          skillId: skill.id,
          reader: { agent: agent.agent, instanceId: agent.instanceId },
          scope,
          enabled: next,
        });
        if (result.status !== "ok") toast.danger(result.message);
      },
      {
        onError: () => {
          toast.danger(
            intl.formatMessage(
              {
                id: "skills.skillAgentMarks.toggleFailed",
                defaultMessage:
                  "{state, select, on {Couldn't turn {skill} on for {agent}} other {Couldn't turn {skill} off for {agent}}}",
              },
              { state: next ? "on" : "off", skill: skill.name, agent: label },
            ),
          );
        },
        cleanup: () => setPending(null),
      },
    );
  };
  return (
    <NodexTooltip
      tooltipContent={intl.formatMessage(
        {
          id: "skills.skillAgentMarks.toggle",
          defaultMessage: "{status} · Click to turn {state, select, on {off} other {on}}",
        },
        {
          status: describeSkillAvailability({ ...agent, state: on ? "enabled" : "disabled" }, intl),
          state: on ? "on" : "off",
        },
      )}
      side="top"
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={intl.formatMessage(
          { id: "skills.skillAgentMarks.useSkill", defaultMessage: "Use {skill} in {agent}" },
          { skill: skill.name, agent: label },
        )}
        disabled={pending !== null}
        className={cn(
          MARK_CLASS,
          "cursor-interaction outline-hidden hover:bg-token-foreground/5 focus-visible:bg-token-foreground/10",
        )}
        onClick={(event) => {
          event.stopPropagation();
          void toggle();
        }}
      >
        {icon}
      </button>
    </NodexTooltip>
  );
}

/**
 * A skill's Agents, each mark its own switch: full strength while that Agent uses the skill,
 * faded while it is off for it or another skill of the same name wins.
 */
export function SkillAgentMarks({
  context,
  skill,
  className,
}: {
  readonly context: SkillInventoryContext;
  readonly skill: SkillInventoryEntry;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex items-center text-token-foreground", className)}>
      {orderSkillReaders(skill.agents).map((agent) => (
        <AgentMark
          key={`${agent.agent}:${agent.instanceId}`}
          context={context}
          skill={skill}
          agent={agent}
        />
      ))}
    </span>
  );
}
