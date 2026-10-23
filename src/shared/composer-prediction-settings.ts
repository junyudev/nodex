import { z } from "zod";

export const ComposerPredictionSettingsSchema = z.object({ enabled: z.boolean() }).strict();

export type ComposerPredictionSettings = z.infer<typeof ComposerPredictionSettingsSchema>;

export const DEFAULT_COMPOSER_PREDICTION_SETTINGS: ComposerPredictionSettings = { enabled: true };
export const COMPOSER_PREDICTION_SETTINGS_CHANGED_CHANNEL = "composer-prediction-settings-changed";
