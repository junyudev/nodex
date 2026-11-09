import { parseDeviceLinkUri } from "@nodex/mobile-protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { navigationRef, type ScreenProps } from "../../navigation/types";
import { pairWithUri, useHosts } from "../../runtime";
import { Icon, NodexMark } from "../../ui/icons";
import { Button, Spinner, Tap, Txt, lightTap } from "../../ui/primitives";
import { pairingFailureMessage, pairingFailureReason } from "./pairing-copy";

const STEPS = [
  "Open the Space’s settings on your computer.",
  "Turn on Remote access, then choose Link a device.",
  "Scan its code or paste the device link.",
];

/**
 * Linking a Space is the only thing this app needs before it is useful, so this is the whole
 * first run: the camera, the three steps that produce a code, and a way in without a camera.
 */
export const PairScreen = ({ route, navigation }: ScreenProps<"Pair" | "Welcome">) => {
  const insets = useSafeAreaInsets();
  const { hosts } = useHosts();
  const [permission, requestPermission] = useCameraPermissions();
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the code itself is fine, so trying the same one again can work.
  const [retryUri, setRetryUri] = useState<string | null>(null);
  // A scanner fires many times per second for one code; only the first attempt counts.
  const lastUri = useRef<string | null>(null);
  const promptedUri = useRef<string | null>(null);

  const pair = useCallback((uri: string) => {
    if (uri === lastUri.current) return;
    lastUri.current = uri;
    if (!parseDeviceLinkUri(uri)) {
      setError(pairingFailureMessage("invalid"));
      return;
    }
    lightTap();
    setError(null);
    setRetryUri(null);
    setPairing(true);
    pairWithUri(uri)
      .then(() => {
        // First run swaps this screen for Home by itself; from Settings it is a modal to close.
        // Linking another Space makes it current and remounts the stack under this screen, so
        // the sheet is closed through the container rather than this instance's navigation.
        if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name === "Pair")
          navigationRef.goBack();
      })
      .catch((cause: unknown) => {
        const reason = pairingFailureReason(cause);
        setError(pairingFailureMessage(reason));
        if (reason === "unreachable" || reason === "busy") setRetryUri(uri);
      })
      .finally(() => setPairing(false));
  }, []);

  const promptIncomingLink = useEffectEvent((uri: string) => {
    const offer = parseDeviceLinkUri(uri);
    if (!offer || promptedUri.current === uri) return;
    promptedUri.current = uri;
    // Enrollment switches the active Space and remounts its navigator. Consume the
    // one-time navigation input before prompting, so that remount cannot replay it.
    navigation.setParams({ uri: undefined });
    Alert.alert(
      `Connect to ${offer.space_name}?`,
      "Continue only if you trust this Space host and requested this device link.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Connect", onPress: () => pair(uri) },
      ],
    );
  });
  // Only a new route input prompts. Callback/navigation changes read their latest
  // committed values without reopening a confirmation for the same one-time code.
  useEffect(() => {
    if (route.params?.uri) promptIncomingLink(route.params.uri);
  }, [route.params?.uri]);

  const pasteLink = async () => {
    const text = await Clipboard.getStringAsync();
    lastUri.current = null;
    if (text.trim()) pair(text);
    else setError("The clipboard is empty. Copy a device link from the Space’s settings first.");
  };

  const cameraBlocked = permission !== null && !permission.granted && !permission.canAskAgain;

  return (
    <View
      className="flex-1 gap-5 bg-surface px-5"
      style={{
        // An iOS sheet already sits below the status bar; an Android modal fills the screen.
        paddingTop: Platform.OS === "ios" && navigation.canGoBack() ? 20 : insets.top + 12,
        paddingBottom: Math.max(insets.bottom, 16),
      }}
    >
      <View className="flex-row items-center gap-2.5">
        <NodexMark size={28} />
        <Txt className="flex-1 text-xl font-semibold">Link a Space</Txt>
        {hosts.length > 0 ? (
          <Tap accessibilityLabel="Close" hitSlop={8} onPress={() => navigation.goBack()}>
            <Icon name="close" />
          </Tap>
        ) : null}
      </View>

      <View className="aspect-square w-full items-center justify-center overflow-hidden rounded-3xl border-[0.5px] border-line bg-surface-2">
        {permission?.granted ? (
          <CameraView
            active={!pairing}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            facing="back"
            onBarcodeScanned={({ data }) => pair(data)}
            style={{ position: "absolute", inset: 0 }}
          />
        ) : (
          <View className="items-center gap-3 px-8">
            <Icon name="scan" size={30} color="ink-3" />
            <Txt className="text-center text-sm text-ink-3">
              {cameraBlocked
                ? "Camera access is off for Nodex."
                : "Nodex uses the camera only to read this code."}
            </Txt>
            <Button
              compact
              label={cameraBlocked ? "Open Settings" : "Allow camera"}
              onPress={() => {
                if (cameraBlocked) void Linking.openSettings();
                else void requestPermission();
              }}
            />
          </View>
        )}
        {pairing ? (
          <View className="absolute inset-0 items-center justify-center gap-2 bg-surface-2">
            <Spinner />
            <Txt className="text-sm text-ink-2">Connecting</Txt>
          </View>
        ) : null}
      </View>

      {error ? (
        <View accessibilityLiveRegion="polite" className="flex-row gap-2">
          <Icon name="warning" size={16} color="danger" />
          <View className="flex-1 items-start gap-2">
            <Txt className="text-sm text-ink-2">{error}</Txt>
            {retryUri ? (
              <Button
                compact
                label="Try again"
                onPress={() => {
                  lastUri.current = null;
                  pair(retryUri);
                }}
              />
            ) : null}
          </View>
        </View>
      ) : (
        <View className="gap-1.5">
          {STEPS.map((step, index) => (
            <View key={step} className="flex-row gap-2">
              <Txt className="w-4 text-sm text-ink-3">{index + 1}</Txt>
              <Txt className="flex-1 text-sm text-ink-2">{step}</Txt>
            </View>
          ))}
        </View>
      )}

      <View className="flex-1" />
      <Button
        icon="link"
        label="Paste a device link"
        disabled={pairing}
        onPress={() => void pasteLink()}
      />
    </View>
  );
};
