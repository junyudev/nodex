export interface IntelligenceEffortStop {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export const THINKING_OFF_EFFORT_STOP = "off";

/**
 * Effort is ordinal, so the picker presents it as stops on one track. A model that can turn
 * thinking off reads that choice as the stop below its lowest effort.
 */
export function resolveIntelligenceEffortStops(input: {
  readonly efforts: readonly { readonly reasoningEffort: string; readonly description?: string }[];
  readonly label: (effort: string) => string;
  readonly canDisableThinking: boolean;
}): readonly IntelligenceEffortStop[] {
  const efforts = input.efforts.map((option) => ({
    value: option.reasoningEffort,
    label: input.label(option.reasoningEffort),
    ...(option.description && option.description !== input.label(option.reasoningEffort)
      ? { description: option.description }
      : {}),
  }));
  if (!input.canDisableThinking || efforts.length === 0) return efforts;
  return [{ value: THINKING_OFF_EFFORT_STOP, label: "Off" }, ...efforts];
}

/**
 * The stop the track shows. An effort the user never chose rests on the model default and is
 * marked as such; a stale value the model no longer offers does the same rather than vanish.
 */
export function resolveIntelligenceEffortPosition(input: {
  readonly stops: readonly IntelligenceEffortStop[];
  readonly selected: string;
  readonly modelDefault: string | null | undefined;
  readonly thinkingOff: boolean;
}): { readonly value: string | null; readonly isDefault: boolean } {
  const has = (value: string | null | undefined): value is string =>
    value != null && input.stops.some((stop) => stop.value === value);
  if (input.thinkingOff && has(THINKING_OFF_EFFORT_STOP))
    return { value: THINKING_OFF_EFFORT_STOP, isDefault: false };
  if (input.selected !== "default" && has(input.selected))
    return { value: input.selected, isDefault: false };
  const fallback = has(input.modelDefault)
    ? input.modelDefault
    : (input.stops.find((stop) => stop.value !== THINKING_OFF_EFFORT_STOP)?.value ?? null);
  return { value: fallback, isDefault: true };
}

/** Choices shown at once while their write is on its way, so controls never lag a click. */
export interface IntelligenceIntentOverlay {
  readonly effort?: string;
  readonly fast?: boolean;
  readonly ultracode?: boolean;
}

/** Drops each shown choice the committed state now matches; the rest stay shown. */
export function settleIntelligenceIntentOverlay(
  overlay: IntelligenceIntentOverlay,
  committed: {
    readonly effort: string | null;
    readonly fast: boolean;
    readonly ultracode: boolean;
  },
): IntelligenceIntentOverlay {
  const pending = Object.entries(overlay).filter(
    ([key, value]) => committed[key as keyof IntelligenceIntentOverlay] !== value,
  );
  return pending.length === Object.keys(overlay).length ? overlay : Object.fromEntries(pending);
}
