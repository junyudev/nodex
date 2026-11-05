import type { ChatItem } from "@nodex/mobile-protocol";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import type { ScreenProps } from "../../navigation/types";
import { fetchChatItem } from "../../runtime";
import { Icon } from "../../ui/icons";
import { EmptyState, Mono, Txt } from "../../ui/primitives";

const ItemBody = ({ item }: { readonly item: ChatItem }) => {
  switch (item.kind) {
    case "activity":
      return (
        <View className="gap-3">
          <View className="flex-row items-center gap-1.5">
            {item.status === "failed" ? <Icon name="warning" size={16} color="danger" /> : null}
            <Txt selectable className="flex-1 font-medium">
              {item.title}
            </Txt>
          </View>
          {item.status === "failed" ? (
            <Txt className="text-sm text-danger">This step failed.</Txt>
          ) : null}
          {item.detail ? (
            <Mono selectable className="text-[13px] leading-[19px] text-ink-2">
              {item.detail}
            </Mono>
          ) : null}
          {item.output ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Mono selectable className="text-[13px] leading-[19px]">
                {item.output}
              </Mono>
            </ScrollView>
          ) : null}
        </View>
      );
    case "assistant":
    case "thinking":
      return <Markdown text={item.text} />;
    case "user":
    case "notice":
      return <Txt selectable>{item.text}</Txt>;
  }
};

/** One transcript item whole: a step's full output, or a reply too long to keep in the window. */
export const ChatItemScreen = ({ route }: ScreenProps<"ChatItem">) => {
  const { sessionId, itemId } = route.params;
  const [item, setItem] = useState<ChatItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchChatItem(sessionId, itemId)
      .then((fetched) => {
        if (current) setItem(fetched);
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : "It could not be read.");
      });
    return () => {
      current = false;
    };
  }, [itemId, sessionId]);

  if (error) return <EmptyState icon="warning" title="This can't be shown" detail={error} />;
  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="p-4"
      contentInsetAdjustmentBehavior="automatic"
    >
      {item ? <ItemBody item={item} /> : null}
    </ScrollView>
  );
};
