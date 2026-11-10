import { useQuery } from "@tanstack/react-query";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { readInboxSkillAvailability } from "@/lib/inbox-runtime";
import {
  inboxActionSkills,
  type InboxDispatchAction,
  type InboxProposal,
  type InboxSuggestedSkill,
  type InboxSkillTarget,
} from "../../../shared/inbox";

const skillTarget = (action: InboxDispatchAction | null | undefined): InboxSkillTarget | null => {
  if (action?.type === "new_chat")
    return {
      type: action.type,
      projectId: action.projectId,
      instanceId: action.agent?.instanceId ?? null,
    };
  if (action?.type === "send_to_chat") return { type: action.type, sessionId: action.sessionId };
  return null;
};

export function useInboxSkillAvailability(
  proposal: InboxProposal | null | undefined,
  action: InboxDispatchAction | null | undefined,
) {
  const target = skillTarget(action);
  const pageId = proposal?.pageIds[0];
  const changed =
    target !== null &&
    Boolean(
      proposal &&
      inboxActionSkills(proposal.action).length &&
      JSON.stringify(target) !== JSON.stringify(skillTarget(proposal.action)),
    );
  const request =
    proposal && target && pageId && changed
      ? {
          proposalId: proposal.proposalId,
          expectedRevision: proposal.revision,
          pageId,
          target,
        }
      : null;
  const query = useQuery({
    queryKey: ["inbox", "skill-availability", request],
    enabled: request !== null,
    queryFn: () => readInboxSkillAvailability(request!),
    retry: false,
  });
  return {
    pending: changed && query.isPending,
    unavailable: changed
      ? inboxActionSkills(proposal?.action)
          .filter(
            ({ name }) =>
              query.isError ||
              (query.data && !query.data.some((skill) => skill.name === name && skill.available)),
          )
          .map(({ name }) => name)
      : [],
  };
}

/**
 * The skills a chat suggestion would start with, one chip each. A chip is a switch: on, it reads
 * as a reference the chat will use; off, it fades and is struck through like a dropped addition.
 * Hovering says why the skill was suggested, or that the chosen Agent cannot use it.
 */
export function InboxSkillToggles({
  skills,
  dropped,
  unavailable,
  pending,
  onToggle,
}: {
  readonly skills: readonly InboxSuggestedSkill[];
  readonly dropped: readonly string[];
  readonly unavailable: readonly string[];
  readonly pending: boolean;
  readonly onToggle: (name: string) => void;
}) {
  if (!skills.length) return null;
  return (
    <ul aria-label="Suggested skills" className="flex min-w-0 flex-wrap gap-1.5">
      {skills.map(({ name, reason }) => {
        const missing = unavailable.includes(name);
        const kept = !missing && !dropped.includes(name);
        return (
          <li key={name} className="min-w-0">
            <NodexTooltip
              tooltipContent={missing ? "The Agent this chat runs on can't use this skill" : reason}
              side="top"
            >
              <button
                type="button"
                aria-label={`Use ${name} skill`}
                aria-pressed={kept}
                aria-disabled={pending || missing}
                className={cn(
                  "flex h-6 max-w-full cursor-interaction items-center gap-1 rounded-md ps-1.5 pe-2 text-[13px] leading-none ring-[0.5px] ring-token-border outline-hidden transition-colors ring-inset hover:bg-token-foreground/5 focus-visible:bg-token-foreground/10",
                  kept ? "text-token-foreground" : "text-token-description-foreground",
                  missing && "cursor-default hover:bg-transparent",
                )}
                onClick={() => {
                  if (!pending && !missing) onToggle(name);
                }}
              >
                <SkillCubeIcon className={cn("icon-2xs shrink-0", !kept && "opacity-50")} />
                <span className={cn("min-w-0 truncate", !kept && "line-through")}>{name}</span>
              </button>
            </NodexTooltip>
          </li>
        );
      })}
    </ul>
  );
}
