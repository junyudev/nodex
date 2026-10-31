import { z } from "zod";

export const UsageMeterSettingsSchema = z
  .object({
    claude: z.boolean(),
    codex: z.boolean(),
    nodexCredit: z.boolean(),
  })
  .strict();

export type UsageMeterSettings = z.infer<typeof UsageMeterSettingsSchema>;

export const DEFAULT_USAGE_METER_SETTINGS: UsageMeterSettings = {
  claude: true,
  codex: true,
  nodexCredit: true,
};
export const USAGE_METER_SETTINGS_CHANGED_CHANNEL = "usage-meter-settings-changed";

export function sameUsageMeterSettings(left: UsageMeterSettings, right: UsageMeterSettings) {
  return (
    left.claude === right.claude &&
    left.codex === right.codex &&
    left.nodexCredit === right.nodexCredit
  );
}
