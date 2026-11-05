import { inboxScopeKey, type InboxDecision, type InboxMessage } from "@nodex/mobile-protocol";
import { useMemo } from "react";
import { View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import { previewMarkdown } from "../../markdown/parse";
import { useRootNavigation } from "../../navigation/types";
import {
  decideInbox,
  discardCapture,
  retryCapture,
  undoInbox,
  useInbox,
  type InboxRow,
  type PendingCapture,
} from "../../runtime";
import { BottomAnchoredList } from "../../ui/BottomAnchoredList";
import { formatStreamTime } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { Button, EmptyState, Tap, Txt, lightTap } from "../../ui/primitives";
import { showFailure, showSnack } from "../../ui/snackbar";
import { useNow } from "../../ui/use-now";
import { useHomeState } from "../home/home-state";
import {
  outcomeLabel,
  proposalAction,
  proposalDestination,
  decisionReversal,
  sourceLabel,
  suggestionView,
} from "./inbox-presentation";

/** Runs a decision, then offers what it allows next: the chat it started, or undo. */
export const useDecide = () => {
  const navigation = useRootNavigation();
  return async (pageId: string, decision: InboxDecision, done: string): Promise<void> => {
    lightTap();
    try {
      const { undoToken, sessionId } = await decideInbox(pageId, decision);
      if (sessionId) {
        showSnack({
          text: done,
          action: { label: "Open", run: () => navigation.navigate("Chat", { sessionId }) },
        });
        return;
      }
      const reversal = decisionReversal(decision);
      const undo = undoToken
        ? () => undoInbox(undoToken)
        : reversal
          ? () => decideInbox(pageId, reversal)
          : null;
      showSnack({
        text: done,
        ...(undo
          ? {
              action: {
                label: "Undo",
                run: () => {
                  undo().catch((cause: unknown) => showFailure("Could not undo", cause));
                },
              },
            }
          : {}),
      });
    } catch (cause) {
      showFailure("That didn't go through", cause);
    }
  };
};

const QuietLine = ({ text }: { readonly text: string }) => (
  <View className="flex-row items-center gap-1.5">
    <Icon name="agent" size={14} color="ink-3" />
    <Txt className="text-sm text-ink-3">{text}</Txt>
  </View>
);

/** A message's advice, as its own part of the record: one decision, labeled by what it does. */
export const SuggestionLine = ({ message }: { readonly message: InboxMessage }) => {
  const decide = useDecide();
  const view = suggestionView(message);
  switch (view.kind) {
    case "none":
      return null;
    case "thinking":
      return <QuietLine text="Looking at this" />;
    case "dispatching":
      return <QuietLine text="Delivering" />;
    case "failed":
      return (
        <View className="flex-row items-center gap-1.5">
          <Icon name="warning" size={14} color="danger" />
          <Txt className="flex-1 text-sm text-ink-2" numberOfLines={2}>
            {view.message}
          </Txt>
        </View>
      );
    case "dispatch-failed":
      return (
        <View className="flex-row items-center gap-2">
          <Icon name="warning" size={14} color="danger" />
          <Txt className="flex-1 text-sm text-ink-2" numberOfLines={2}>
            {view.message}
          </Txt>
          <Button
            compact
            label="Retry"
            onPress={() =>
              void decide(
                message.pageId,
                { type: "retry", proposalId: view.proposal.proposalId },
                "Trying again",
              )
            }
          />
        </View>
      );
    case "offer": {
      if (view.proposal.outdated) {
        return (
          <View className="flex-row items-center gap-1.5">
            <Icon name="laptop" size={14} color="ink-3" />
            <Txt className="flex-1 text-sm text-ink-3" numberOfLines={2}>
              This changed after it was suggested. Review it on your desktop.
            </Txt>
          </View>
        );
      }
      const action = proposalAction(view.proposal.action);
      const destination = proposalDestination(view.proposal.action);
      return (
        <View className="flex-row items-center gap-2 rounded-2xl bg-surface-2 py-1.5 pl-3 pr-1.5">
          <View className="flex-1">
            <Txt className="text-sm text-ink-2" numberOfLines={2}>
              {view.proposal.summary}
            </Txt>
            {destination ? (
              <Txt className="text-xs text-ink-3" numberOfLines={1}>
                {destination}
              </Txt>
            ) : null}
          </View>
          <Button
            compact
            icon={action.icon}
            label={action.label}
            tone="primary"
            onPress={() =>
              void decide(
                message.pageId,
                {
                  type: "accept",
                  proposalId: view.proposal.proposalId,
                  revision: view.proposal.revision,
                },
                view.proposal.action.type === "keep" ? "Kept" : "Done",
              )
            }
          />
        </View>
      );
    }
  }
};

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
          void decide(
            message.pageId,
            { type: "accept", proposalId: offer.proposalId, revision: offer.revision },
            offer.action.type === "keep" ? "Kept" : "Done",
          );
        }
      }}
      className="gap-1.5 px-4 py-2.5"
      pressedClassName="active:bg-surface-2"
      onPress={() => navigation.navigate("Message", { pageId: message.pageId, initial: message })}
    >
      <Markdown
        text={preview.text}
        selectable={false}
        actions={{ onOpenChat: (sessionId) => navigation.navigate("Chat", { sessionId }) }}
      />
      <SuggestionLine message={message} />
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
  <View className="gap-1.5 px-4 py-2.5">
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
export const InboxPane = () => {
  const scope = useHomeState((state) => state.scope);
  const filter = useHomeState((state) => state.filter);
  const capturesSent = useHomeState((state) => state.capturesSent);
  const inbox = useInbox(scope, filter);
  const now = useNow();
  if (inbox.rows.length === 0) {
    if (inbox.loading) return <View className="flex-1" />;
    return filter === "inbox" ? (
      <EmptyState
        icon="inbox"
        title="Nothing waiting"
        detail="Drop a thought here. It lands on your desktop."
      />
    ) : (
      <EmptyState icon="history" title="Nothing handled yet" />
    );
  }
  return (
    <BottomAnchoredList
      key={`${inboxScopeKey(scope)}:${filter}`}
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
