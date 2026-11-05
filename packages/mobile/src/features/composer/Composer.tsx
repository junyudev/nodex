import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState, type ReactNode } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { LocalImage } from "../../runtime";
import { cn } from "../../ui/cn";
import { Icon } from "../../ui/icons";
import { Field, IconButton, Tap, lightTap } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { useDraft, useHomeState } from "../home/home-state";

const assetToImage = (asset: ImagePicker.ImagePickerAsset, index: number): LocalImage => ({
  uri: asset.uri,
  name: asset.fileName ?? `photo-${Date.now()}-${index}.jpg`,
  mimeType: asset.mimeType ?? "image/jpeg",
  width: asset.width,
  height: asset.height,
});

const pickFromLibrary = async (): Promise<readonly LocalImage[]> => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: 6,
    quality: 1,
  });
  return result.canceled ? [] : result.assets.map(assetToImage);
};

const takePhoto = async (): Promise<readonly LocalImage[]> => {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert(
      "Camera access is off",
      "Allow Nodex to use the camera in Settings to take a photo.",
    );
    return [];
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  return result.canceled ? [] : result.assets.map(assetToImage);
};

/**
 * The bottom Composer of every surface: text first, one row of controls beneath it. Its bottom inset
 * gives way to the keyboard so the two never leave a gap.
 */
export const Composer = ({
  draftKey,
  placeholder,
  chips,
  canSend = true,
  sending = false,
  onSend,
  onSendLongPress,
  onStop,
  sendLabel = "Send",
  autoFocus,
}: {
  readonly draftKey: string;
  readonly placeholder: string;
  /** Pickers beside the attach control; they say where this goes. */
  readonly chips?: ReactNode;
  /** Whether the Host can take this now, apart from there being something to send. */
  readonly canSend?: boolean;
  readonly sending?: boolean;
  /** Resolves false when nothing was accepted, which puts the draft back. */
  readonly onSend: (text: string, images: readonly LocalImage[]) => void | Promise<boolean>;
  /** A second way to send, such as redirecting a Run instead of queuing behind it. */
  readonly onSendLongPress?: (
    text: string,
    images: readonly LocalImage[],
  ) => void | Promise<boolean>;
  /** When present and the Composer is empty, the primary control stops the Run. */
  readonly onStop?: () => void;
  readonly sendLabel?: string;
  readonly autoFocus?: boolean;
}) => {
  const draft = useDraft(draftKey);
  const setDraft = useHomeState((state) => state.setDraft);
  const clearDraft = useHomeState((state) => state.clearDraft);
  const [attaching, setAttaching] = useState(false);
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const restingInset = Math.max(insets.bottom, 8);
  const inset = useAnimatedStyle(() => ({
    paddingBottom: interpolate(progress.value, [0, 1], [restingInset, 8]),
  }));

  const hasContent = draft.text.trim().length > 0 || draft.images.length > 0;
  const stopping = onStop !== undefined && !hasContent;
  const ready = stopping || (hasContent && canSend && !sending);

  const addImages = async (pick: () => Promise<readonly LocalImage[]>) => {
    setAttaching(false);
    const images = await pick();
    if (images.length > 0) setDraft(draftKey, { images: [...draft.images, ...images] });
  };

  // The Composer empties at once, so sending feels immediate; a failed send restores the words,
  // unless the person has already started something new.
  const submit = (
    send: (text: string, images: readonly LocalImage[]) => void | Promise<boolean>,
  ) => {
    lightTap();
    const sent = draft;
    clearDraft(draftKey);
    // Starting inside the promise makes a send that throws, such as a full disk, a refusal too.
    void new Promise<void | boolean>((resolve) => resolve(send(sent.text.trim(), sent.images)))
      .catch((cause: unknown) => {
        showFailure("That wasn't saved", cause);
        return false;
      })
      .then((accepted) => {
        if (accepted !== false) return;
        const current = useHomeState.getState().drafts[draftKey];
        if (!current?.text && !current?.images.length) setDraft(draftKey, sent);
      });
  };

  return (
    <Animated.View style={inset} className="px-2.5 pt-1.5">
      <View className="rounded-[22px] border-[0.5px] border-line bg-surface-2 p-1.5">
        {draft.images.length > 0 ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1.5 px-1 pb-1.5 pt-1"
          >
            {draft.images.map((image) => (
              <View key={image.uri}>
                <Image
                  source={{ uri: image.uri }}
                  accessibilityLabel={image.name}
                  contentFit="cover"
                  transition={0}
                  style={{ width: 64, height: 64, borderRadius: 12 }}
                />
                <Tap
                  accessibilityLabel={`Remove ${image.name}`}
                  hitSlop={8}
                  className="absolute right-1 top-1 h-5 w-5 items-center justify-center rounded-full bg-ink"
                  onPress={() =>
                    setDraft(draftKey, {
                      images: draft.images.filter((candidate) => candidate.uri !== image.uri),
                    })
                  }
                >
                  <Icon name="close" size={12} color="surface" />
                </Tap>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <Field
          accessibilityLabel={placeholder}
          autoFocus={autoFocus}
          className="max-h-36 px-2.5 pb-1.5 pt-1.5 text-base text-ink"
          multiline
          onChangeText={(text) => setDraft(draftKey, { text })}
          textAlignVertical="top"
          value={draft.text}
        />
        <View className="flex-row items-center gap-1">
          <IconButton
            label={attaching ? "Close attachments" : "Attach"}
            name={attaching ? "close" : "plus"}
            onPress={() => setAttaching(!attaching)}
          />
          {attaching ? (
            <>
              <IconButton
                label="Choose photos"
                name="photo"
                onPress={() => void addImages(pickFromLibrary)}
              />
              <IconButton
                label="Take a photo"
                name="camera"
                onPress={() => void addImages(takePhoto)}
              />
            </>
          ) : null}
          <View className="flex-1 flex-row items-center gap-1 overflow-hidden">
            {attaching ? null : chips}
          </View>
          <Tap
            accessibilityLabel={stopping ? "Stop" : sendLabel}
            accessibilityState={{ disabled: !ready }}
            disabled={!ready}
            hitSlop={6}
            className={cn(
              "h-9 w-9 items-center justify-center rounded-full bg-ink",
              !ready && "opacity-30",
            )}
            onLongPress={
              onSendLongPress && hasContent && canSend ? () => submit(onSendLongPress) : undefined
            }
            onPress={() => {
              if (stopping) {
                lightTap();
                onStop?.();
                return;
              }
              submit(onSend);
            }}
          >
            <Icon name={stopping ? "stop" : "arrowUp"} size={stopping ? 18 : 20} color="surface" />
          </Tap>
        </View>
      </View>
    </Animated.View>
  );
};
