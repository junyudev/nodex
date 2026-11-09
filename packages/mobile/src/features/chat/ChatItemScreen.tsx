import type { ChatItem } from "@nodex/mobile-protocol";
import { useEffect, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import type { GalleryImage, ScreenProps } from "../../navigation/types";
import { fetchChatItem, useChat } from "../../runtime";
import { Icon } from "../../ui/icons";
import { EmptyState, Mono, Txt } from "../../ui/primitives";
import { ChatGallery, ImageStrip, UnavailablePictures, useOpenPicture } from "./ChatImages";
import { galleryImages, thumbnailSize, withItem } from "./chat-images";
import { isRunningStep } from "./transcript-rows";

/** The screen's padding, `p-4`, which the pictures fit inside. */
const CONTENT_INSET = 16;

/** The step's pictures, sized to the screen; they download as they are shown. */
const StepImages = ({ images }: { readonly images: readonly GalleryImage[] }) => {
  const { width } = useWindowDimensions();
  return (
    <ImageStrip images={images} size={thumbnailSize(width - CONTENT_INSET * 2, images.length)} />
  );
};

const ItemBody = ({ item }: { readonly item: ChatItem }) => {
  const openPicture = useOpenPicture();
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
          <StepImages images={galleryImages(item.images)} />
          <UnavailablePictures pictures={item.unavailableImages} />
          {item.output ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Mono selectable className="text-[13px] leading-[19px]">
                {item.outputTruncated ? `…\n${item.output}` : item.output}
              </Mono>
            </ScrollView>
          ) : null}
        </View>
      );
    case "assistant":
    case "thinking":
      return (
        <View className="gap-3">
          <Markdown
            text={item.text}
            actions={{
              onOpenImage: ({ url, alt }) => openPicture({ ref: url, name: alt || "Picture" }),
            }}
          />
          {item.kind === "assistant" ? (
            <UnavailablePictures pictures={item.unavailableImages} />
          ) : null}
        </View>
      );
    case "user":
      return <Markdown text={item.text} />;
    case "notice":
      return <Txt selectable>{item.text}</Txt>;
  }
};

/** How often a running step's output is read again while it is shown, as on the desktop. */
const LIVE_OUTPUT_REFRESH_MS = 2_000;

/**
 * One transcript item whole: a step's full output, or a reply too long to keep in the window. A step
 * still running follows its output until it ends.
 */
export const ChatItemScreen = ({ route }: ScreenProps<"ChatItem">) => {
  const { sessionId, itemId } = route.params;
  const [item, setItem] = useState<ChatItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Its pictures open among the chat's, with this item read whole in its place.
  const { chat } = useChat(sessionId);
  const transcript = chat?.items ?? [];

  useEffect(() => {
    let current = true;
    let shown = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      next = setTimeout(read, LIVE_OUTPUT_REFRESH_MS);
    };
    const read = () => {
      fetchChatItem(sessionId, itemId)
        .then((fetched) => {
          if (!current) return;
          shown = true;
          setItem(fetched);
          if (isRunningStep(fetched)) follow();
        })
        .catch((cause: unknown) => {
          if (!current) return;
          // Output already shown stays while a later read fails, and the next one tries again.
          if (shown) follow();
          else setError(cause instanceof Error ? cause.message : "It could not be read.");
        });
    };
    read();
    return () => {
      current = false;
      clearTimeout(next);
    };
  }, [itemId, sessionId]);

  if (error) return <EmptyState icon="warning" title="This can't be shown" detail={error} />;
  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="p-4 pb-10"
      contentInsetAdjustmentBehavior="automatic"
    >
      {item ? (
        <ChatGallery items={withItem(transcript, item)}>
          <ItemBody item={item} />
        </ChatGallery>
      ) : null}
    </ScrollView>
  );
};
