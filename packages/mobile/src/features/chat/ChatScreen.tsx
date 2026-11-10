import type { ChatItem } from "@nodex/mobile-protocol";
import { memo, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "../../markdown/Markdown";
import type { ScreenProps } from "../../navigation/types";
import { useRootNavigation } from "../../navigation/types";
import {
  clearChatNotifications,
  decideInbox,
  dismissNotificationOffer,
  enableNotifications,
  useChat,
  useConnection,
  useNotifications,
  type LocalImage,
} from "../../runtime";
import { BarControl } from "../../ui/BarControl";
import { Icon, type IconName } from "../../ui/icons";
import { BottomAnchoredList } from "../../ui/BottomAnchoredList";
import { ComposerLayout } from "../../ui/ComposerLayout";
import { FloatingNote } from "../../ui/FloatingNote";
import { Glass } from "../../ui/glass";
import { Button, EmptyState, IconButton, Spinner, Tap, Txt } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { Composer } from "../composer/Composer";
import { ConnectionNotice, spaceUnreachable } from "../home/ConnectionNotice";
import { setArchived } from "./chat-archive";
import { ChatGallery, ImageStrip, UnavailablePictures, useOpenPicture } from "./ChatImages";
import { galleryImages } from "./chat-images";
import { RequestCard } from "./RequestCard";
import { stepTitle, transcriptRows, type TranscriptRow } from "./transcript-rows";

const CATEGORY_ICONS: Readonly<
  Record<Extract<ChatItem, { kind: "activity" }>["category"], IconName>
> = {
  command: "terminal",
  file: "file",
  search: "search",
  web: "globe",
  tool: "tool",
  agent: "agent",
  plan: "list",
  other: "tool",
};

/** A sent photo, and a step's picture in an opened run of work. */
const SENT_IMAGE = 160;
const STEP_THUMBNAIL = 48;
const STEP_ICON = 15;

const UserRow = memo(function UserRow({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "user" }>;
}) {
  return (
    <View className="items-end gap-1.5 pl-14 pr-4 pt-4">
      <ImageStrip className="justify-end" images={galleryImages(item.files)} size={SENT_IMAGE} />
      <UnavailablePictures pictures={item.unavailableImages} />
      {item.text ? (
        // A message reads as its desktop shows it: a Page or chat it mentions by its name.
        <View className="rounded-[22px] bg-surface-3 px-4 py-2.5">
          <Markdown text={item.text} />
        </View>
      ) : null}
      {item.queued ? <Txt className="text-xs text-ink-3">Queued</Txt> : null}
    </View>
  );
});

const AssistantRow = memo(function AssistantRow({
  item,
  sessionId,
}: {
  readonly item: Extract<ChatItem, { kind: "assistant" }>;
  readonly sessionId: string;
}) {
  const navigation = useRootNavigation();
  const openPicture = useOpenPicture();
  return (
    <View className="gap-1.5 px-4 pt-4">
      {item.truncated ? (
        <Tap onPress={() => navigation.navigate("ChatItem", { sessionId, itemId: item.id })}>
          <Txt className="text-sm text-accent">Show the start of this reply</Txt>
        </Tap>
      ) : null}
      <Markdown
        text={item.text}
        streaming={item.streaming}
        actions={{
          onOpenChat: (target) => navigation.push("Chat", { sessionId: target }),
          onOpenImage: ({ url, alt }) => openPicture({ ref: url, name: alt || "Picture" }),
        }}
      />
      <UnavailablePictures pictures={item.unavailableImages} />
    </View>
  );
});

const NoticeRow = ({ item }: { readonly item: Extract<ChatItem, { kind: "notice" }> }) => (
  <View className="flex-row gap-2 px-4 pt-4">
    {item.tone === "info" ? null : (
      <Icon name="warning" size={16} color={item.tone === "danger" ? "danger" : "warning"} />
    )}
    <Txt className="flex-1 text-sm text-ink-2">{item.text}</Txt>
  </View>
);

const WorkStep = ({
  item,
  sessionId,
}: {
  readonly item: Extract<ChatItem, { kind: "activity" | "thinking" }>;
  readonly sessionId: string;
}) => {
  const navigation = useRootNavigation();
  const thinking = item.kind === "thinking";
  const failed = item.kind === "activity" && item.status === "failed";
  return (
    <View className="py-1">
      <Tap
        className="flex-row items-start gap-2"
        onPress={() => navigation.navigate("ChatItem", { sessionId, itemId: item.id })}
      >
        <Icon
          name={failed ? "warning" : thinking ? "thought" : CATEGORY_ICONS[item.category]}
          size={STEP_ICON}
          color={failed ? "danger" : "ink-3"}
        />
        <Txt className="flex-1 text-sm text-ink-2" numberOfLines={thinking ? 3 : 2}>
          {stepTitle(item)}
        </Txt>
      </Tap>
      {/* Beside the step rather than inside it, so each picture is its own control. */}
      {thinking ? null : (
        <>
          <ImageStrip
            className="mt-1.5"
            images={galleryImages(item.images)}
            size={STEP_THUMBNAIL}
            style={{ marginLeft: STEP_ICON + 8 }}
          />
          <UnavailablePictures
            className="mt-1.5"
            pictures={item.unavailableImages}
            style={{ marginLeft: STEP_ICON + 8 }}
          />
        </>
      )}
    </View>
  );
};

const WorkRow = ({
  row,
  sessionId,
}: {
  readonly row: Extract<TranscriptRow, { type: "work" }>;
  readonly sessionId: string;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <View className="px-4 pt-4">
      <Tap
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-1.5"
        onPress={() => setOpen((value) => !value)}
      >
        {row.running ? <Spinner size="small" /> : <Icon name="check" size={15} color="ink-3" />}
        <Txt className="shrink text-sm text-ink-3" numberOfLines={1}>
          {row.title}
          {row.failedCount > 0 ? ` · ${row.failedCount} failed` : ""}
        </Txt>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color="ink-3" />
      </Tap>
      {open ? (
        <View className="mt-1 border-l-[0.5px] border-line pl-3">
          {row.items.map((item) => (
            <WorkStep key={item.id} item={item} sessionId={sessionId} />
          ))}
        </View>
      ) : null}
    </View>
  );
};

/**
 * The moment notifications matter is while something is running, so that is where they are offered,
 * once. Settings has them from then on.
 */
const NotificationOffer = () => {
  const { available, permission, offerDismissed } = useNotifications();
  if (!available || permission !== "undetermined" || offerDismissed) return null;
  return (
    <FloatingNote
      icon="bell"
      text="Hear when this needs you or finishes"
      action={
        <View className="flex-row items-center gap-3">
          <Tap hitSlop={8} onPress={() => void enableNotifications()}>
            <Txt className="text-sm font-medium">Turn on</Txt>
          </Tap>
          <Tap accessibilityLabel="Not now" hitSlop={8} onPress={dismissNotificationOffer}>
            <Icon name="close" size={15} color="ink-3" />
          </Tap>
        </View>
      }
    />
  );
};

const Row = ({ row, sessionId }: { readonly row: TranscriptRow; readonly sessionId: string }) => {
  switch (row.type) {
    case "user":
      return <UserRow item={row.item} />;
    case "assistant":
      return <AssistantRow item={row.item} sessionId={sessionId} />;
    case "notice":
      return <NoticeRow item={row.item} />;
    case "work":
      return <WorkRow row={row} sessionId={sessionId} />;
    case "working":
      return (
        <View className="flex-row items-center gap-1.5 px-4 pt-4">
          <Spinner size="small" />
          <Txt className="text-sm text-ink-3">Working</Txt>
        </View>
      );
  }
};

/** One chat, live: the transcript, whatever it is asking, and the Composer. */
export const ChatScreen = ({ route, navigation }: ScreenProps<"Chat">) => {
  const { sessionId } = route.params;
  const { chat, error, hasOlder, loadOlder, loadingOlder, respond, send, stop } =
    useChat(sessionId);
  // Without access to its Space, the chat is its last view: nothing moves and nothing acts.
  const live = !spaceUnreachable(useConnection().status);
  const safeArea = useSafeAreaInsets();
  const [sentCount, setSentCount] = useState(0);
  const title = chat?.title ?? route.params.title ?? "";
  const subtitle = [chat?.projectName, chat?.state.agentLabel].filter(Boolean).join(" · ");
  // Whoever may manage the chat archives it from here; an archived chat offers its restore below.
  const archivable = live && chat?.state.canManage === true && !chat.state.archived;

  useEffect(() => clearChatNotifications(sessionId), [sessionId]);

  useEffect(() => {
    navigation.setOptions({
      title,
      // Glass of its own, since the transcript passes right beneath it.
      headerTitle: () => (
        <Glass radius={22}>
          <View className="h-11 max-w-60 items-center justify-center px-4">
            <Txt className="text-sm leading-[19px] font-semibold" numberOfLines={1}>
              {title}
            </Txt>
            {subtitle ? (
              <Txt className="text-xs leading-[15px] text-ink-2" numberOfLines={1}>
                {subtitle}
              </Txt>
            ) : null}
          </View>
        </Glass>
      ),
      headerRight: archivable
        ? () => (
            <BarControl>
              <IconButton
                color="ink"
                label="Archive chat"
                name="archive"
                onPress={() => setArchived(sessionId, true)}
              />
            </BarControl>
          )
        : undefined,
    });
  }, [archivable, navigation, sessionId, subtitle, title]);

  const rows = useMemo(
    () => (chat ? transcriptRows(chat.items, chat.state, live) : []),
    [chat, live],
  );

  if (!chat) {
    return (
      <View className="flex-1 justify-center bg-surface">
        {error ? (
          <EmptyState icon="warning" title="This chat can't be read" detail={error} />
        ) : (
          <Spinner />
        )}
      </View>
    );
  }

  const deliver = (text: string, images: readonly LocalImage[], delivery: "queue" | "steer") => {
    setSentCount((count) => count + 1);
    return send(text, [...images], delivery).then(
      () => true,
      (cause: unknown) => {
        showFailure("Your message wasn't sent", cause);
        return false;
      },
    );
  };

  const activeRunId = chat.state.activeRunId;
  const blocked = chat.state.sendBlockedReason;
  // A chat whose Inbox decision could not start it offers that decision again, when Core would.
  const retry = chat.state.start?.retry ?? null;
  const retryStart = () => {
    if (!retry) return;
    decideInbox(retry.entryId, { type: "retry", proposalId: retry.proposalId }).catch(
      (cause: unknown) => showFailure("The chat couldn’t start", cause),
    );
  };
  const blockedAction = retry ? (
    <Button compact label="Retry" onPress={retryStart} />
  ) : chat.state.archived && chat.state.canManage ? (
    <Button compact label="Restore" onPress={() => setArchived(sessionId, false)} />
  ) : undefined;
  // Only the Run's requester, the chat's owner and the Space Owners stop its work.
  const stoppable = activeRunId !== null && chat.state.stopBlockedReason === null;

  return (
    <ComposerLayout
      foot={
        !live ? (
          <View style={{ paddingBottom: Math.max(safeArea.bottom, 8) }}>
            <ConnectionNotice />
          </View>
        ) : (
          <>
            <ConnectionNotice />
            {chat.state.requests.map((request) => (
              <RequestCard key={request.requestId} request={request} respond={respond} />
            ))}
            {chat.state.status === "waiting" && chat.state.requests.length === 0 ? (
              <FloatingNote icon="laptop" iconColor="warning" text="Waiting for an answer." />
            ) : null}
            {chat.state.status === "running" ? <NotificationOffer /> : null}
            {chat.state.queuedCount > 0 ? (
              <FloatingNote
                icon="clock"
                text={
                  chat.state.queuedCount === 1
                    ? "1 message waiting behind this Run"
                    : `${chat.state.queuedCount} messages waiting behind this Run`
                }
              />
            ) : null}
            {blocked ? (
              <View style={{ paddingBottom: Math.max(safeArea.bottom, 8) }}>
                <FloatingNote
                  icon={chat.state.start?.state === "failed" ? "warning" : "laptop"}
                  text={blocked}
                  action={blockedAction}
                />
              </View>
            ) : (
              <Composer
                draftKey={`chat:${sessionId}`}
                placeholder={activeRunId ? "Add to the queue" : "Reply"}
                onSend={(text, images) => deliver(text, images, "queue")}
                {...(activeRunId
                  ? {
                      onSendLongPress: (text: string, images: readonly LocalImage[]) =>
                        deliver(text, images, "steer"),
                    }
                  : {})}
                {...(stoppable
                  ? {
                      onStop: () => {
                        stop().catch((cause: unknown) =>
                          showFailure("Could not stop the Run", cause),
                        );
                      },
                    }
                  : activeRunId
                    ? { stopUnavailableReason: chat.state.stopBlockedReason }
                    : {})}
              />
            )}
          </>
        )
      }
    >
      {(insets) => (
        <ChatGallery items={chat.items}>
          <BottomAnchoredList
            insets={insets}
            sentCount={sentCount}
            data={rows}
            getItemType={(row) => row.type}
            keyExtractor={(row) => row.id}
            ListHeaderComponent={
              loadingOlder ? (
                <View className="py-3">
                  <Spinner />
                </View>
              ) : undefined
            }
            onStartReached={hasOlder ? loadOlder : undefined}
            renderItem={({ item }) => <Row row={item} sessionId={sessionId} />}
          />
        </ChatGallery>
      )}
    </ComposerLayout>
  );
};
