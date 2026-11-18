import type { ChatItem } from "@nodex/mobile-protocol";
import { memo } from "react";
import { View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import type { ChatOutboxEntry } from "../../runtime";
import { Icon } from "../../ui/icons";
import { Tap, Txt } from "../../ui/primitives";
import { ImageStrip, UnavailablePictures } from "./ChatImages";
import { galleryImages, localGalleryImages } from "./chat-images";

const SENT_IMAGE = 160;

export type RetryActions = {
  readonly canRetry: boolean;
  readonly retrySend: (messageId: string) => void;
  readonly deleteSend: (messageId: string) => void;
};

const OutboxStatus = ({
  entry,
  canRetry,
  retrySend,
  deleteSend,
}: RetryActions & {
  readonly entry: ChatOutboxEntry;
}) => {
  const { status, messageId } = entry;
  if (status.kind === "sending")
    return (
      <Txt className="text-xs text-ink-3" accessibilityLiveRegion="polite">
        Sending…
      </Txt>
    );
  if (status.kind !== "failed") return null;
  return (
    <View className="max-w-full flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <View className="shrink flex-row items-center gap-1">
        <Icon name="warning" size={12} color="warning" />
        <Txt className="shrink text-right text-xs text-warning" accessibilityLiveRegion="polite">
          {status.unknown ? "Couldn't confirm it was sent" : "Not sent"} · {status.reason}
        </Txt>
      </View>
      <Tap
        accessibilityLabel="Retry message"
        accessibilityState={{ disabled: !canRetry }}
        disabled={!canRetry}
        hitSlop={4}
        onPress={() => retrySend(messageId)}
      >
        <Txt className={canRetry ? "text-xs text-accent" : "text-xs text-ink-3"}>Retry</Txt>
      </Tap>
      <Tap
        accessibilityLabel="Delete unsent message"
        hitSlop={4}
        onPress={() => deleteSend(messageId)}
      >
        <Txt className="text-xs text-ink-2">Delete</Txt>
      </Tap>
    </View>
  );
};

export const UserRow = memo(function UserRow({
  content,
  ...actions
}: RetryActions & {
  readonly content: Extract<ChatItem, { kind: "user" }> | ChatOutboxEntry;
}) {
  const images =
    "kind" in content ? galleryImages(content.files) : localGalleryImages(content.images);
  return (
    <View className="items-end gap-1.5 pl-14 pr-4 pt-4">
      <ImageStrip className="justify-end" images={images} size={SENT_IMAGE} />
      {"kind" in content ? <UnavailablePictures pictures={content.unavailableImages} /> : null}
      {content.text ? (
        // A message reads as its desktop shows it: a Page or chat it mentions by its name.
        <View className="rounded-[22px] bg-surface-3 px-4 py-2.5">
          <Markdown text={content.text} />
        </View>
      ) : null}
      {"kind" in content ? (
        content.queued ? (
          <Txt className="text-xs text-ink-3">Queued</Txt>
        ) : null
      ) : (
        <OutboxStatus entry={content} {...actions} />
      )}
    </View>
  );
});
