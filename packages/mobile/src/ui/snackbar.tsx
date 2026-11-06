import { useEffect } from "react";
import { View } from "react-native";

import { Glass } from "./glass";
import { createLocalStore } from "./local-store";
import { Tap, Txt } from "./primitives";

interface Snack {
  readonly id: number;
  readonly text: string;
  readonly tone: "default" | "danger";
  readonly action?: { readonly label: string; readonly run: () => void };
}

const useSnackState = createLocalStore<{ readonly snack: Snack | null }>({ snack: null });

let nextSnackId = 1;

export const showSnack = (
  input: Omit<Snack, "id" | "tone"> & { readonly tone?: Snack["tone"] },
): void => {
  useSnackState.setState({ snack: { tone: "default", ...input, id: nextSnackId++ } });
};

/** A one-off failure of something the person just did: what failed, then why. */
export const showFailure = (title: string, cause: unknown): void => {
  const reason = cause instanceof Error && cause.message ? cause.message : null;
  showSnack({ text: reason ? `${title}. ${reason}` : title, tone: "danger" });
};

const SNACK_MS = 6000;

/** One transient message above the Composer. It never takes layout from what is beneath it. */
export const SnackbarHost = ({ bottom }: { readonly bottom: number }) => {
  const snack = useSnackState((state) => state.snack);
  useEffect(() => {
    if (!snack) return undefined;
    const timer = setTimeout(() => useSnackState.setState({ snack: null }), SNACK_MS);
    return () => clearTimeout(timer);
  }, [snack]);
  if (!snack) return null;
  return (
    <View pointerEvents="box-none" className="absolute inset-x-4" style={{ bottom }}>
      <Glass radius={22}>
        <View className="flex-row items-center gap-3 px-4 py-3">
          <Txt
            accessibilityLiveRegion="polite"
            className={snack.tone === "danger" ? "flex-1 text-sm text-danger" : "flex-1 text-sm"}
            numberOfLines={3}
          >
            {snack.text}
          </Txt>
          {snack.action ? (
            <Tap
              hitSlop={10}
              onPress={() => {
                useSnackState.setState({ snack: null });
                snack.action?.run();
              }}
            >
              <Txt className="text-sm font-semibold text-accent">{snack.action.label}</Txt>
            </Tap>
          ) : null}
        </View>
      </Glass>
    </View>
  );
};
