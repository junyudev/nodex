import type { ChatItem, UnavailablePicture } from "@nodex/mobile-protocol";
import { Image } from "expo-image";
import { createContext, use, useCallback, useEffect, useRef, type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";

import { type GalleryImage, useRootNavigation } from "../../navigation/types";
import { usePictureUri } from "../../runtime";
import { cn } from "../../ui/cn";
import { Icon } from "../../ui/icons";
import { Tap, Txt } from "../../ui/primitives";
import { THUMBNAIL_GAP, chatGallery, galleryAt } from "./chat-images";

/** Opens the full-screen viewer at a picture, among every picture of the chat. */
const ChatGalleryContext = createContext<((image: GalleryImage) => void) | null>(null);

/**
 * A chat's pictures as one gallery: a tap on any of them, in a message, a reply or a step, opens
 * the viewer there and swipes through the rest. The gallery is read when a picture is opened, so
 * a reply streaming in does not redraw every picture.
 */
export const ChatGallery = ({
  items,
  children,
}: {
  readonly items: readonly ChatItem[];
  readonly children: ReactNode;
}) => {
  const navigation = useRootNavigation();
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  }, [items]);
  const open = useCallback(
    (image: GalleryImage) =>
      navigation.navigate("Images", galleryAt(chatGallery(latest.current), image)),
    [navigation],
  );
  return <ChatGalleryContext value={open}>{children}</ChatGalleryContext>;
};

/** Opens a picture in its chat's gallery, or outside a chat among the pictures beside it. */
export const useOpenPicture = () => {
  const navigation = useRootNavigation();
  const inChat = use(ChatGalleryContext);
  return (image: GalleryImage, beside: readonly GalleryImage[] = [image]) =>
    inChat ? inChat(image) : navigation.navigate("Images", galleryAt(beside, image));
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

/** A message's or step's pictures; each opens the viewer at itself. */
export const ImageStrip = ({
  images,
  size,
  className,
  style,
}: {
  readonly images: readonly GalleryImage[];
  readonly size: number;
  readonly className?: string;
  readonly style?: ViewStyle;
}) => {
  const open = useOpenPicture();
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
