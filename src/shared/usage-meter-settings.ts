import { subscriptionMeters } from "./subscription-usage";
import { z } from "zod";

export const UsageMeterSettingsSchema = z
  .object({
    codex: z.boolean(),
    nodexCredit: z.boolean(),
  })
  .catchall(z.boolean());

export type UsageMeterSettings = z.infer<typeof UsageMeterSettingsSchema>;

export const DEFAULT_USAGE_METER_SETTINGS: UsageMeterSettings = {
  ...Object.fromEntries(subscriptionMeters.map(({ preference }) => [preference, true])),
  codex: true,
  nodexCredit: true,
};
export const USAGE_METER_SETTINGS_CHANGED_CHANNEL = "usage-meter-settings-changed";

export function sameUsageMeterSettings(left: UsageMeterSettings, right: UsageMeterSettings) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(
    (key) => (left[key] !== false) === (right[key] !== false),
  );
}
