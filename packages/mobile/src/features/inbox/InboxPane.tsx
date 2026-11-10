import { inboxEntryKey, inboxScopeKey, type InboxEntry } from "@nodex/mobile-protocol";
import { useMemo } from "react";
import { View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import { previewMarkdown } from "../../markdown/parse";
import { useRootNavigation } from "../../navigation/types";
import {
  discardCapture,
  retryCapture,
  useConnection,
  useHosts,
  useInbox,
  type InboxRow,
  type PendingCapture,
} from "../../runtime";
import { BottomAnchoredList } from "../../ui/BottomAnchoredList";
import { insetPadding, type ContentInsets } from "../../ui/ComposerLayout";
import { formatStreamTime } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { cn } from "../../ui/cn";
import { Button, Chip, EmptyState, Tap, Txt, lightTap } from "../../ui/primitives";
import { useNow } from "../../ui/use-now";
import { spaceUnreachable } from "../home/ConnectionNotice";
import { useHomeState, type ReplyTarget } from "../home/home-state";
import {
  entryChatSession,
  entrySignature,
  type EntrySignature,
  outcomeLabel,
  proposalAction,
  sourceLabel,
  suggestionView,
  turnActionView,
} from "./inbox-presentation";
import { SuggestionCard } from "./Suggestion";
import { useDecide } from "./use-decide";
import { useInboxScope } from "./use-inbox-choices";

// Whole class names, so the stylesheet compiler can see every one.
const SIGNATURE_TEXT: Readonly<Record<EntrySignature["tone"], string>> = {
  warning: "text-warning",
  accent: "text-accent",
  danger: "text-danger",
  "ink-3": "text-ink-3",
};

/** Who has the turn and why, with the row's time at the end of the same line. */
export const SignatureLine = ({
  entry,
  time,
}: {
  readonly entry: InboxEntry;
  readonly time: string | null;
}) => {
  const signature = entrySignature(entry);
  if (!signature) return null;
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name={signature.icon} size={13} color={signature.tone} />
      <Txt
        className={cn("flex-1 text-xs font-medium", SIGNATURE_TEXT[signature.tone])}
        numberOfLines={1}
      >
        {signature.label}
      </Txt>
      {time ? <Txt className="text-xs text-ink-3">{time}</Txt> : null}
    </View>
  );
};

const MessageRow = ({ message, now }: { readonly message: InboxEntry; readonly now: number }) => {
  const navigation = useRootNavigation();
  const preview = useMemo(() => previewMarkdown(message.body), [message.body]);
  const decide = useDecide();
  const setReplyTo = useHomeState((state) => state.setReplyTo);
  const { activeHostId } = useHosts();
  const time = formatStreamTime(Date.parse(message.submittedAt), now);
  const chatSessionId = entryChatSession(message);
  // The row reads as one button, so its decision is also offered as that button's action.
  const view = suggestionView(message);
  const offer = view.kind === "offer" && !view.proposal.outdated ? view.proposal : null;
  const intake = message.rowKind === "intake";
  return (
    <Tap
      accessibilityActions={
        offer ? [{ name: "decide", label: proposalAction(offer.action).label }] : undefined
      }
      accessibilityHint={chatSessionId ? "Opens its chat" : "Opens the message"}
      onAccessibilityAction={() => {
        if (offer) {
          void decide(
            message.id,
            { type: "accept", proposalId: offer.proposalId, revision: offer.revision },
            offer.action.type === "keep" ? "Kept" : "Done",
          );
        }
      }}
      className="gap-2 px-4 py-3"
      pressedClassName="active:bg-surface-2"
      onPress={() =>
        chatSessionId
          ? navigation.navigate("Chat", { sessionId: chatSessionId })
          : navigation.navigate("Message", { pageId: message.id, initial: message })
      }
    >
      <SignatureLine entry={message} time={intake ? null : time} />
      {message.rowKind === "turn" || message.rowKind === "problem" ? (
        <Txt className="font-medium text-ink">{message.title}</Txt>
      ) : null}
      {preview.text ? (
        <Markdown
          text={preview.text}
          selectable={false}
          actions={{ onOpenChat: (sessionId) => navigation.navigate("Chat", { sessionId }) }}
        />
      ) : null}
      <EntryActions
        entry={message}
        onReply={(target) => {
          lightTap();
          setReplyTo({ ...target, spaceKey: activeHostId });
        }}
      />
      <SuggestionCard message={message} />
      <View className="flex-row items-center gap-1.5">
        {message.important ? <Icon name="starFilled" size={12} color="warning" /> : null}
        <Txt className="text-xs text-ink-3" numberOfLines={1}>
          {[
            formatStreamTime(Date.parse(message.submittedAt), now),
            sourceLabel(message),
            outcomeLabel(message),
            preview.cut || message.bodyTruncated ? "More" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Txt>
      </View>
    </Tap>
  );
};

const PendingRow = ({ capture }: { readonly capture: PendingCapture }) => (
  <View className="gap-2 px-4 py-3">
    {capture.text ? <Txt className="text-ink-2">{capture.text}</Txt> : null}
    {capture.images.length > 0 ? (
      <Txt className="text-sm text-ink-3">
        {capture.images.length === 1 ? "1 photo" : `${capture.images.length} photos`}
      </Txt>
    ) : null}
    {capture.state === "failed" ? (
      <View className="flex-row items-center gap-2">
        <Icon name="warning" size={14} color="danger" />
        <Txt className="flex-1 text-sm text-ink-2" numberOfLines={2}>
          {capture.error ?? "Nodex could not save this."}
        </Txt>
        <Button compact label="Retry" onPress={() => retryCapture(capture.captureId)} />
        <Button compact label="Discard" onPress={() => discardCapture(capture.captureId)} />
      </View>
    ) : (
      <View className="flex-row items-center gap-1.5">
        <Icon name="clock" size={12} color="ink-3" />
        <Txt className="text-xs text-ink-3">
          {capture.state === "sending" ? "Sending" : "Waiting for this Space"}
        </Txt>
      </View>
    )}
  </View>
);

const rowKey = (row: InboxRow): string =>
  row.type === "message" ? inboxEntryKey(row.message) : row.capture.captureId;

/** The Inbox stream, newest at the bottom beside the Composer, as it reads on the desktop. */
export const InboxPane = ({ insets }: { readonly insets: ContentInsets }) => {
  const { scope } = useInboxScope();
  const filter = useHomeState((state) => state.filter);
  const capturesSent = useHomeState((state) => state.capturesSent);
  const inbox = useInbox(scope, filter);
  const now = useNow();
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  if (inbox.rows.length === 0) {
    if (inbox.loading) return <View className="flex-1" />;
    if (spaceUnreachable(connection.status)) {
      const name = hosts.find((host) => host.hostId === activeHostId)?.hostName ?? "this Space";
      return (
        <View className="flex-1" style={insetPadding(insets)}>
          <EmptyState
            icon="warning"
            title={`No access to ${name}`}
            detail="Link this phone again, or switch to another Space."
          />
        </View>
      );
    }
    return (
      <View className="flex-1" style={insetPadding(insets)}>
        {filter === "inbox" ? (
          <EmptyState icon="inbox" title="Nothing waiting" detail="Drop a thought here." />
        ) : (
          <EmptyState icon="history" title="Nothing handled yet" />
        )}
      </View>
    );
  }
  return (
    <BottomAnchoredList
      key={`${inboxScopeKey(scope)}:${filter}`}
      insets={insets}
      sentCount={capturesSent}
      data={inbox.rows}
      getItemType={(row) => row.type}
      keyExtractor={rowKey}
      onStartReached={inbox.hasMore ? inbox.loadMore : undefined}
      renderItem={({ item }) =>
        item.type === "message" ? (
          <MessageRow message={item.message} now={now} />
        ) : (
          <PendingRow capture={item.capture} />
        )
      }
    />
  );
};

/** A note in place of an action this phone cannot take, saying where it can. */
const ElsewhereLine = ({ text }: { readonly text: string }) => (
  <View className="flex-row items-center gap-1.5">
    <Icon name="laptop" size={14} color="ink-3" />
    <Txt className="flex-1 text-sm text-ink-3" numberOfLines={2}>
      {text}
    </Txt>
  </View>
);

const PROBLEM_FIX_LABELS = {
  retry: "Retry",
  reconnect: "Reconnect",
  open_card: "Open Page",
} as const;

/**
 * The same semantic actions appear in the stream and detail. A Turn's one decision leads; options
 * answer its question; Reply hands the words to the Composer, or to the chat where there is none.
 */
export const EntryActions = ({
  entry,
  onReply,
}: {
  readonly entry: InboxEntry;
  readonly onReply?: (target: ReplyTarget) => void;
}) => {
  const navigation = useRootNavigation();
  const decide = useDecide();
  if (entry.rowKind === "intake" || entry.rowKind === "answer") return null;
  if (entry.rowKind === "problem") {
    const { problem } = entry;
    if (problem.capability.kind === "unavailable")
      return <ElsewhereLine text={problem.capability.reason} />;
    return (
      <View className="flex-row">
        <Button
          compact
          label={PROBLEM_FIX_LABELS[problem.fix]}
          onPress={() =>
            void decide(
              entry.id,
              { type: "problem_fix", problemId: problem.id, fix: problem.fix },
              "Trying again",
            )
          }
        />
      </View>
    );
  }
  const { episode, chatSessionId } = entry.turn;
  const view = turnActionView(entry);
  const openChat = chatSessionId
    ? () => navigation.navigate("Chat", { sessionId: chatSessionId })
    : null;
  const reply = view.reply
    ? () => (onReply ? onReply({ entryId: entry.id, episode, title: entry.title }) : openChat?.())
    : null;
  const actions = [
    view.accept ? (
      <Button
        key="accept"
        compact
        label="Accept"
        tone="primary"
        onPress={() => void decide(entry.id, { type: "turn_accept", episode }, "Accepted")}
      />
    ) : null,
    view.start ? (
      <Button
        key="start"
        compact
        label="Start"
        tone="primary"
        onPress={() => void decide(entry.id, { type: "turn_start", episode }, "Started")}
      />
    ) : null,
    // Approvals carry their exact request and options in the chat.
    view.reviewRequest && openChat ? (
      <Button key="approve" compact label="Review request" tone="primary" onPress={openChat} />
    ) : null,
    ...view.options.map((text) => (
      <Button
        key={`option:${text}`}
        compact
        label={text}
        onPress={() => void decide(entry.id, { type: "turn_reply", episode, text }, "Answered")}
      />
    )),
    reply ? <Chip key="reply" icon="undo" label="Reply" onPress={reply} /> : null,
  ].filter(Boolean);
  if (actions.length === 0 && !entry.turn.deliveryError && !view.unavailableReason) return null;
  return (
    <View className="gap-1.5">
      {actions.length > 0 ? <View className="flex-row flex-wrap gap-2">{actions}</View> : null}
      {view.unavailableReason ? (
        <Txt className="text-sm text-ink-3">{view.unavailableReason}</Txt>
      ) : null}
      {entry.turn.deliveryError ? (
        <Txt className="text-xs text-danger">{entry.turn.deliveryError}</Txt>
      ) : null}
    </View>
  );
};
