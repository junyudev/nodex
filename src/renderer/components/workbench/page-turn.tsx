import type { PageTurn } from "../../../shared/page-turn";
import { useMembers, useLocalMember } from "@/lib/members-runtime";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import type { PageTurnHolder } from "@/lib/page-turn-phrase";
import { PageTurnChip } from "./page-turn-chip";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { REMOTE_AGENT_REASON } from "../../../shared/space-connection";
import { NodexTooltip } from "@/components/ui/tooltip";

/** Names the person or Agent whose move a Page waits for, relative to this reader. */
export function usePageTurnHolder(turn: PageTurn | null | undefined): PageTurnHolder {
  const members = useMembers();
  const local = useLocalMember();
  const providers = useAgentRuntimeProviders();
  const actor = turn?.actor;
  if (actor?.kind === "member")
    return actor.member_id === local.data?.id
      ? { you: true, name: "You" }
      : {
          you: false,
          name:
            members.data?.find((member) => member.id === actor.member_id)?.display_name ??
            "Someone",
        };
  if (actor?.kind === "agent" && actor.assignee.kind === "agent") {
    const instanceId = actor.assignee.instance_id;
    return {
      you: false,
      name:
        providers.data?.find((provider) => provider.instanceId === instanceId)?.displayName ??
        (instanceId === "codex" ? "Codex" : "The Agent"),
    };
  }
  return { you: false, name: "" };
}

/** A card's or row's turn, with Start held back where this device cannot run the work. */
export function PageTurnView({
  turn,
  onStart,
  disabled,
  onOpenPage,
}: {
  readonly turn: PageTurn;
  readonly onStart?: () => void;
  readonly disabled?: boolean;
  readonly onOpenPage?: (pageId: string) => void;
}) {
  const holder = usePageTurnHolder(turn);
  const hostAvailable = useSpaceHostAvailable();
  const unavailable = !hostAvailable && Boolean(onStart);
  return (
    <NodexTooltip tooltipContent={unavailable ? REMOTE_AGENT_REASON : undefined}>
      <span aria-label={unavailable ? REMOTE_AGENT_REASON : undefined} className="min-w-0">
        <PageTurnChip
          turn={turn}
          holder={holder}
          onStart={onStart}
          disabled={disabled || unavailable}
          onOpenPage={onOpenPage}
        />
      </span>
    </NodexTooltip>
  );
}
