import { useEffect, useState } from "react";
import { FlatList, View } from "react-native";

import type { GalleryImage, ScreenProps } from "../../navigation/types";
import { usePictureUri } from "../../runtime";
import { EmptyState, Spinner } from "../../ui/primitives";
import { ZoomableImage } from "./ZoomableImage";
import { viewerPosition } from "./chat-images";
import type { Size } from "./zoom";

const Page = ({
  image,
  size,
  active,
  onZoomChange,
}: {
  readonly image: GalleryImage;
  readonly size: Size;
  readonly active: boolean;
  readonly onZoomChange: (zoomed: boolean) => void;
}) => {
  const { uri, error } = usePictureUri(image.ref);
  if (uri)
    return (
      <ZoomableImage
        active={active}
        frame={size}
        label={image.name}
        onZoomChange={onZoomChange}
        uri={uri}
      />
    );
  return (
    <View className="items-center justify-center" style={size}>
      {error ? (
        <EmptyState icon="warning" title="This picture can't be shown" detail={error} />
      ) : (
        <Spinner />
      )}
    </View>
  );
};

/**
 * A message's or step's pictures, full screen. A swipe moves between them; a pinch or double tap
 * zooms one, which then pans instead.
 */
export const ImageViewerScreen = ({ route, navigation }: ScreenProps<"Images">) => {
  const { images } = route.params;
  const [initial] = useState(() => viewerPosition(route.params.index, images.length).index);
  const [index, setIndex] = useState(initial);
  const [zoomed, setZoomed] = useState(false);
  const [size, setSize] = useState<Size | null>(null);
  const { title } = viewerPosition(index, images.length);

  useEffect(() => navigation.setOptions({ title }), [navigation, title]);

  return (
    <View
      className="flex-1 bg-surface"
      onLayout={({ nativeEvent: { layout } }) =>
        setSize({ width: layout.width, height: layout.height })
      }
    >
      {size ? (
        <FlatList
          data={images}
          getItemLayout={(_, at) => ({ length: size.width, offset: size.width * at, index: at })}
          horizontal
          initialScrollIndex={initial}
          keyExtractor={(image) => image.ref}
          onMomentumScrollEnd={({ nativeEvent }) =>
            setIndex(viewerPosition(nativeEvent.contentOffset.x / size.width, images.length).index)
          }
          pagingEnabled
          renderItem={({ item, index: at }) => (
            <Page active={at === index} image={item} onZoomChange={setZoomed} size={size} />
          )}
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
        />
      ) : null}
    </View>
  );
};
