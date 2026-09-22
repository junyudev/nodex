export type LocalConversationAttachmentState =
  | { readonly status: "idle" }
  | { readonly status: "attaching" }
  | { readonly status: "attached" }
  | {
      readonly status: "failed";
      readonly message: string;
    };

export const IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE: LocalConversationAttachmentState = {
  status: "idle",
};

function readErrorField(value: unknown, field: "message" | "cause"): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Reflect.get(value, field);
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const message = current instanceof Error ? current.message : readErrorField(current, "message");
    if (typeof message === "string" && message.trim()) messages.push(message.trim());
    current = current instanceof Error ? current.cause : readErrorField(current, "cause");
  }
  if (messages.length === 0) {
    const fallback = String(error).trim();
    if (fallback && fallback !== "[object Object]") messages.push(fallback);
  }
  return [...new Set(messages)];
}

/** Converts transport failures into a stable, renderer-owned presentation contract. */
export function makeLocalConversationAttachmentFailure(
  error: unknown,
): Extract<LocalConversationAttachmentState, { readonly status: "failed" }> {
  const detail = collectErrorMessages(error).join(" · ");
  return {
    status: "failed",
    message: detail || "The thread could not be restored.",
  };
}

export function areLocalConversationAttachmentStatesEqual(
  left: LocalConversationAttachmentState,
  right: LocalConversationAttachmentState,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "failed" || right.status !== "failed") return true;
  return left.message === right.message;
}

export function isLocalConversationWriterConflict(
  state: LocalConversationAttachmentState,
): boolean {
  if (state.status !== "failed") return false;
  const message = state.message.toLowerCase();
  return (
    message.includes("already has an active writer") ||
    message.includes("already has a live local writer")
  );
}
