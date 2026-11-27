import { useState } from "react";
import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import {
  describeFollowUpPlace,
  describeFollowUpState,
  FollowUpDecisions,
  FollowUpGlyph,
  isFollowUpOpen,
  orderFollowUps,
  useFollowUpActions,
  useFollowUpDestination,
  type FollowUpActions,
} from "@/features/inbox/follow-ups";
import { useInboxClock } from "@/features/inbox/use-inbox-clock";
import { useIntl } from "@/lib/i18n";
import type { SessionFollowUp, SessionFollowUps } from "../../../../../shared/inbox";
import {
  ThreadSummaryPanelRow,
  ThreadSummaryPanelShowMoreButton,
} from "./thread-summary-panel-row";
import {
  ThreadSummaryPanelCountBadge,
  ThreadSummaryPanelSection,
} from "./thread-summary-panel-section";

const FOLLOW_UP_INITIAL_LIMIT = 5;

function FollowUpRow({
  followUp,
  sessionId,
  actions,
  canFork,
}: {
  readonly followUp: SessionFollowUp;
  readonly sessionId: string;
  readonly actions: FollowUpActions;
  readonly canFork: boolean;
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
  const open = isFollowUpOpen(followUp.state);
  return (
    <ThreadSummaryPanelRow
      label={followUp.title}
      title={`${followUp.title}\n${stateLabel}`}
      icon={<FollowUpGlyph followUp={followUp} className="icon-xs" />}
      actions={
        open ? (
          <FollowUpDecisions
            followUp={followUp}
            actions={actions}
            canFork={canFork}
            density="row"
          />
        ) : undefined
      }
      // Where a handled follow-up went stays readable at rest; an open one shows its decisions.
      trailing={
        open ? undefined : (
          <span className="block max-w-24 truncate text-sm text-token-text-tertiary">
            {describeFollowUpPlace(followUp, destination, intl)}
          </span>
        )
      }
      trailingVisible
      onClick={handlers.onClick}
    />
  );
}

/**
 * The Inbox messages this chat's Agents left for later, open ones first. The count beside the
 * title is what still waits for a decision.
 */
export function ThreadSummaryFollowUpsSection({
  sessionId,
  followUps,
  openCount,
  canFork,
}: {
  readonly sessionId: string;
  readonly followUps: SessionFollowUps;
  readonly openCount: number;
  readonly canFork: boolean;
}) {
  const intl = useIntl();
  const actions = useFollowUpActions({ sessionId, storeEpoch: followUps.storeEpoch });
  const [expanded, setExpanded] = useState(false);
  const ordered = orderFollowUps(followUps.items);
  const visible = expanded ? ordered : ordered.slice(0, FOLLOW_UP_INITIAL_LIMIT);
  return (
    <ThreadSummaryPanelSection
      sectionKey="follow-ups"
      title={intl.formatMessage({
        id: "conversation.threadSummaryFollowUps.title",
        defaultMessage: "Follow-ups",
      })}
      titleSuffix={<ThreadSummaryPanelCountBadge count={openCount} />}
      defaultCollapsed={openCount === 0}
    >
      {visible.map((followUp) => (
        <FollowUpRow
          key={followUp.pageId}
          followUp={followUp}
          sessionId={sessionId}
          actions={actions}
          canFork={canFork}
        />
      ))}
      {!expanded && ordered.length > FOLLOW_UP_INITIAL_LIMIT ? (
        <ThreadSummaryPanelShowMoreButton onClick={() => setExpanded(true)} />
      ) : null}
    </ThreadSummaryPanelSection>
  );
}
