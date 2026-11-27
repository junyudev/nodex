import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import {
  FollowUpDecisions,
  describeFollowUpState,
  FollowUpGlyph,
  useFollowUpActions,
  useFollowUpDestination,
  type FollowUpActions,
} from "@/features/inbox/follow-ups";
import { useInboxClock } from "@/features/inbox/use-inbox-clock";
import { useSessionFollowUps } from "@/features/inbox/use-session-follow-ups";
import { useIntl } from "@/lib/i18n";
import type { SessionFollowUp } from "../../../../shared/inbox";
import { useConversationRuntimeOverride } from "../conversation-runtime";
import { ThreadResourceCard } from "./shared/thread-resource-card";

function FollowUpCard({
  followUp,
  sessionId,
  actions,
}: {
  readonly followUp: SessionFollowUp;
  readonly sessionId: string;
  readonly actions: FollowUpActions;
}) {
  const intl = useIntl();
  const destination = useFollowUpDestination(followUp, sessionId);
  const now = useInboxClock();
  const stateLabel = describeFollowUpState(followUp, destination, new Date(now), intl);
  const { handlers } = useNodexReferenceInteraction({
    destination: { kind: "page", pageId: followUp.pageId },
    openable: true,
    title: followUp.title,
  });
  return (
    <ThreadResourceCard
      aria-label={intl.formatMessage(
        { id: "conversation.followUps.open", defaultMessage: "Open {title}" },
        { title: followUp.title },
      )}
      icon={<FollowUpGlyph followUp={followUp} className="icon-xs" />}
      title={followUp.title}
      detail={
        <span className="truncate text-sm text-token-description-foreground">{stateLabel}</span>
      }
      trailing={<FollowUpDecisions followUp={followUp} actions={actions} canFork density="card" />}
      {...handlers}
    />
  );
}

/**
 * The Inbox messages a completed turn left for later, beneath what it delivered. The turn names
 * them; each card reads its message as it is now, so a follow-up handled anywhere says where it
 * went, and one still waiting can be continued in this chat or a fork of it.
 */
export function LocalConversationFollowUps({ pageIds }: { readonly pageIds: readonly string[] }) {
  const sessionId = useConversationRuntimeOverride()?.sessionId ?? null;
  const followUps = useSessionFollowUps(sessionId);
  const actions = useFollowUpActions({
    sessionId: sessionId ?? "",
    storeEpoch: followUps.data?.storeEpoch ?? null,
  });
  if (!sessionId || !followUps.data) return null;
  const byPage = new Map(followUps.data.items.map((item) => [item.pageId, item]));
  const items = pageIds.flatMap((pageId) => byPage.get(pageId) ?? []);
  if (items.length === 0) return null;
  return (
    <div data-content-search-skip="true" className="flex flex-col gap-2">
      {items.map((followUp) => (
        <FollowUpCard
          key={followUp.pageId}
          followUp={followUp}
          sessionId={sessionId}
          actions={actions}
        />
      ))}
    </div>
  );
}
