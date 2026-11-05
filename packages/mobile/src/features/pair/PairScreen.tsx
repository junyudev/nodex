import { parsePairingUri } from "@nodex/mobile-protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ScreenProps } from "../../navigation/types";
import { pairWithUri, useHosts } from "../../runtime";
import { Icon, NodexMark } from "../../ui/icons";
import { Button, Spinner, Tap, Txt, lightTap } from "../../ui/primitives";
import { pairingFailureMessage, pairingFailureReason } from "./pairing-copy";

const STEPS = [
  "Open Nodex on your computer.",
  "Go to Settings, then Mobile, and turn it on.",
  "Choose Pair a phone and scan the code.",
];

/**
 * Reaching a desktop is the only thing this app needs before it is useful, so this is the whole
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

  const pair = useCallback(
    (uri: string) => {
      if (uri === lastUri.current) return;
      lastUri.current = uri;
      if (!parsePairingUri(uri)) {
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
          if (navigation.canGoBack()) navigation.goBack();
        })
        .catch((cause: unknown) => {
          const reason = pairingFailureReason(cause);
          setError(pairingFailureMessage(reason));
          if (reason === "unreachable" || reason === "busy") setRetryUri(uri);
        })
        .finally(() => setPairing(false));
    },
    [navigation],
  );

  // A link can come from anywhere, so unlike a code aimed at on purpose it has to ask first.
  useEffect(() => {
    const uri = route.params?.uri;
    const offer = uri ? parsePairingUri(uri) : null;
    if (!uri || !offer) return;
    Alert.alert(
      `Connect to ${offer.hostName}?`,
      "Only continue if you just showed this code on your own computer. That desktop will receive what you send from this phone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Connect", onPress: () => pair(uri) },
      ],
    );
  }, [pair, route.params?.uri]);

  const pasteLink = async () => {
    const text = await Clipboard.getStringAsync();
    lastUri.current = null;
    if (text.trim()) pair(text);
    else setError("The clipboard is empty. Copy the pairing link from your desktop first.");
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
        <Txt className="flex-1 text-xl font-semibold">Connect to your desktop</Txt>
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
        label="Paste a pairing link"
        disabled={pairing}
        onPress={() => void pasteLink()}
      />
    </View>
  );
};
