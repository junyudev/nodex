import { inboxScopeKey, type InboxMessage } from "@nodex/mobile-protocol";
import { useMemo } from "react";
import { View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import { previewMarkdown } from "../../markdown/parse";
import { useRootNavigation } from "../../navigation/types";
import {
  discardCapture,
  retryCapture,
  useInbox,
  type InboxRow,
  type PendingCapture,
} from "../../runtime";
import { BottomAnchoredList } from "../../ui/BottomAnchoredList";
import { insetPadding, type ContentInsets } from "../../ui/ComposerLayout";
import { formatStreamTime } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { Button, EmptyState, Tap, Txt } from "../../ui/primitives";
import { useNow } from "../../ui/use-now";
import { useHomeState } from "../home/home-state";
import {
  outcomeLabel,
  proposalAcceptance,
  proposalAction,
  sourceLabel,
  suggestionView,
} from "./inbox-presentation";
import { SuggestionCard } from "./Suggestion";
import { useDecide } from "./use-decide";

const MessageRow = ({ message, now }: { readonly message: InboxMessage; readonly now: number }) => {
  const navigation = useRootNavigation();
  const preview = useMemo(() => previewMarkdown(message.body), [message.body]);
  const decide = useDecide();
  // The row reads as one button, so its decision is also offered as that button's action.
  const view = suggestionView(message);
  const offer = view.kind === "offer" && !view.proposal.outdated ? view.proposal : null;
  return (
    <Tap
      accessibilityActions={
        offer ? [{ name: "decide", label: proposalAction(offer.action).label }] : undefined
      }
      accessibilityHint="Opens the message"
      onAccessibilityAction={() => {
        if (offer) {
          const { decision, done } = proposalAcceptance(offer);
          void decide(message.pageId, decision, done);
        }
      }}
      className="gap-2 px-4 py-3"
      pressedClassName="active:bg-surface-2"
      onPress={() => navigation.navigate("Message", { pageId: message.pageId, initial: message })}
    >
      <Markdown
        text={preview.text}
        selectable={false}
        actions={{ onOpenChat: (sessionId) => navigation.navigate("Chat", { sessionId }) }}
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
          {capture.state === "sending" ? "Sending" : "Waiting for your desktop"}
        </Txt>
      </View>
    )}
  </View>
);

const rowKey = (row: InboxRow): string =>
  row.type === "message" ? row.message.pageId : row.capture.captureId;

/** The Inbox stream, newest at the bottom beside the Composer, as it reads on the desktop. */
export const InboxPane = ({ insets }: { readonly insets: ContentInsets }) => {
  const scope = useHomeState((state) => state.scope);
  const filter = useHomeState((state) => state.filter);
  const capturesSent = useHomeState((state) => state.capturesSent);
  const inbox = useInbox(scope, filter);
  const now = useNow();
  if (inbox.rows.length === 0) {
    if (inbox.loading) return <View className="flex-1" />;
    return (
      <View className="flex-1" style={insetPadding(insets)}>
        {filter === "inbox" ? (
          <EmptyState
            icon="inbox"
            title="Nothing waiting"
            detail="Drop a thought here. It lands on your desktop."
          />
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
