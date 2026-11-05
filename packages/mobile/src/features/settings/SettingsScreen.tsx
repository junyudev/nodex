import * as Application from "expo-application";
import { Alert, ScrollView, View } from "react-native";

import type { ScreenProps } from "../../navigation/types";
import {
  activateHost,
  forgetHost,
  reconnectNow,
  useConnection,
  useHosts,
  type SavedHost,
} from "../../runtime";
import { Icon } from "../../ui/icons";
import { Row, RowGroup, SectionLabel, StatusDot, Txt } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";

const STATUS_WORDS = {
  idle: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  offline: "Can't reach it right now",
  incompatible: "Needs an update",
  revoked: "Removed this phone",
} as const;

/** Which desktops this phone knows, and how the current one is doing. */
export const SettingsScreen = ({ navigation }: ScreenProps<"Settings">) => {
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();

  const confirmForget = (host: SavedHost) =>
    Alert.alert(
      `Forget ${host.hostName}?`,
      "This phone stops connecting to it, and captures not yet delivered are lost. To also remove the phone from your desktop, use Settings there.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            forgetHost(host.hostId).catch((cause: unknown) =>
              showFailure("Could not forget it", cause),
            );
          },
        },
      ],
    );

  const active = hosts.find((host) => host.hostId === activeHostId);

  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="gap-5 p-4"
      contentInsetAdjustmentBehavior="automatic"
    >
      {active ? (
        <View>
          <SectionLabel>This phone is connected to</SectionLabel>
          <RowGroup>
            <Row
              icon="laptop"
              label={active.hostName}
              detail={STATUS_WORDS[connection.status]}
              trailing={
                <StatusDot
                  tone={
                    connection.status === "connected"
                      ? "accent"
                      : connection.status === "connecting"
                        ? "ink-3"
                        : "warning"
                  }
                />
              }
              onPress={reconnectNow}
            />
            <Row
              icon="close"
              label={`Forget ${active.hostName}`}
              tone="danger"
              onPress={() => confirmForget(active)}
            />
          </RowGroup>
        </View>
      ) : null}

      {hosts.length > 1 ? (
        <View>
          <SectionLabel>Other desktops</SectionLabel>
          <RowGroup>
            {hosts
              .filter((host) => host.hostId !== activeHostId)
              .map((host) => (
                <Row
                  key={host.hostId}
                  icon="laptop"
                  label={host.hostName}
                  onPress={() => activateHost(host.hostId)}
                  onLongPress={() => confirmForget(host)}
                />
              ))}
          </RowGroup>
        </View>
      ) : null}

      <RowGroup>
        <Row icon="scan" label="Pair another desktop" onPress={() => navigation.navigate("Pair")} />
      </RowGroup>

      <View className="flex-row gap-2 px-1">
        <Icon name="check" size={15} color="ink-3" />
        <Txt className="flex-1 text-xs text-ink-3">
          Everything between this phone and your desktop is end-to-end encrypted, on any network.
          Chats run on your desktop, so it needs to be on and open.
        </Txt>
      </View>
      <Txt className="px-1 text-xs text-ink-3">
        Nodex Mobile {Application.nativeApplicationVersion ?? ""}
      </Txt>
    </ScrollView>
  );
};
