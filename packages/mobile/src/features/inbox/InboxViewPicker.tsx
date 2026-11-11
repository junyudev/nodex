import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ScreenProps } from "../../navigation/types";
import { useInbox, type InboxFilter } from "../../runtime";
import { Icon, type IconName } from "../../ui/icons";
import { Row, RowGroup, Txt } from "../../ui/primitives";
import { useHomeState } from "../home/home-state";
import { useInboxScope } from "./use-inbox-choices";

const VIEWS = [
  { filter: "inbox", label: "Inbox", icon: "inbox" },
  { filter: "later", label: "Later", icon: "clock" },
  { filter: "processed", label: "Handled", icon: "history" },
] as const satisfies readonly { filter: InboxFilter; label: string; icon: IconName }[];

export const InboxViewPicker = ({ navigation }: ScreenProps<"InboxViewPicker">) => {
  const insets = useSafeAreaInsets();
  const { scope } = useInboxScope();
  const filter = useHomeState((state) => state.filter);
  const setFilter = useHomeState((state) => state.setFilter);
  const { laterCount } = useInbox(scope, filter);
  return (
    <View className="px-4 pt-7" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
      <RowGroup>
        {VIEWS.map((view) => (
          <Row
            key={view.filter}
            icon={view.icon}
            label={view.label}
            accessibilityState={{ selected: view.filter === filter }}
            trailing={
              <View className="flex-row items-center gap-2">
                {view.filter === "later" ? (
                  <Txt className="text-sm text-ink-3">{laterCount}</Txt>
                ) : null}
                {view.filter === filter ? <Icon name="check" color="accent" /> : null}
              </View>
            }
            onPress={() => {
              setFilter(view.filter);
              navigation.goBack();
            }}
          />
        ))}
      </RowGroup>
    </View>
  );
};
