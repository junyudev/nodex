import type { AgentEffort } from "@nodex/mobile-protocol";
import { ScrollView } from "react-native";

import { cn } from "../../ui/cn";
import { Tap, Txt, lightTap } from "../../ui/primitives";

/**
 * How hard a model reasons, as one line of choices beside whatever they belong to: a Composer's
 * controls or a sheet's rows. The line scrolls when a model offers more than fit.
 */
export const EffortPills = ({
  efforts,
  selected,
  onChoose,
}: {
  readonly efforts: readonly AgentEffort[];
  readonly selected: string | null;
  /** Called for the one already in force as well, so a tap always answers. */
  readonly onChoose: (effort: string) => void;
}) => (
  <ScrollView
    horizontal
    accessibilityLabel="Reasoning effort"
    accessibilityRole="radiogroup"
    className="shrink grow-0"
    contentContainerClassName="gap-1"
    keyboardShouldPersistTaps="handled"
    showsHorizontalScrollIndicator={false}
  >
    {efforts.map((effort) => {
      const chosen = effort.id === selected;
      return (
        <Tap
          key={effort.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: chosen }}
          className={cn(
            "h-8 items-center justify-center rounded-full px-3",
            chosen ? "bg-ink" : "bg-fill",
          )}
          onPress={() => {
            lightTap();
            onChoose(effort.id);
          }}
        >
          <Txt
            className={cn(
              "text-[14px] leading-[18px]",
              chosen ? "font-medium text-surface" : "text-ink-2",
            )}
          >
            {effort.label}
          </Txt>
        </Tap>
      );
    })}
  </ScrollView>
);
