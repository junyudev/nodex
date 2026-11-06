import type { ReactNode } from "react";
import { View } from "react-native";

import { Glass } from "./glass";
import { Icon, type IconName } from "./icons";
import { Txt } from "./primitives";
import type { ColorToken } from "./tokens";

/** A standing condition floating above the Composer: what is true, and any action it allows. */
export const FloatingNote = ({
  icon,
  iconColor = "ink-3",
  text,
  action,
}: {
  readonly icon: IconName;
  readonly iconColor?: ColorToken;
  readonly text: string;
  readonly action?: ReactNode;
}) => (
  <View className="px-4" pointerEvents="box-none">
    <Glass radius={20}>
      <View className="min-h-10 flex-row items-center gap-2 px-3.5 py-2.5">
        <Icon name={icon} size={15} color={iconColor} />
        <Txt className="flex-1 text-sm text-ink-2" numberOfLines={3}>
          {text}
        </Txt>
        {action}
      </View>
    </Glass>
  </View>
);
