import { withPageAssignee, type PageWork } from "../../../../shared/work-graph";
import { AssigneeIcon } from "@/components/shared/icons";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import { useMembers } from "@/lib/members-runtime";
import { InboxAgentPicker, useInboxAgents } from "@/features/inbox/inbox-agent-picker";
import { PageStagePropertyRow } from "./property-row";
import { PageAssigneeLabel } from "@/components/database/page-assignee-label";

export function PageAssigneeRow({
  pageWork,
  onChange,
}: {
  readonly pageWork: PageWork | null;
  readonly onChange: (work: PageWork) => void;
}) {
  const agents = useInboxAgents();
  const members = useMembers();
  if (!pageWork) return null;
  const assignment = pageWork.assignee;
  const agent = assignment?.kind === "agent" ? assignment : null;
  return (
    <PageStagePropertyRow
      icon={<AssigneeIcon />}
      label="Assignee"
      data-page-stage-assignee={assignment?.kind ?? "none"}
    >
      <div className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5">
        <InboxAgentPicker
          agents={agents}
          purpose="chat"
          scope="page"
          value={
            agent
              ? {
                  instanceId: agent.instance_id,
                  model: agent.model,
                  reasoningEffort: agent.effort ?? null,
                  serviceTier: null,
                }
              : agents.settings.chatAgent
          }
          people={{
            members: members.data ?? [],
            value: assignment?.kind === "member" ? assignment.member_id : agent ? undefined : null,
            choose: (memberId) =>
              onChange(
                withPageAssignee(
                  pageWork,
                  memberId ? { kind: "member", member_id: memberId } : null,
                ),
              ),
          }}
          onChange={(next) => {
            if (next.model)
              onChange(
                withPageAssignee(pageWork, {
                  kind: "agent",
                  instance_id: next.instanceId,
                  model: next.model,
                  effort: next.reasoningEffort,
                }),
              );
          }}
          // Only a person grants automatic starts, and only an Agent Assignee can hold one.
          toggles={
            agent
              ? [
                  {
                    label: "Start automatically",
                    checked: pageWork.auto_start,
                    change: (auto_start) => onChange({ ...pageWork, auto_start }),
                  },
                ]
              : undefined
          }
          trigger={
            <NodexDropdownButtonTrigger
              size="xs"
              chrome="transparent"
              className="max-w-full min-w-0"
              aria-label="Choose Assignee"
            >
              <PageAssigneeLabel assignee={assignment ?? null} />
            </NodexDropdownButtonTrigger>
          }
        />
        {agent && pageWork.auto_start ? (
          <span className="shrink-0 text-xs text-token-description-foreground">Auto-start</span>
        ) : null}
      </div>
    </PageStagePropertyRow>
  );
}
export function PageOwnerRow({
  pageWork,
  onChange,
}: {
  readonly pageWork: PageWork | null;
  readonly onChange: (work: PageWork) => void;
}) {
  const members = useMembers();
  const active = members.data?.filter((member) => member.lifecycle === "active") ?? [];
  if (!pageWork || !members.data || members.data.length <= 1) return null;
  return (
    <PageStagePropertyRow icon={<AssigneeIcon />} label="Owner">
      <NodexOptionPicker
        value={pageWork.owner}
        options={active.map((member) => ({ value: member.id, label: member.display_name }))}
        onValueChange={(owner) => onChange({ ...pageWork, owner })}
        triggerButton={
          <NodexDropdownButtonTrigger size="xs" chrome="transparent" aria-label="Choose Owner">
            {active.find((member) => member.id === pageWork.owner)?.display_name ??
              "Removed Member"}
          </NodexDropdownButtonTrigger>
        }
      />
    </PageStagePropertyRow>
  );
}
