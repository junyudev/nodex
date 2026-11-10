import type { ReactNode } from "react";
import { View } from "react-native";
import { GestureDetector, useTapGesture } from "react-native-gesture-handler";

/** Longer than anyone holds a button and still means a tap. */
const ANY_HOLD_MS = 60_000;

/**
 * A control in a navigation bar. Where a tap on the bar sends the content beneath it to its top, as
 * on iOS 27, a tap on a control there must still mean only what the control does. Recognizing the
 * tap here, as a gesture of the control's own, keeps the bar from taking it for one of its own; the
 * control beneath still receives it as usual.
 */
export const BarControl = ({ children }: { readonly children: ReactNode }) => {
  const tap = useTapGesture({
    cancelsJSResponder: false,
    cancelsTouchesInView: false,
    maxDuration: ANY_HOLD_MS,
  });
  return (
    <GestureDetector gesture={tap}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
};
