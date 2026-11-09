import { agentAssigneeLabel } from "@/lib/page-assignee-presentation";
import type { PageAssignee } from "../../../shared/work-graph";
import { AgentProviderIcon, AssigneeIcon } from "@/components/shared/icons";
import { useMembers } from "@/lib/members-runtime";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { agentRuntimeProviderBackendKind } from "@/lib/agent-runtime-model-selection";

export function PageAssigneeLabel({ assignee }: { readonly assignee: PageAssignee | null }) {
  const members = useMembers();
  const providers = useAgentRuntimeProviders();
  if (!assignee) return <span className="text-token-description-foreground">Unassigned</span>;
  if (assignee.kind === "member") {
    const name =
      members.data?.find((member) => member.id === assignee.member_id)?.display_name ?? "Member";
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-token-foreground/10 text-[9px]">
          {name.slice(0, 1)}
        </span>
        <span className="truncate">{name}</span>
      </span>
    );
  }
  const provider = providers.data?.find((provider) => provider.instanceId === assignee.instance_id);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {provider ? (
        <AgentProviderIcon
          kind={agentRuntimeProviderBackendKind(provider)}
          className="size-3.5 shrink-0"
        />
      ) : (
        <AssigneeIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{agentAssigneeLabel(assignee, provider)}</span>
    </span>
  );
}
