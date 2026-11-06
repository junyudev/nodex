import { useHeaderHeight } from "@react-navigation/elements";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { LIQUID_GLASS } from "./glass";

/** How far content must stay clear of the bars floating over it. */
export interface ContentInsets {
  readonly top: number;
  readonly bottom: number;
}

/** Keeps something that doesn't scroll, such as an empty state, clear of the floating bars. */
export const insetPadding = ({ top, bottom }: ContentInsets) => ({
  paddingTop: top,
  paddingBottom: bottom,
});

/** Roughly one Composer, so a list's first layout already rests above where it will float. */
const INITIAL_FOOT_HEIGHT = 96;

/**
 * A surface whose content passes under its floating bars: the navigation bar above where the system
 * draws it as glass, and `foot` below, which the keyboard lifts along with the content's end.
 */
export const ComposerLayout = ({
  foot,
  children,
}: {
  /** What floats at the bottom, normally ending in a Composer. */
  readonly foot: ReactNode;
  readonly children: (insets: ContentInsets) => ReactNode;
}) => {
  const headerHeight = useHeaderHeight();
  const [footHeight, setFootHeight] = useState(INITIAL_FOOT_HEIGHT);
  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-surface"
      keyboardVerticalOffset={LIQUID_GLASS ? 0 : headerHeight}
    >
      {/* Padding moves this box, and the absolutely placed foot goes with it. */}
      <View className="flex-1">
        {children({ top: LIQUID_GLASS ? headerHeight : 0, bottom: footHeight })}
        <View
          className="absolute inset-x-0 bottom-0 gap-2"
          pointerEvents="box-none"
          onLayout={(event) => setFootHeight(event.nativeEvent.layout.height)}
        >
          {foot}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};
