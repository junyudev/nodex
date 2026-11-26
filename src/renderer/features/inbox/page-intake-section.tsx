import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import { ChatIcon, ChevronRightIcon } from "@/components/shared/icons";
import { MessageText } from "@/components/message/message-document";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useAgentRuntimeSessionActivity } from "@/lib/agent-runtime-session-activity";
import { isRemoteSpace } from "@/lib/renderer-space";
import { runtimeSessionLiveIndicator } from "@/lib/session-execution";
import { cn } from "@/lib/utils";
import {
  inboxActionSkills,
  inboxScopeProjectId,
  LIBRARY_INBOX,
  type InboxHandoff,
  type InboxItem,
} from "../../../shared/inbox";
import {
  inboxSuggestionPolicy,
  inboxSuggestionsOffered,
} from "../../../shared/inbox-suggestion-policy";
import { useInboxAgents } from "./inbox-agent-picker";
import type { InboxDispatchDraft } from "./inbox-dispatch-editor";
import { InboxMessageMenu, inboxMessageMenuHandlers } from "./inbox-message";
import { InboxChatStatusDot } from "./inbox-outcome";
import { useInboxPageHost, type InboxPageHost } from "./inbox-page-host";
import {
  describeInboxChatStatus,
  describeInboxHandoff,
  formatInboxTime,
  inboxTriageModel,
  isChatAction,
} from "./inbox-presentation";
import { InboxSkillList } from "./inbox-skill-review";
import { InboxTriage, SuggestionProvenance } from "./inbox-triage";
import { usePageIntake, useInboxSummary } from "./use-inbox";
import { useInboxActions } from "./use-inbox-actions";
import { useInboxClock } from "./use-inbox-clock";

/**
 * What the Inbox made of a message, on the message's own Page beneath its body: the suggestion
 * and the decision while the message waits, then what that decision sent to a chat. A Page that
 * was never a message, or one the reader cannot decide, shows nothing.
 */
export function PageIntakeSection({
  pageId,
  onOpenPage,
}: {
  readonly pageId: string;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const host = useInboxPageHost();
  // A host without an Inbox reads nothing; each Page keeps its own decision state.
  return host ? (
    <PageIntake key={pageId} pageId={pageId} host={host} onOpenPage={onOpenPage} />
  ) : null;
}

function PageIntake({
  pageId,
  host,
  onOpenPage,
}: {
  readonly pageId: string;
  readonly host: InboxPageHost;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const intake = usePageIntake(pageId).data;
  if (!intake) return null;
  if (intake.message?.rowKind === "intake")
    return <PageIntakeDecision item={intake.message} host={host} onOpenPage={onOpenPage} />;
  if (intake.handoff) return <PageIntakeHandoff handoff={intake.handoff} host={host} />;
  return null;
}

function SectionHeading({ children }: { readonly children: ReactNode }) {
  return <h2 className="py-1 text-sm font-medium text-token-text-secondary">{children}</h2>;
}

function Quiet({ children }: { readonly children: ReactNode }) {
  return <p className="text-[13px] leading-5 text-token-description-foreground">{children}</p>;
}

/**
 * The message's decision, exactly as its Inbox row offers it. The Page is the message, so the
 * strip and its row sit beneath the body rather than inside a card.
 */
function PageIntakeDecision({
  item,
  host,
  onOpenPage,
}: {
  readonly item: InboxItem;
  readonly host: InboxPageHost;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const intl = useIntl();
  const agents = useInboxAgents();
  const policy = inboxSuggestionPolicy(agents.settings, agents.providers, useInboxClock());
  const suggestionsOffered = !isRemoteSpace() && inboxSuggestionsOffered(policy);
  // Decisions recorded here are recovered by the Inbox that lists the message.
  const scope = item.scope.kind === "project" ? item.scope : LIBRARY_INBOX;
  const summary = useInboxSummary(scope);
  const actions = useInboxActions(
    host.projects,
    scope,
    host.windowSessionId,
    summary.data?.storeEpoch ?? null,
    [item],
    {
      onOpenNotes: onOpenPage,
      onDecided: (pageIds, decision) => {
        if (
          decision.kind === "chat" &&
          decision.type === "new_chat" &&
          agents.settings.showPageBesideNewChats
        )
          void host.showPagesInChat({
            sessionId: decision.sessionId,
            pages: pageIds.map((pageId) => ({
              pageId,
              ...(pageId === item.pageId ? { titleSnapshot: item.title } : {}),
            })),
          });
      },
    },
  );
  const [manualDraft, setManualDraft] = useState<InboxDispatchDraft | null>(null);
  // Only advice is titled; a failed delivery, an Automation's run or a hand-written dispatch
  // says what it is in its own words.
  const model = inboxTriageModel(item, policy, intl);
  const titled =
    !manualDraft &&
    !item.automationDecision &&
    (model.kind === "suggestion" ||
      model.kind === "suggesting" ||
      model.kind === "suggestion-failed" ||
      (model.kind === "undecided" && suggestionsOffered));
  return (
    <InboxTriage
      item={item}
      surface="page"
      projects={host.projects}
      agents={agents}
      inboxProjectId={inboxScopeProjectId(item.scope)}
      policy={policy}
      actions={actions}
      manualDraft={manualDraft}
      groupedWithKey={null}
      menu={(rowOffers, handleManually) => (
        // The Page's own menu deletes it, and the message with it.
        <InboxMessageMenu
          item={item}
          rowOffers={rowOffers}
          handlers={inboxMessageMenuHandlers(item, actions, {
            onDispatch: handleManually,
            suggestionsOffered,
          })}
        />
      )}
      onManualDraftChange={setManualDraft}
      onOpenPage={onOpenPage}
      onOpenSession={host.openSession}
      onOpenAutomation={host.openAutomation}
    >
      {/* The body above is the message and is edited in place, so the Page shows neither the
          stream's Copy and Edit nor the stream's message editor. */}
      {({ strip, actions: row }) =>
        strip || row ? (
          <section
            data-page-intake="decision"
            className="mb-6 flex flex-col gap-2 border-t border-token-border pt-3"
          >
            {titled ? (
              <SectionHeading>
                <FormattedMessage id="inbox.pageIntake.suggestion" defaultMessage="Suggestion" />
              </SectionHeading>
            ) : null}
            {/* The stream lets the message card speak while there is no advice; a Page says so. */}
            {strip ??
              (titled && model.kind === "suggesting" ? (
                <Quiet>
                  <FormattedMessage
                    id="inbox.pageIntake.findingWhereThisGoes"
                    defaultMessage="Finding where this goes…"
                  />
                </Quiet>
              ) : titled && model.kind === "undecided" ? (
                <Quiet>
                  <FormattedMessage
                    id="inbox.pageIntake.noSuggestionYet"
                    defaultMessage="No suggestion yet"
                  />
                </Quiet>
              ) : null)}
            {row}
          </section>
        ) : null
      }
    </InboxTriage>
  );
}

/**
 * What the decision sent to a chat, kept on the Page once the message left the Inbox: one line
 * saying where it went, opening to exactly what the chat received and why Nodex suggested it.
 * It matters most when Nodex started the chat for the reader, who never saw the suggestion.
 */
function PageIntakeHandoff({
  handoff,
  host,
}: {
  readonly handoff: InboxHandoff;
  readonly host: InboxPageHost;
}) {
  const intl = useIntl();
  const onOpenSession = host.openSession;
  const [expanded, setExpanded] = useState(false);
  const { proposal } = handoff;
  const action = proposal.action;
  const presentation = describeInboxHandoff(handoff, intl);
  const chat = proposal.chat;
  const activity = useAgentRuntimeSessionActivity(chat?.executionRef ? chat.sessionId : null);
  const status = chat
    ? describeInboxChatStatus(chat, runtimeSessionLiveIndicator(activity), intl)
    : null;
  const sessionId = presentation.sessionId;
  const sent = isChatAction(action) ? action : null;
  const skills = inboxActionSkills(action);
  return (
    <section data-page-intake="handoff" className="mb-6 border-t border-token-border pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm text-token-text-secondary hover:text-token-text-primary"
        >
          <ChevronRightIcon className={cn("icon-2xs shrink-0", expanded && "rotate-90")} />
          <span className="min-w-0 truncate font-medium">{presentation.label}</span>
          <time
            dateTime={handoff.decidedAt}
            className="shrink-0 text-xs text-token-description-foreground tabular-nums"
          >
            {formatInboxTime(handoff.decidedAt, intl)}
          </time>
        </button>
        {sessionId ? (
          <NodexTooltip tooltipContent={status?.label} side="top">
            <NodexButton
              size="xs"
              variant="ghost"
              className="shrink-0 gap-1.5"
              onClick={() => onOpenSession(sessionId)}
            >
              {status ? <InboxChatStatusDot tone={status.tone} /> : null}
              <ChatIcon className="icon-xs shrink-0" />
              <FormattedMessage id="inbox.pageIntake.openChat" defaultMessage="Open chat" />
            </NodexButton>
          </NodexTooltip>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-3 pb-1 pl-5">
          {sent ? (
            <div
              aria-label={intl.formatMessage({
                id: "inbox.pageIntake.whatTheChatReceived",
                defaultMessage: "What the chat received",
              })}
              className="flex flex-col gap-2 border-l-2 border-token-border pl-3 text-sm text-token-foreground/85"
            >
              <MessageText text={sent.prompt} />
              {sent.additions.map((addition, index) => (
                <MessageText key={index} text={addition} />
              ))}
            </div>
          ) : null}
          <InboxSkillList skills={skills} />
          <SuggestionProvenance
            proposal={proposal}
            decidedBy={presentation.decidedBy}
            onOpenSession={onOpenSession}
          />
        </div>
      ) : null}
    </section>
  );
}
