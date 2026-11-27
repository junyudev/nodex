import type { ChatItem, UnavailablePicture } from "@nodex/mobile-protocol";
import { Image } from "expo-image";
import { createContext, use, useCallback, useEffect, useRef, type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";

import { type GalleryImage, useRootNavigation } from "../../navigation/types";
import { usePictureUri, type ChatOutboxEntry } from "../../runtime";
import { cn } from "../../ui/cn";
import { Icon } from "../../ui/icons";
import { Tap, Txt } from "../../ui/primitives";
import { THUMBNAIL_GAP, chatGallery, galleryAt, localGalleryImages } from "./chat-images";

/** Opens the full-screen viewer at a picture, among every picture of the chat. */
const ChatGalleryContext = createContext<((image: GalleryImage) => void) | null>(null);

/**
 * A chat's pictures as one gallery: a tap on any of them, in a message, a reply or a step, opens
 * the viewer there and swipes through the rest. The gallery is read when a picture is opened, so
 * a reply streaming in does not redraw every picture.
 */
export const ChatGallery = ({
  items,
  outbox,
  children,
}: {
  readonly items: readonly ChatItem[];
  readonly outbox?: readonly ChatOutboxEntry[];
  readonly children: ReactNode;
}) => {
  const navigation = useRootNavigation();
  const latest = useRef({ items, outbox });
  useEffect(() => {
    latest.current = { items, outbox };
  }, [items, outbox]);
  const open = useCallback(
    (image: GalleryImage) => {
      const { items: current, outbox: pending } = latest.current;
      const local = pending?.flatMap((entry) => localGalleryImages(entry.images));
      navigation.navigate("Images", galleryAt(chatGallery(current, local), image));
    },
    [navigation],
  );
  return <ChatGalleryContext value={open}>{children}</ChatGalleryContext>;
};

/** Opens a picture in a supplied sequence, its chat's gallery or among the pictures beside it. */
export const useOpenPicture = (sequence?: readonly GalleryImage[]) => {
  const navigation = useRootNavigation();
  const inChat = use(ChatGalleryContext);
  return (image: GalleryImage, beside: readonly GalleryImage[] = [image]) =>
    inChat && sequence === undefined
      ? inChat(image)
      : navigation.navigate("Images", galleryAt(sequence ?? beside, image));
};

/** One picture as a square, downloaded once it is shown. */
const Thumbnail = ({
  image,
  size,
  onPress,
}: {
  readonly image: GalleryImage;
  readonly size: number;
  readonly onPress: () => void;
}) => {
  const { uri, error } = usePictureUri(image.ref);
  const radius = Math.max(8, Math.round(size / 8));
  return (
    <Tap
      accessibilityLabel={image.name}
      accessibilityRole="imagebutton"
      className="items-center justify-center overflow-hidden bg-surface-3"
      hitSlop={THUMBNAIL_GAP / 2}
      onPress={onPress}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      {uri ? (
        <Image
          contentFit="cover"
          source={{ uri }}
          style={{ width: size, height: size }}
          transition={0}
        />
      ) : error ? (
        <Icon name="warning" size={Math.min(20, size / 3)} color="ink-3" />
      ) : null}
    </Tap>
  );
};

/** A strip of pictures, each opening the viewer at itself. */
export const ImageStrip = ({
  images,
  size,
  className,
  style,
  sequence,
}: {
  readonly images: readonly GalleryImage[];
  readonly size: number;
  readonly className?: string;
  readonly style?: ViewStyle;
  readonly sequence?: readonly GalleryImage[];
}) => {
  const open = useOpenPicture(sequence);
  if (images.length === 0) return null;
  return (
    <View className={cn("flex-row flex-wrap", className)} style={[{ gap: THUMBNAIL_GAP }, style]}>
      {images.map((image) => (
        <Thumbnail key={image.ref} image={image} size={size} onPress={() => open(image, images)} />
      ))}
    </View>
  );
};

/** Pictures the transcript names that its host cannot read, each in its place with the reason. */
export const UnavailablePictures = ({
  pictures,
  className,
  style,
}: {
  readonly pictures: readonly UnavailablePicture[];
  readonly className?: string;
  readonly style?: ViewStyle;
}) =>
  pictures.length === 0 ? null : (
    <View className={cn("gap-1", className)} style={style}>
      {pictures.map((picture, index) => (
        <View key={`${index}:${picture.name}`} className="flex-row items-start gap-1.5">
          <Icon name="photo" size={14} color="ink-3" />
          <Txt className="shrink text-xs text-ink-3">
            {picture.name} · {picture.reason}
          </Txt>
        </View>
      ))}
    </View>
  );
