import * as Application from "expo-application";
import { Alert, Linking, ScrollView, Switch, View } from "react-native";

import type { ScreenProps } from "../../navigation/types";
import {
  activateHost,
  enableNotifications,
  forgetHost,
  reconnectNow,
  retryNotifications,
  setNotificationPreferences,
  useConnection,
  useHosts,
  useNotifications,
  type NotificationProblem,
  type SavedHost,
} from "../../runtime";
import { Row, RowGroup, SectionLabel, StatusDot, Txt } from "../../ui/primitives";
import { SpaceAvatar } from "../../ui/SpaceAvatar";
import { showFailure } from "../../ui/snackbar";
import { useHomeState } from "../home/home-state";
import { linkedSpace, spaceKindLabel, spaceStatusLine } from "./space-presentation";

const HostAvatar = ({ host }: { readonly host: SavedHost }) => (
  <SpaceAvatar space={linkedSpace(host)} size={28} />
);

const PROBLEM_WORDS: Readonly<Record<NotificationProblem, string>> = {
  "no-address": "The system hasn't given this phone a notification address.",
  relay: "Nodex's notification service can't be reached from this network.",
  space: "This Space didn't accept this phone. Its host may need an update.",
};

/** A preference that takes effect at once, whichever part of the row is tapped. */
const SwitchRow = ({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) => (
  <Row
    accessibilityRole="switch"
    accessibilityState={{ checked: value }}
    label={label}
    trailing={<Switch accessibilityLabel={label} value={value} onValueChange={onChange} />}
    onPress={() => onChange(!value)}
  />
);

/** What this phone is told about while the app is closed. */
const NotificationSettings = () => {
  const { available, permission, preferences, problem } = useNotifications();
  if (!available) return null;
  // The system asks only once. After a refusal, only its own Settings can turn these back on.
  if (permission === "denied") {
    return (
      <View>
        <SectionLabel>Notifications</SectionLabel>
        <RowGroup>
          <Row
            icon="bell"
            label="Turn on in iOS Settings"
            detail="Notifications are off for Nodex."
            onPress={() => void Linking.openSettings()}
          />
        </RowGroup>
      </View>
    );
  }
  const change = (patch: Parameters<typeof setNotificationPreferences>[0]) => {
    const failed = (cause: unknown) => showFailure("Could not change notifications", cause);
    if (permission === "undetermined") enableNotifications().catch(failed);
    else setNotificationPreferences(patch).catch(failed);
  };
  return (
    <View>
      <SectionLabel>Notifications</SectionLabel>
      <RowGroup>
        <SwitchRow
          label="When a chat needs you"
          value={permission === "granted" && preferences.needsYou}
          onChange={(needsYou) => change({ needsYou })}
        />
        <SwitchRow
          label="When a chat finishes"
          value={permission === "granted" && preferences.finished}
          onChange={(finished) => change({ finished })}
        />
        {problem ? (
          <Row
            icon="warning"
            iconColor="warning"
            label="Not set up yet. Tap to retry"
            detail={PROBLEM_WORDS[problem]}
            onPress={() => void retryNotifications()}
          />
        ) : null}
      </RowGroup>
      <Txt className="px-1 pt-2 text-xs text-ink-3">
        Sent by each Space while you're away from your computer, and readable only on this phone.
      </Txt>
    </View>
  );
};

/** The Spaces enrolled for this phone, and how the current one is doing. */
export const SettingsScreen = ({ navigation }: ScreenProps<"Settings">) => {
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();

  const confirmForget = (host: SavedHost) =>
    Alert.alert(
      `Remove ${host.hostName}?`,
      "Remove this Space and its local cache and pending captures from this phone. The Device stays enrolled until revoked in the Space’s settings.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            forgetHost(host.hostId)
              .then(() => useHomeState.getState().forgetSpace(host.hostId))
              .catch((cause: unknown) => showFailure("Could not remove this Space", cause));
          },
        },
      ],
    );

  const active = hosts.find((host) => host.hostId === activeHostId);

  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="gap-6 p-4 pb-10"
      contentInsetAdjustmentBehavior="automatic"
    >
      {active ? (
        <View>
          <SectionLabel>Current Space</SectionLabel>
          <RowGroup>
            <Row
              leading={<HostAvatar host={active} />}
              label={active.hostName}
              detail={spaceStatusLine(linkedSpace(active), connection.status)}
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
              label="Remove from this phone"
              tone="danger"
              onPress={() => confirmForget(active)}
            />
          </RowGroup>
        </View>
      ) : null}

      <NotificationSettings />

      {hosts.length > 1 ? (
        <View>
          <SectionLabel>Other Spaces</SectionLabel>
          <RowGroup>
            {hosts
              .filter((host) => host.hostId !== activeHostId)
              .map((host) => (
                <Row
                  key={host.hostId}
                  leading={<HostAvatar host={host} />}
                  label={host.hostName}
                  detail={spaceKindLabel(linkedSpace(host))}
                  onPress={() => activateHost(host.hostId)}
                  onLongPress={() => confirmForget(host)}
                />
              ))}
          </RowGroup>
        </View>
      ) : null}

      <RowGroup>
        <Row icon="scan" label="Link a Space" onPress={() => navigation.navigate("Pair")} />
      </RowGroup>

      <Txt className="px-1 text-xs text-ink-3">
        Nodex Mobile {Application.nativeApplicationVersion ?? ""}
      </Txt>
    </ScrollView>
  );
};
