import * as Linking from "expo-linking";
import { Platform } from "react-native";

import { useRootNavigation } from "../../navigation/types";
import { reconnectNow, useConnection, useHosts, type ConnectionState } from "../../runtime";
import { FloatingNote } from "../../ui/FloatingNote";
import { Tap, Txt } from "../../ui/primitives";

/** Where this phone gets a newer Nodex Mobile: TestFlight on iPhone, the APK download on Android. */
const APP_UPDATE_URL =
  Platform.OS === "ios"
    ? "https://testflight.apple.com/join/Yz8Kpcty"
    : "https://nodex.jyu.app/download/#mobile";

const noticeFor = (
  connection: ConnectionState,
  hostName: string,
): {
  readonly tone: "warning" | "danger";
  readonly text: string;
  readonly action?: "retry" | "pair" | "update";
} | null => {
  switch (connection.status) {
    case "offline":
      return {
        tone: "warning",
        text: `Can't reach ${hostName}. This may be out of date.`,
        action: "retry",
      };
    case "revoked":
      return { tone: "danger", text: `${hostName} no longer knows this phone.`, action: "pair" };
    case "incompatible":
      return {
        tone: "danger",
        text: connection.message ?? `Update Nodex here or on ${hostName} to reconnect.`,
        action: "update",
      };
    default:
      return null;
  }
};

/** A standing condition of the connection, wherever it matters: what it means, and the fix. */
export const ConnectionNotice = () => {
  const navigation = useRootNavigation();
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  const hostName = hosts.find((host) => host.hostId === activeHostId)?.hostName ?? "your desktop";
  const notice = noticeFor(connection, hostName);
  if (!notice) return null;
  return (
    <FloatingNote
      icon="warning"
      iconColor={notice.tone}
      text={notice.text}
      action={
        notice.action === "retry" ? (
          <Tap hitSlop={8} onPress={reconnectNow}>
            <Txt className="text-sm font-medium">Retry</Txt>
          </Tap>
        ) : notice.action === "pair" ? (
          <Tap hitSlop={8} onPress={() => navigation.navigate("Pair")}>
            <Txt className="text-sm font-medium">Pair again</Txt>
          </Tap>
        ) : notice.action === "update" ? (
          <Tap hitSlop={8} onPress={() => void Linking.openURL(APP_UPDATE_URL)}>
            <Txt className="text-sm font-medium">Update</Txt>
          </Tap>
        ) : null
      }
    />
  );
};
