import { z } from "zod";
import { normalizeCodexPathIdentity } from "./codex-workspace-paths";

export const CODEX_VISUALIZATION_STATE_MAX_BYTES = 16_384;
export const CODEX_VISUALIZATION_STATE_MAX_ENTRIES = 100;

export const CodexVisualizationStateIdentitySchema = z.strictObject({
  hostId: z.string().min(1),
  threadId: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.includes("\0") &&
        ((path.startsWith("/") && !path.startsWith("//")) ||
          /^[A-Za-z]:[\\/]/.test(path) ||
          /^\\\\[^\\]+\\[^\\]+/.test(path) ||
          /^\/\/[^/]+\/[^/]+/.test(path)),
      "Widget state requires an absolute file path",
    ),
});
export type CodexVisualizationStateIdentity = z.infer<typeof CodexVisualizationStateIdentitySchema>;

const stateSchema = z
  .object({
    modelContent: z.json().default(null),
    privateContent: z.json().default(null),
    imageIds: z.array(z.string()).optional(),
  })
  .catchall(z.json());
export type CodexVisualizationWidgetState = z.infer<typeof stateSchema>;
export type CodexVisualizationStateFailureCode =
  | "invalid_state"
  | "state_too_large"
  | "images_unsupported"
  | "storage_unavailable";
export interface CodexVisualizationStateFailure {
  readonly ok: false;
  readonly code: CodexVisualizationStateFailureCode;
  readonly retryable: false;
}
export interface CodexVisualizationStateWriteInput {
  readonly identity: CodexVisualizationStateIdentity;
  readonly state: unknown;
  readonly mutationId: string;
}
export type CodexVisualizationStateWriteResult =
  | CodexVisualizationStateFailure
  | {
      readonly ok: true;
      readonly revision: number;
      readonly value: CodexVisualizationWidgetState;
    };

/** Budget the validated/defaulted JSON representation, not UTF-16 characters. */
export function parseCodexVisualizationWidgetState(
  value: unknown,
):
  | CodexVisualizationStateFailure
  | { readonly ok: true; readonly state: CodexVisualizationWidgetState } {
  try {
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) return { ok: false, code: "invalid_state", retryable: false };
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
    if (bytes > CODEX_VISUALIZATION_STATE_MAX_BYTES)
      return { ok: false, code: "state_too_large", retryable: false };
    if (parsed.data.imageIds?.length)
      return { ok: false, code: "images_unsupported", retryable: false };
    return { ok: true, state: parsed.data };
  } catch {
    return { ok: false, code: "invalid_state", retryable: false };
  }
}

export function codexVisualizationStateAtomKey(
  identity: Pick<CodexVisualizationStateIdentity, "hostId" | "threadId">,
): string {
  return `visualization-state-v3:${JSON.stringify([identity.hostId, identity.threadId])}`;
}
export const codexVisualizationStateEntryKey = (
  identity: CodexVisualizationStateIdentity,
): string => normalizeCodexPathIdentity(identity.path);
