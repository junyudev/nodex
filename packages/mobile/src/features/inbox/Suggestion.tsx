import type { InboxEntry, InboxProposal } from "@nodex/mobile-protocol";
import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "../../markdown/Markdown";
import { useRootNavigation, type ScreenProps } from "../../navigation/types";
import { fetchInboxEntry, onInboxChanged, useAgentCatalog, useProjects } from "../../runtime";
import { Icon } from "../../ui/icons";
import { Button, EmptyState, Tap, Txt } from "../../ui/primitives";
import { agentLabel } from "../pickers/agent-choice";
import {
  proposalAcceptance,
  proposalAction,
  proposalAttribution,
  proposalDestination,
  proposalHeadline,
  proposalSkills,
  suggestionView,
} from "./inbox-presentation";
import { useDecide } from "./use-decide";

/**
 * The message as its Space has it now, showing the copy already in hand until that arrives, and
 * following it as it changes, so a decision's progress shows where it was made.
 */
export const useInboxEntry = (pageId: string, initial: InboxEntry | undefined) => {
  const [message, setMessage] = useState<InboxEntry | null>(initial ?? null);
  useEffect(() => {
    let latest = 0;
    let open = true;
    const read = () => {
      const attempt = ++latest;
      fetchInboxEntry(pageId)
        .then((fresh) => {
          if (open && attempt === latest) setMessage(fresh);
        })
        .catch(() => {
          // The copy in hand stays on screen; a stale read is better than an empty page.
        });
    };
    read();
    const stop = onInboxChanged(read);
    return () => {
      open = false;
      stop();
    };
  }, [pageId]);
  return [message, setMessage] as const;
};

const QuietLine = ({ text }: { readonly text: string }) => (
  <View className="flex-row items-center gap-1.5">
    <Icon name="agent" size={14} color="ink-3" />
    <Txt className="text-sm text-ink-3">{text}</Txt>
  </View>
);

const OUTDATED = "This changed after it was suggested. Review it on your desktop.";

const AcceptButton = ({
  message,
  proposal,
  compact,
  droppedSkillNames,
  onAccepted,
}: {
  readonly message: InboxEntry;
  readonly proposal: InboxProposal;
  readonly compact?: boolean;
  readonly droppedSkillNames?: readonly string[];
  readonly onAccepted?: () => void;
}) => {
  const decide = useDecide();
  const action = proposalAction(proposal.action);
  const { decision, done } = proposalAcceptance(proposal, droppedSkillNames);
  return (
    <Button
      compact={compact}
      icon={action.icon}
      label={action.label}
      tone="primary"
      onPress={() => {
        void decide(message.id, decision, done);
        onAccepted?.();
      }}
    />
  );
};

/**
 * Suggestion states that are not an offer, wherever a message's advice is shown: still being
 * written, failed, or undeliverable. Returns null for an offer and for no advice at all.
 */
const SuggestionStatus = ({ message }: { readonly message: InboxEntry }) => {
  const decide = useDecide();
  const view = suggestionView(message);
  switch (view.kind) {
    case "thinking":
      return <QuietLine text="Looking at this" />;
    case "dispatching":
      return <QuietLine text="Delivering" />;
    case "failed":
      return (
        <View className="flex-row items-start gap-1.5">
          <Icon name="warning" size={14} color="danger" />
          <Txt selectable className="flex-1 text-sm text-ink-2">
            {view.message}
          </Txt>
        </View>
      );
    case "dispatch-failed":
      return (
        <View className="flex-row items-center gap-2">
          <Icon name="warning" size={14} color="danger" />
          <Txt selectable className="flex-1 text-sm text-ink-2">
            {view.headline} — {view.message}
          </Txt>
          {view.retry ? (
            <Button
              compact
              label="Retry"
              onPress={() =>
                void decide(
                  message.id,
                  { type: "retry", proposalId: view.proposal.proposalId },
                  "Trying again",
                )
              }
            />
          ) : null}
        </View>
      );
    case "none":
    case "offer":
      return null;
  }
};

/**
 * A message's advice in the stream: enough to decide at a glance, one decision labeled by what it
 * does, and the whole suggestion a tap away.
 */
export const SuggestionCard = ({ message }: { readonly message: InboxEntry }) => {
  const navigation = useRootNavigation();
  const view = suggestionView(message);
  if (view.kind !== "offer") return <SuggestionStatus message={message} />;
  const { proposal } = view;
  const destination = proposal.outdated ? null : proposalDestination(proposal.action);
  return (
    <Tap
      accessibilityHint="Shows the whole suggestion"
      className="gap-2 rounded-[20px] bg-fill p-3"
      onPress={() => navigation.navigate("Suggestion", { pageId: message.id, initial: message })}
    >
      <Txt className="text-sm" numberOfLines={3}>
        {proposal.outdated ? OUTDATED : proposal.summary}
      </Txt>
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-1">
          <Icon name="agent" size={14} color="ink-3" />
          <Txt className="shrink text-xs text-ink-3" numberOfLines={1}>
            {destination ?? proposalAttribution(proposal)}
          </Txt>
          <Icon name="chevronRight" size={12} color="ink-3" />
        </View>
        {proposal.outdated || proposalSkills(proposal).length ? null : (
          <AcceptButton compact message={message} proposal={proposal} />
        )}
      </View>
    </Tap>
  );
};

const Section = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <View className="gap-1.5">
    <Txt className="text-xs font-medium text-ink-3">{label}</Txt>
    {children}
  </View>
);

/** Everything a suggestion would do, so accepting it is never a guess. */
const SuggestionDetail = ({
  proposal,
  dropped,
  onToggle,
}: {
  readonly proposal: InboxProposal;
  readonly dropped: readonly string[];
  readonly onToggle: (name: string) => void;
}) => {
  const navigation = useRootNavigation();
  const { catalog } = useAgentCatalog();
  const { projects } = useProjects();
  const { action } = proposal;
  const chatAction = action.type === "new_chat" || action.type === "send_to_chat" ? action : null;
  return (
    <View className="gap-4">
      <View className="gap-1.5">
        <View className="flex-row items-center gap-1">
          <Icon name="agent" size={14} color="ink-3" />
          <Txt className="shrink text-xs text-ink-3">{proposalAttribution(proposal)}</Txt>
        </View>
        <Txt selectable className="text-xl font-semibold">
          {proposalHeadline(action)}
        </Txt>
        {proposal.summary ? (
          <Txt selectable className="text-ink-2">
            {proposal.summary}
          </Txt>
        ) : null}
      </View>
      {proposal.outdated ? (
        <View className="flex-row items-start gap-1.5">
          <Icon name="laptop" size={15} color="ink-3" />
          <Txt className="flex-1 text-sm text-ink-3">{OUTDATED}</Txt>
        </View>
      ) : null}
      {chatAction ? (
        <Section label={action.type === "new_chat" ? "The chat starts with" : "What it sends"}>
          <View className="rounded-[18px] bg-fill px-3.5 py-3">
            <Markdown
              text={chatAction.prompt}
              actions={{ onOpenChat: (sessionId) => navigation.push("Chat", { sessionId }) }}
            />
          </View>
        </Section>
      ) : null}
      {proposalSkills(proposal).map(({ name, reason }) => (
        <Tap
          key={name}
          accessibilityLabel={`Use ${name} skill`}
          accessibilityHint={reason}
          accessibilityState={{ selected: !dropped.includes(name) }}
          disabled={proposal.outdated}
          onPress={() => onToggle(name)}
        >
          <Txt>{name}</Txt>
        </Tap>
      ))}
      {chatAction && chatAction.additions.length > 0 ? (
        <Section label="It also adds">
          <View className="gap-1.5">
            {chatAction.additions.map((addition) => (
              <View key={addition} className="flex-row items-start gap-2">
                <Icon name="plus" size={15} color="ink-3" />
                <Txt selectable className="flex-1 text-sm">
                  {addition}
                </Txt>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {action.type === "plan" ? (
        <Section label="Plan">
          {action.summary ? <Txt selectable>{action.summary}</Txt> : null}
          {action.steps.map((step, index) => (
            <View key={step.key} className="gap-1">
              <Txt selectable className="font-medium">
                {index + 1}. {step.title}
              </Txt>
              <Markdown text={step.body} />
              <Txt className="text-xs text-ink-3">
                {projects.find((project) => project.id === step.projectId)?.name ?? step.projectId}
              </Txt>
              {step.blockedBy.length > 0 ? (
                <Txt className="text-xs text-ink-3">
                  Waits for{" "}
                  {step.blockedBy
                    .map(
                      (key) =>
                        action.steps.find((candidate) => candidate.key === key)?.title ?? key,
                    )
                    .join(", ")}
                </Txt>
              ) : null}
            </View>
          ))}
        </Section>
      ) : null}
      {proposal.rationale ? (
        <Section label="Why">
          <Txt selectable className="text-ink-2">
            {proposal.rationale}
          </Txt>
        </Section>
      ) : null}
      {action.type === "new_chat" && action.agent ? (
        <Section label="Runs on">
          <Txt selectable>{agentLabel(catalog, action.agent)}</Txt>
        </Section>
      ) : null}
    </View>
  );
};

function useReviewedSkills(proposal: InboxProposal | undefined) {
  const key = proposal ? `${proposal.proposalId}:${proposal.revision}` : null;
  const [review, setReview] = useState<{ key: string | null; dropped: readonly string[] }>({
    key,
    dropped: [],
  });
  return {
    dropped: review.key === key ? review.dropped : [],
    onToggle: (name: string) =>
      setReview((current) => {
        const dropped = current.key === key ? current.dropped : [];
        return {
          key,
          dropped: dropped.includes(name)
            ? dropped.filter((skill) => skill !== name)
            : [...dropped, name],
        };
      }),
  };
}

/** A message's advice laid open, for a screen already showing that message. */
export const SuggestionPanel = ({ message }: { readonly message: InboxEntry }) => {
  const view = suggestionView(message);
  const skills = useReviewedSkills(view.kind === "offer" ? view.proposal : undefined);
  if (view.kind !== "offer") return <SuggestionStatus message={message} />;
  return (
    <View className="gap-4 rounded-[24px] bg-fill p-4">
      <SuggestionDetail proposal={view.proposal} {...skills} />
      {view.proposal.outdated ? null : (
        <AcceptButton
          message={message}
          proposal={view.proposal}
          droppedSkillNames={skills.dropped}
        />
      )}
    </View>
  );
};

/** How much of the window the suggestion's text takes before it scrolls inside the sheet. */
const SHEET_TEXT_FRACTION = 0.72;

/** The whole of a suggestion from the stream, in a sheet that hugs it, decision within reach. */
export const SuggestionScreen = ({ route, navigation }: ScreenProps<"Suggestion">) => {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [message] = useInboxEntry(route.params.pageId, route.params.initial);
  const view = message ? suggestionView(message) : null;
  const skills = useReviewedSkills(view?.kind === "offer" ? view.proposal : undefined);
  if (!message || view?.kind !== "offer") {
    // A sheet that hugs its content has no height of its own for this to fill.
    return (
      <View style={{ height: 240 }}>
        <EmptyState icon="agent" title="This suggestion has been settled" />
      </View>
    );
  }
  return (
    <View>
      <ScrollView
        contentContainerClassName="px-5 pb-3 pt-7"
        style={{ maxHeight: height * SHEET_TEXT_FRACTION }}
      >
        <SuggestionDetail proposal={view.proposal} {...skills} />
      </ScrollView>
      {view.proposal.outdated ? (
        <View style={{ height: Math.max(insets.bottom, 16) }} />
      ) : (
        <View className="px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          <AcceptButton
            message={message}
            proposal={view.proposal}
            droppedSkillNames={skills.dropped}
            onAccepted={() => navigation.goBack()}
          />
        </View>
      )}
    </View>
  );
};
