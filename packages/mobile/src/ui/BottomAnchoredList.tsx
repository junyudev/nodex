import { LegendList, type LegendListProps, type LegendListRef } from "@legendapp/list/react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

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
  ...props
}: LegendListProps<Item> & {
  /** How many things the person has sent from here. Sending always returns to the end. */
  readonly sentCount?: number;
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

  return (
    <View className="flex-1">
      <LegendList
        ref={list}
        alignItemsAtEnd
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
        {...props}
      />
      {away ? (
        <Tap
          accessibilityLabel="Go to the newest"
          className="absolute bottom-2 h-9 w-9 items-center justify-center self-center rounded-full border-[0.5px] border-line bg-surface-3"
          hitSlop={6}
          onPress={() => void list.current?.scrollToEnd({ animated: true })}
        >
          <Icon name="chevronDown" size={18} color="ink" />
        </Tap>
      ) : null}
    </View>
  );
};
