import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState, type ReactNode } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { LocalImage } from "../../runtime";
import { cn } from "../../ui/cn";
import { Glass } from "../../ui/glass";
import { Icon } from "../../ui/icons";
import { Chip, Field, IconButton, Tap, lightTap } from "../../ui/primitives";
import { showFailure, showSnack } from "../../ui/snackbar";
import { primaryControl } from "./primary-control";
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
 * The floating Composer of every surface. At rest it is one line of glass. While in use it opens to
 * text above a row of controls, which is also where `chips` say where this goes. Its bottom inset
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
  stopUnavailableReason = null,
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
  /**
   * Why the reader may not stop the Run, without `onStop`: the empty Composer still shows Stop,
   * unavailable, and tapping it says why.
   */
  readonly stopUnavailableReason?: string | null;
  readonly sendLabel?: string;
  readonly autoFocus?: boolean;
}) => {
  const draft = useDraft(draftKey);
  const setDraft = useHomeState((state) => state.setDraft);
  const clearDraft = useHomeState((state) => state.clearDraft);
  const [attaching, setAttaching] = useState(false);
  const [focused, setFocused] = useState(false);
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const restingInset = Math.max(insets.bottom, 8);
  const inset = useAnimatedStyle(() => ({
    paddingBottom: interpolate(progress.value, [0, 1], [restingInset, 8]),
  }));

  const hasContent = draft.text.trim().length > 0 || draft.images.length > 0;
  const control = primaryControl({
    hasContent,
    canSend,
    sending,
    canStop: onStop !== undefined,
    stopUnavailableReason,
  });
  const { ready } = control;
  const stopping = control.kind === "stop";
  const stopReason = control.kind === "stop" ? control.unavailableReason : null;
  const open = attaching || (chips !== undefined && (focused || hasContent));

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

  const attachControl = (
    <IconButton
      className="h-10 w-10"
      color="ink"
      label={attaching ? "Close attachments" : "Attach"}
      name={attaching ? "close" : "plus"}
      size={22}
      onPress={() => setAttaching(!attaching)}
    />
  );

  const sendControl = (
    <Tap
      accessibilityLabel={stopping ? "Stop" : sendLabel}
      accessibilityState={{ disabled: !ready }}
      {...(stopReason !== null ? { accessibilityHint: stopReason } : {})}
      // An unavailable Stop still answers a tap with why.
      disabled={!ready && stopReason === null}
      hitSlop={6}
      className={cn(
        "h-10 w-10 items-center justify-center rounded-full",
        !ready ? "bg-fill" : stopping ? "bg-ink" : "bg-accent",
      )}
      onLongPress={
        onSendLongPress && hasContent && canSend ? () => submit(onSendLongPress) : undefined
      }
      onPress={() => {
        if (stopping) {
          lightTap();
          if (stopReason !== null) showSnack({ text: stopReason });
          else onStop?.();
          return;
        }
        submit(onSend);
      }}
    >
      <Icon
        name={stopping ? "stop" : "arrowUp"}
        size={stopping ? 18 : 20}
        color={!ready ? "ink-3" : stopping ? "surface" : "on-accent"}
      />
    </Tap>
  );

  return (
    <Animated.View style={inset} className="px-4" pointerEvents="box-none">
      <Glass radius={25}>
        {draft.images.length > 0 ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1.5 px-2.5 pt-2.5"
          >
            {draft.images.map((image) => (
              <View key={image.uri}>
                <Image
                  source={{ uri: image.uri }}
                  accessibilityLabel={image.name}
                  contentFit="cover"
                  transition={0}
                  style={{ width: 64, height: 64, borderRadius: 14 }}
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
        {/* The field keeps its place in the tree as the controls move, so it never loses focus. */}
        <View className="flex-row items-end p-[5px]">
          {open ? null : attachControl}
          <Field
            accessibilityLabel={placeholder}
            autoFocus={autoFocus}
            className={cn(
              "max-h-36 min-h-10 flex-1 py-[9.75px] text-base text-ink",
              open ? "px-2.5" : "px-1",
            )}
            multiline
            onBlur={() => setFocused(false)}
            onChangeText={(text) => setDraft(draftKey, { text })}
            onFocus={() => setFocused(true)}
            textAlignVertical="top"
            value={draft.text}
          />
          {open ? null : sendControl}
        </View>
        {open ? (
          <View className="flex-row items-center gap-1 px-[5px] pb-[5px]">
            {attachControl}
            <View className="flex-1 flex-row items-center gap-1 overflow-hidden">
              {attaching ? (
                <>
                  <Chip
                    icon="photo"
                    label="Photos"
                    onPress={() => void addImages(pickFromLibrary)}
                  />
                  <Chip icon="camera" label="Camera" onPress={() => void addImages(takePhoto)} />
                </>
              ) : (
                chips
              )}
            </View>
            {sendControl}
          </View>
        ) : null}
      </Glass>
    </Animated.View>
  );
};
