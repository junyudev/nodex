import { useIntl } from "@/lib/i18n";
import type { PageTurn } from "../../../shared/page-turn";
import { useMembers, useLocalMember } from "@/lib/members-runtime";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import type { PageTurnHolder } from "@/lib/page-turn-phrase";
import { PageTurnChip } from "./page-turn-chip";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { SPACE_ACTION_REASON_MESSAGES } from "../../../shared/space-connection";
import { NodexTooltip } from "@/components/ui/tooltip";

/** Names the person or Agent whose move a Page waits for, relative to this reader. */
export function usePageTurnHolder(turn: PageTurn | null | undefined): PageTurnHolder {
  const intl = useIntl();
  const members = useMembers();
  const local = useLocalMember();
  const providers = useAgentRuntimeProviders();
  const actor = turn?.actor;
  if (actor?.kind === "member")
    return actor.member_id === local.data?.id
      ? {
          you: true,
          name: intl.formatMessage({ id: "workbench.pageTurn.you", defaultMessage: "You" }),
        }
      : {
          you: false,
          name:
            members.data?.find((member) => member.id === actor.member_id)?.display_name ??
            intl.formatMessage({ id: "workbench.pageTurn.someone", defaultMessage: "Someone" }),
        };
  if (actor?.kind === "agent" && actor.assignee.kind === "agent") {
    const instanceId = actor.assignee.instance_id;
    return {
      you: false,
      name:
        providers.data?.find((provider) => provider.instanceId === instanceId)?.displayName ??
        (instanceId === "codex"
          ? "Codex"
          : intl.formatMessage({ id: "workbench.pageTurn.agent", defaultMessage: "The Agent" })),
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
  const intl = useIntl();
  const holder = usePageTurnHolder(turn);
  const hostAvailable = useSpaceHostAvailable();
  const unavailableReason =
    !hostAvailable && onStart
      ? intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteAgent)
      : undefined;
  return (
    <NodexTooltip tooltipContent={unavailableReason}>
      <span aria-label={unavailableReason} className="min-w-0">
        <PageTurnChip
          turn={turn}
          holder={holder}
          onStart={onStart}
          disabled={disabled || Boolean(unavailableReason)}
          onOpenPage={onOpenPage}
        />
      </span>
    </NodexTooltip>
  );
}
