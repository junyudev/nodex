import { z } from "zod";

export const CodexExecutableUpdateSchema = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value));

export type CodexExecutableProbe =
  | { readonly status: "ready"; readonly version: string; readonly binaryPath: string }
  | { readonly status: "too-old"; readonly version: string }
  | { readonly status: "not-found" | "invalid-version" | "probe-failed" };

export interface CodexExecutablePreference {
  readonly executable: string;
  readonly activeExecutable: string;
}

export interface CodexExecutableSettings extends CodexExecutablePreference {
  readonly probe: CodexExecutableProbe | null;
  readonly pinnedVersion: string;
}
