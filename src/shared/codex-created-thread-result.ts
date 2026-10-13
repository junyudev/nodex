import { z } from "zod";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "./codex-client-thread";
import type { CodexCanonicalItem, CodexDynamicToolCallView } from "./types";

const nativeId = z.string().trim().min(1);
const hostId = nativeId.optional();
const resultSchema = z.union([
  z.object({ kind: z.literal("chatgpt"), threadId: nativeId }),
  z.object({ kind: z.literal("chatgpt"), clientThreadId: nativeId }),
  z.object({ kind: z.literal("codex").optional(), threadId: nativeId, hostId }),
  z.object({
    kind: z.literal("codex").optional(),
    clientThreadId: z.string().refine((value) => value.startsWith(CODEX_CLIENT_THREAD_ID_PREFIX)),
    hostId,
  }),
]);

/** Creation results identify a target; they never replace the source receipt's identity. */
export type CodexCreatedThreadResult = z.infer<typeof resultSchema>;
type CreatedThreadCall = Pick<
  CodexDynamicToolCallView,
  "namespace" | "tool" | "contentItems" | "success"
>;

export function decodeCreatedThreadResult(value: unknown): CodexCreatedThreadResult | null {
  const result = resultSchema.safeParse(value);
  return result.success ? result.data : null;
}

function readCreatedThreadText(call: CreatedThreadCall): CodexCreatedThreadResult | null {
  const text = call.contentItems?.find((item) => item.type === "inputText")?.text;
  if (!text) return null;
  try {
    return decodeCreatedThreadResult(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Native whole-item promotion has a strict app namespace and completion boundary. */
export function readNativeCreatedThreadResult(
  item: ThreadItem | CodexCanonicalItem,
): CodexCreatedThreadResult | null {
  if (
    item.type !== "dynamicToolCall" ||
    item.namespace !== "codex_app" ||
    item.tool !== "create_thread" ||
    item.status !== "completed" ||
    item.success !== true
  )
    return null;
  return readCreatedThreadText(item);
}

/** The ordinary tool registry also owns its namespace-less create-thread mirror. */
export function readCreatedThreadActivityResult(
  call: CreatedThreadCall & { readonly completed: boolean },
): CodexCreatedThreadResult | null {
  if (
    (call.namespace !== "codex_app" && call.namespace !== null) ||
    call.tool !== "create_thread" ||
    !call.completed ||
    call.success !== true
  )
    return null;
  return readCreatedThreadText(call);
}
