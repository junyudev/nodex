import { useState } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ScreenProps } from "../../navigation/types";
import { Row, RowGroup, SectionLabel, Txt } from "../../ui/primitives";
import { inboxLaterPresets } from "./inbox-later-time";
import { handlePassedReturnTime, useDecide } from "./use-decide";

export const InboxLaterPicker = ({ route, navigation }: ScreenProps<"InboxLaterPicker">) => {
  const { pageId, expired, proposal } = route.params;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [now, setNow] = useState(() => new Date());
  const [passed, setPassed] = useState(expired ?? false);
  const [saving, setSaving] = useState(false);
  const decide = useDecide();

  const choose = async (until: string) => {
    if (saving) return;
    setSaving(true);
    const saved = await decide(
      pageId,
      proposal ? { type: "accept", ...proposal, remindAt: until } : { type: "later", until },
      "Set aside",
      (cause) =>
        handlePassedReturnTime(cause, () => {
          setPassed(true);
          setNow(new Date());
        }),
      { type: "clear_later" },
    );
    setSaving(false);
    if (saved && navigation.isFocused()) navigation.goBack();
  };

  return (
    <ScrollView
      contentContainerClassName="px-4 pt-7"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) }}
      style={{ maxHeight: height * 0.8 }}
    >
      <SectionLabel>Later</SectionLabel>
      {passed ? (
        <Txt accessibilityLiveRegion="polite" className="px-1 pb-3 text-sm text-ink-2">
          That return time has passed. Choose a new time.
        </Txt>
      ) : null}
      <RowGroup>
        {inboxLaterPresets(now).map(({ label, remindAt }) => (
          <Row key={label} label={label} disabled={saving} onPress={() => void choose(remindAt)} />
        ))}
      </RowGroup>
    </ScrollView>
  );
};
