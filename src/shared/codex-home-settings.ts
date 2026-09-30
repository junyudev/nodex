import { z } from "zod";

export interface CodexHomeSettings {
  readonly homePath: string;
  readonly resolvedHomePath: string;
  readonly source: "settings" | "environment" | "default";
}

export interface CodexHomeSettingsSnapshot extends CodexHomeSettings {
  readonly activeHomePath: string;
  readonly restartRequired: boolean;
}

export const CodexHomeSettingsUpdateSchema = z
  .object({
    homePath: z
      .string()
      .trim()
      .max(4_096)
      .refine((value) => !value.includes("\0")),
  })
  .strict();

export type CodexHomeSettingsUpdateInput = z.infer<typeof CodexHomeSettingsUpdateSchema>;
