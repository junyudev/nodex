import type { UserInput } from "@nodex/codex-app-server-protocol/v2/UserInput";

export interface CodexDelegationPayload {
  readonly sourceThreadId: string;
  readonly input: string;
}

function escapeCodexDelegationXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapeCodexDelegationXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function readCodexDelegationTag(value: string, tag: string): string | null {
  const matched = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i").exec(value)?.[1];
  if (matched === undefined) return null;
  return unescapeCodexDelegationXml(matched.trim());
}

/** Exact `KVe`: serialize delegated create-thread input into the protocol text envelope. */
export function buildCodexDelegationText(payload: CodexDelegationPayload): string {
  return [
    "<codex_delegation>",
    `  <source_thread_id>${escapeCodexDelegationXml(payload.sourceThreadId)}</source_thread_id>`,
    `  <input>${escapeCodexDelegationXml(payload.input)}</input>`,
    "</codex_delegation>",
  ].join("\n");
}

/** Exact `qVe`: the delegation envelope is one ordinary text input item. */
export function buildCodexDelegationInput(payload: CodexDelegationPayload): UserInput[] {
  return [
    {
      type: "text",
      text: buildCodexDelegationText(payload),
      text_elements: [],
    },
  ];
}

/** Exact `JVe/YVe`: recognize only a complete delegation envelope and unescape its fields. */
export function parseCodexDelegationText(value: string): CodexDelegationPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith("<codex_delegation>") || !normalized.endsWith("</codex_delegation>")) {
    return null;
  }

  const sourceThreadId = readCodexDelegationTag(normalized, "source_thread_id");
  const input = readCodexDelegationTag(normalized, "input");
  if (sourceThreadId === null || input === null) return null;
  return { sourceThreadId, input };
}

/** Voice handoffs are a distinct complete envelope, never an ordinary user's prose. */
export function parseCodexRealtimeDelegationText(value: string): {
  readonly input: string;
  readonly source: "transcript_tail_flush" | null;
} | null {
  const normalized = value.trim();
  if (
    !normalized.startsWith("<realtime_delegation>") ||
    !normalized.endsWith("</realtime_delegation>")
  )
    return null;
  const input = readCodexDelegationTag(normalized, "input");
  if (input === null) return null;
  return {
    input,
    source:
      readCodexDelegationTag(normalized, "source") === "transcript_tail_flush"
        ? "transcript_tail_flush"
        : null,
  };
}
