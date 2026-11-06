import type { ChatSummary } from "@nodex/mobile-protocol";
import { useMemo } from "react";
import { LegendList } from "@legendapp/list/react-native";
import { RefreshControl, View } from "react-native";

import { useRootNavigation } from "../../navigation/types";
import { useChats } from "../../runtime";
import { cn } from "../../ui/cn";
import { insetPadding, type ContentInsets } from "../../ui/ComposerLayout";
import { formatAge } from "../../ui/format";
import { EmptyState, SectionLabel, StatusDot, Tap, Txt } from "../../ui/primitives";
import { useColor } from "../../ui/tokens";
import { useNow } from "../../ui/use-now";
import { chatListRows, chatStatusTone, type ChatListRow } from "./chat-sections";

const STATUS_WORDS: Partial<Record<ChatSummary["status"], string>> = {
  running: "Working",
  background: "Working in the background",
  failed: "Run failed",
};

const ChatRow = ({ chat, now }: { readonly chat: ChatSummary; readonly now: number }) => {
  const navigation = useRootNavigation();
  const asking = chat.status === "waiting" || chat.pendingRequestCount > 0;
  const tone = asking ? "warning" : chatStatusTone(chat.status);
  const line = asking
    ? (chat.attention ?? "Waiting for you")
    : (STATUS_WORDS[chat.status] ?? chat.preview);
  return (
    <Tap
      className="flex-row gap-2.5 px-4 py-3"
      pressedClassName="active:bg-surface-2"
      onPress={() => navigation.navigate("Chat", { sessionId: chat.sessionId, title: chat.title })}
    >
      <View className="h-[23px] w-2 items-center justify-center">
        {tone ? <StatusDot tone={tone} /> : chat.unread ? <StatusDot tone="accent" /> : null}
      </View>
      <View className="flex-1">
        <View className="flex-row items-baseline gap-2">
          <Txt className={cn("flex-1", chat.unread && "font-semibold")} numberOfLines={1}>
            {chat.title}
          </Txt>
          {chat.activityAt ? (
            <Txt className="text-xs text-ink-3">{formatAge(chat.activityAt, now)}</Txt>
          ) : null}
        </View>
        <Txt className={cn("text-sm", asking ? "text-warning" : "text-ink-3")} numberOfLines={2}>
          {chat.projectName && !asking ? `${chat.projectName} · ${line}` : line}
        </Txt>
      </View>
    </Tap>
  );
};

const rowKey = (row: ChatListRow): string =>
  row.type === "header" ? `header:${row.id}` : row.chat.sessionId;

/** Every chat on the desktop, with what needs the person first. */
export const ChatsPane = ({
  query,
  insets,
}: {
  readonly query: string;
  readonly insets: ContentInsets;
}) => {
  const chats = useChats(query ? { query } : {});
  const rows = useMemo(() => chatListRows(chats.items), [chats.items]);
  const refreshColor = useColor("ink-3");
  const now = useNow();
  if (rows.length === 0) {
    if (chats.loading) return <View className="flex-1" />;
    return (
      <View className="flex-1" style={insetPadding(insets)}>
        {query ? (
          <EmptyState icon="search" title="No chats match" />
        ) : (
          <EmptyState
            icon="chat"
            title="No chats yet"
            detail="Start one below. It runs on your desktop while you follow along here."
          />
        )}
      </View>
    );
  }
  return (
    <LegendList
      contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: insets.bottom + 8 }}
      contentInsetAdjustmentBehavior="never"
      data={rows}
      estimatedItemSize={64}
      getItemType={(row) => row.type}
      keyExtractor={rowKey}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      onEndReached={chats.hasMore ? chats.loadMore : undefined}
      onEndReachedThreshold={0.5}
      recycleItems
      refreshControl={
        <RefreshControl
          progressViewOffset={insets.top}
          refreshing={false}
          onRefresh={chats.refresh}
          tintColor={refreshColor}
        />
      }
      scrollIndicatorInsets={{ top: insets.top, bottom: insets.bottom }}
      renderItem={({ item }) =>
        item.type === "header" ? (
          <SectionLabel className="px-4 pb-0.5 pt-3">{item.label}</SectionLabel>
        ) : (
          <ChatRow chat={item.chat} now={now} />
        )
      }
    />
  );
};
