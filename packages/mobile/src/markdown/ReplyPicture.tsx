import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";

import { usePictureUri } from "../runtime";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icons";
import { Tap } from "../ui/primitives";
import {
  REPLY_PICTURE_MAX_HEIGHT,
  replyPictureBox,
  replyPictureShape,
  type PictureSize,
} from "./reply-picture";

/** A picture shown before keeps its shape when its reply is drawn again, so nothing moves. */
const knownSizes = new Map<string, PictureSize>();
const KNOWN_SIZES_LIMIT = 200;
const remember = (url: string, size: PictureSize) => {
  knownSizes.delete(url);
  knownSizes.set(url, size);
  const oldest = knownSizes.keys().next();
  if (knownSizes.size > KNOWN_SIZES_LIMIT && !oldest.done) knownSizes.delete(oldest.value);
};

/**
 * A picture on a line of its own in a message, across the column at its own shape and no taller
 * than the cap. Its place is held at a photo's shape until it loads; a tap opens it among the
 * chat's pictures.
 */
export const ReplyPicture = ({
  url,
  alt,
  onOpen,
}: {
  readonly url: string;
  readonly alt: string;
  readonly onOpen: (() => void) | undefined;
}) => {
  const { uri, error } = usePictureUri(url);
  const [size, setSize] = useState(() => knownSizes.get(url) ?? null);
  const [column, setColumn] = useState(0);
  const loaded = size !== null;
  // Until the column is measured the box takes the height the same rule gives across it.
  const box =
    column > 0
      ? replyPictureBox(column, size)
      : {
          width: "100%" as const,
          aspectRatio: replyPictureShape(size),
          maxHeight: REPLY_PICTURE_MAX_HEIGHT,
        };
  return (
    <View onLayout={({ nativeEvent }) => setColumn(nativeEvent.layout.width)}>
      <Tap
        accessibilityLabel={alt || "Picture"}
        accessibilityRole="imagebutton"
        className={cn(
          "items-center justify-center overflow-hidden rounded-2xl",
          !loaded && "bg-surface-3",
        )}
        disabled={!onOpen}
        onPress={onOpen}
        style={box}
      >
        {uri ? (
          <Image
            contentFit="contain"
            onLoad={({ source }) => {
              const picture = { width: source.width, height: source.height };
              remember(url, picture);
              setSize(picture);
            }}
            source={{ uri }}
            style={{ width: "100%", height: "100%" }}
            transition={0}
          />
        ) : error ? (
          <Icon name="warning" size={20} color="ink-3" />
        ) : null}
      </Tap>
    </View>
  );
};
