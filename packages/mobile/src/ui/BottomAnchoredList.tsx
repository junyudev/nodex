import { LegendList, type LegendListProps, type LegendListRef } from "@legendapp/list/react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import type { ContentInsets } from "./ComposerLayout";
import { Glass } from "./glass";
import { Icon } from "./icons";
import { Tap } from "./primitives";

/** How far from the end, in viewports, before the way back is offered. */
const AWAY_VIEWPORTS = 0.75;

/**
 * A stream that reads like a conversation: oldest first, resting at the newest beside the Composer,
 * a short one sitting at the bottom. It follows new content only while the person is at the end;
 * reading further up holds still while the end grows, and loading older items keeps their place.
 */
export const BottomAnchoredList = <Item,>({
  sentCount = 0,
  insets,
  ...props
}: LegendListProps<Item> & {
  /** How many things the person has sent from here. Sending always returns to the end. */
  readonly sentCount?: number;
  readonly insets: ContentInsets;
}) => {
  const list = useRef<LegendListRef>(null);
  const [away, setAway] = useState(false);
  // What was sent joins the list a moment later, and the end has to include it.
  const owedEnd = useRef(false);
  const itemCount = props.data?.length ?? 0;
  const knownCount = useRef(itemCount);

  useEffect(() => {
    if (sentCount === 0) return;
    owedEnd.current = true;
    void list.current?.scrollToEnd({ animated: true });
  }, [sentCount]);

  useEffect(() => {
    const grew = itemCount > knownCount.current;
    knownCount.current = itemCount;
    if (!grew || !owedEnd.current) return;
    owedEnd.current = false;
    void list.current?.scrollToEnd({ animated: false });
  }, [itemCount]);

  // A taller foot, such as a Composer growing a line, must not cover the end being read.
  const knownBottom = useRef(insets.bottom);
  useEffect(() => {
    const grew = insets.bottom > knownBottom.current;
    knownBottom.current = insets.bottom;
    if (grew && !away) void list.current?.scrollToEnd({ animated: false });
  }, [away, insets.bottom]);

  return (
    <View className="flex-1">
      <LegendList
        ref={list}
        alignItemsAtEnd
        contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: insets.bottom + 8 }}
        contentInsetAdjustmentBehavior="never"
        estimatedItemSize={120}
        initialScrollAtEnd
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        maintainScrollAtEnd={{
          animated: false,
          on: { dataChange: true, itemLayout: true, layout: true },
        }}
        maintainVisibleContentPosition={{ data: true, size: true }}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          const fromEnd = contentSize.height - layoutMeasurement.height - contentOffset.y;
          setAway(fromEnd > layoutMeasurement.height * AWAY_VIEWPORTS);
        }}
        onScrollBeginDrag={() => {
          owedEnd.current = false;
        }}
        onStartReachedThreshold={0.5}
        // Rows hold their own state, such as an opened run of work.
        recycleItems={false}
        scrollEventThrottle={100}
        scrollIndicatorInsets={{ top: insets.top, bottom: insets.bottom }}
        {...props}
      />
      {away ? (
        <View className="absolute self-center" style={{ bottom: insets.bottom + 8 }}>
          <Glass radius={20}>
            <Tap
              accessibilityLabel="Go to the newest"
              className="h-10 w-10 items-center justify-center"
              hitSlop={6}
              onPress={() => void list.current?.scrollToEnd({ animated: true })}
            >
              <Icon name="arrowDown" size={20} color="ink" />
            </Tap>
          </Glass>
        </View>
      ) : null}
    </View>
  );
};
