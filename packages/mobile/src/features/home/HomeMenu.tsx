import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { navigationRef } from "../../navigation/types";
import { activateHost, useConnection, useHosts } from "../../runtime";
import { cn } from "../../ui/cn";
import { Icon } from "../../ui/icons";
import { IconButton, SectionLabel, Tap, Txt } from "../../ui/primitives";
import { useSideMenu } from "../../ui/SideMenu";
import { SpaceAvatar } from "../../ui/SpaceAvatar";
import type { InboxChoice } from "../inbox/inbox-choices";
import { useInboxChoices } from "../inbox/use-inbox-choices";
import { linkedSpace, spaceKindLabel, spaceStatusLine } from "../settings/space-presentation";
import { useHomeState } from "./home-state";

/** A place to go, set straight on the menu: its mark, its name, and a quiet note at the end. */
const MenuRow = ({
  mark,
  label,
  note,
  selected = false,
  accessibilityLabel,
  onPress,
}: {
  readonly mark: ReactNode;
  readonly label: string;
  readonly note?: string | null;
  readonly selected?: boolean;
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
}) => (
  <Tap
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ selected }}
    className={cn(
      "mx-2.5 min-h-12 flex-row items-center gap-3 rounded-2xl px-2.5",
      selected && "bg-fill",
    )}
    pressedClassName="active:bg-fill"
    onPress={onPress}
  >
    <View className="w-7 items-center">{mark}</View>
    <Txt className="flex-1" numberOfLines={1}>
      {label}
    </Txt>
    {note ? <Txt className="pr-1 text-sm text-ink-3">{note}</Txt> : null}
  </Tap>
);

/**
 * Where the phone is looking, beneath the app: the current Space, each Inbox it has to show, and
 * the other Spaces this phone is linked to. Choosing any of them goes there and returns to the app.
 */
export const HomeMenu = () => {
  const insets = useSafeAreaInsets();
  const menu = useSideMenu();
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  const { library, projects, choose } = useInboxChoices();
  const setMode = useHomeState((state) => state.setMode);
  const current = hosts.find((host) => host.hostId === activeHostId);
  if (!current) return null;
  const others = hosts.filter((host) => host !== current);

  const inboxRow = (choice: InboxChoice) => (
    <MenuRow
      key={choice.key}
      mark={<Icon name={choice.icon} size={22} color="ink" />}
      label={choice.label}
      note={choice.count > 0 ? String(choice.count) : null}
      selected={choice.selected}
      accessibilityLabel={
        choice.count > 0 ? `${choice.label}, ${choice.count} waiting` : choice.label
      }
      onPress={() => {
        choose(choice.scope);
        setMode("inbox");
        menu.close();
      }}
    />
  );

  return (
    <View className="flex-1" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-3 pb-2 pl-5 pr-3.5 pt-3">
        <SpaceAvatar space={linkedSpace(current)} size={36} />
        <View className="flex-1">
          <Txt accessibilityRole="header" className="text-xl font-semibold" numberOfLines={1}>
            {current.hostName}
          </Txt>
          <Txt className="text-sm text-ink-3" numberOfLines={1}>
            {spaceStatusLine(linkedSpace(current), connection.status)}
          </Txt>
        </View>
        <IconButton
          className="h-10 w-10 bg-fill"
          color="ink"
          label="Settings"
          name="sliders"
          onPress={() => navigationRef.navigate("Settings")}
        />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        // Beneath the app, it must not compete with the app's lists for a tap on the status bar.
        scrollsToTop={menu.isOpen}
      >
        <SectionLabel className="px-5 pt-4">Inbox</SectionLabel>
        {inboxRow(library)}
        {projects.map(inboxRow)}
        {others.length > 0 ? (
          <>
            <SectionLabel className="px-5 pt-6">Other Spaces</SectionLabel>
            {others.map((host) => (
              <MenuRow
                key={host.hostId}
                mark={<SpaceAvatar space={linkedSpace(host)} size={24} />}
                label={host.hostName}
                note={spaceKindLabel(linkedSpace(host))}
                onPress={() => {
                  menu.close();
                  activateHost(host.hostId);
                }}
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
};
