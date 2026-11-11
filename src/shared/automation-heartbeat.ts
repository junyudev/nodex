export type CodexHeartbeatDecision = "NOTIFY" | "DONT_NOTIFY";

export interface AutomationHeartbeatPrompt {
  automationId: string | null;
  firedAt: string;
  /** Includes the Runbook section when one was sent with the instructions. */
  instructions: string;
}

export interface AutomationHeartbeatReply {
  decision: CodexHeartbeatDecision;
  message: string | null;
  body: string;
}

export interface AutomationRunbook {
  readonly title: string;
  readonly pageKey: string;
  readonly body: string;
}

const OPEN = "<heartbeat>";
const CLOSE = "</heartbeat>";

export const runbookInstructions = (runbook?: AutomationRunbook | null): string[] =>
  runbook
    ? [
        "",
        `Runbook: ${runbook.title} (${runbook.pageKey})`,
        runbook.body,
        "You may update this runbook Page with what future runs should know.",
      ]
    : [];

export function buildAutomationHeartbeatPrompt(
  automation: { readonly id: string; readonly prompt: string },
  now = Date.now(),
  instructions = automation.prompt,
  runbook?: AutomationRunbook | null,
): string {
  return [
    OPEN,
    `  <automation_id>${automation.id}</automation_id>`,
    `  <current_time_iso>${new Date(now).toISOString()}</current_time_iso>`,
    "  <instructions>",
    instructions,
    ...runbookInstructions(runbook),
    "  </instructions>",
    CLOSE,
  ].join("\n");
}

const PROMPT =
  /^<heartbeat>\s*(?:<automation_id>([^<]*)<\/automation_id>\s*)?<current_time_iso>([^<]*)<\/current_time_iso>\s*<instructions>([\s\S]*)<\/instructions>\s*<\/heartbeat>$/i;

export function parseAutomationHeartbeatPrompt(text: string): AutomationHeartbeatPrompt | null {
  const match = PROMPT.exec(text.trim());
  if (!match) return null;
  const [, id, time, contents = ""] = match;
  const firedAt = time?.trim();
  if (!firedAt || /<\/instructions>\s*<\/heartbeat>\s*<heartbeat>/i.test(contents)) return null;
  // Remove the writer's framing lines without changing Markdown indentation.
  const framed = /^\r?\n([\s\S]*)\r?\n[ \t]*$/.exec(contents);
  return {
    automationId: id?.trim() || null,
    firedAt,
    instructions: framed?.[1] ?? contents.trim(),
  };
}

export function parseAutomationHeartbeatInput(
  input: readonly { readonly type: string; readonly text?: string }[],
): AutomationHeartbeatPrompt | null {
  return parseAutomationHeartbeatPrompt(
    input
      .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
      .join("\n"),
  );
}

export function isHistoricalAutomationPrompt(text: string): boolean {
  return /^\s*Sent by (?:scheduled task|rule)\b/.test(text);
}

function readTag(body: string, tag: "decision" | "message"): string | null {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(body)?.[1]?.trim() || null;
}

const FENCE_BEFORE = /```(?:xml|heartbeat)?\s*$/i;
const FENCE_AFTER = /^\s*```/;

function readEnvelopes(text: string) {
  if (!/<heartbeat\b/i.test(text)) return [];
  let previousEnd = 0;
  return [...text.matchAll(/<heartbeat\b[^>]*>((?:(?!<heartbeat\b)[\s\S])*?)<\/heartbeat>/gi)].map(
    (match) => {
      const fence = FENCE_BEFORE.exec(text.slice(previousEnd, match.index));
      const envelopeEnd = match.index + match[0].length;
      const closingFence = fence ? FENCE_AFTER.exec(text.slice(envelopeEnd)) : null;
      const start = fence ? previousEnd + fence.index : match.index;
      // A truncated stream may already have closed the XML while its closing fence is incomplete.
      const after = text.slice(envelopeEnd);
      const end = closingFence
        ? envelopeEnd + closingFence[0].length
        : fence && /^\s*`{0,2}$/.test(after)
          ? text.length
          : envelopeEnd;
      previousEnd = end;
      const fields = match[1] ?? "";
      const decision = readTag(fields, "decision");
      return {
        start,
        end,
        looksLikeReply: /<(?:decision|automation_id|message)\b/i.test(fields),
        decision: decision === "NOTIFY" || decision === "DONT_NOTIFY" ? decision : null,
        message: readTag(fields, "message"),
      };
    },
  );
}

function removeEnvelopes(
  text: string,
  envelopes: readonly { start: number; end: number }[],
): string {
  if (envelopes.length === 0) return text;
  let start = 0;
  let body = "";
  for (const envelope of envelopes) {
    body += text.slice(start, envelope.start);
    start = envelope.end;
  }
  return (body + text.slice(start)).trim();
}

export function parseAutomationHeartbeatReply(
  text: string | null | undefined,
): AutomationHeartbeatReply | null {
  if (!text) return null;
  const envelopes = readEnvelopes(text);
  const last = envelopes.at(-1);
  return last?.decision
    ? { decision: last.decision, message: last.message, body: removeEnvelopes(text, envelopes) }
    : null;
}

function stripTrailingEnvelope(text: string, streaming: boolean): string {
  const candidate = text.lastIndexOf("<");
  if (candidate < 0) return text;
  const suffix = text.slice(candidate).toLowerCase();
  const partial =
    (streaming || suffix.length >= "<heart".length) &&
    (OPEN.startsWith(suffix) || /^<heartbeat\b[^>]*$/i.test(suffix))
      ? candidate
      : -1;
  const unclosed = /<heartbeat\b[^>]*>(?:(?!<\/heartbeat>)[\s\S])*$/i.exec(text)?.index ?? -1;
  const start = unclosed >= 0 ? unclosed : partial;
  if (start < 0) return text;
  const prefix = text.slice(0, start);
  if (prefix.endsWith("`") && !FENCE_BEFORE.test(prefix)) return text;
  return prefix.replace(FENCE_BEFORE, "").trimEnd();
}

/** Project the reply without changing its stored or model-facing text. */
export function projectAutomationHeartbeatReply(
  text: string,
  streaming: boolean,
): {
  text: string;
  heartbeat: AutomationHeartbeatReply | null;
} {
  const candidate = stripTrailingEnvelope(text, streaming);
  const envelopes = readEnvelopes(candidate);
  const last = envelopes.at(-1);
  if (!last?.decision) {
    return {
      text: removeEnvelopes(
        candidate,
        envelopes.filter((envelope) => streaming || envelope.looksLikeReply),
      ),
      heartbeat: null,
    };
  }
  const body = removeEnvelopes(candidate, envelopes);
  return {
    text: body || (!streaming && last.decision === "NOTIFY" ? (last.message ?? "") : ""),
    heartbeat: { decision: last.decision, message: last.message, body },
  };
}

/** Project a bounded opening-prompt preview, which may end inside the instructions. */
export function projectAutomationPromptPreview(text: string): string {
  const prompt = parseAutomationHeartbeatPrompt(text);
  if (prompt) return prompt.instructions;
  const candidate = text.trimStart();
  const partial = /^<heartbeat>\s*<(?:automation_id|current_time_iso)>/i;
  if (!partial.test(candidate)) return text;
  return /<instructions>([\s\S]*?)(?:<\/instructions>|$)/i.exec(candidate)?.[1]?.trim() ?? "";
}

/** Search transports return excerpts with the original offsets and may clip either end. */
export function projectAutomationHeartbeatExcerpt(text: string): string {
  const source = text.replace(/^…/, "");
  const prompt = projectAutomationPromptPreview(source);
  if (prompt !== source) return prompt;
  const reply = projectAutomationHeartbeatReply(source, false);
  if (reply.text !== source) return reply.text;

  // If the excerpt begins inside an envelope, only keep text whose field is readable.
  if (/<\/?(?:automation_id|current_time_iso|instructions|decision|heartbeat)\b/i.test(source)) {
    const instructions =
      /<instructions>([\s\S]*?)(?:<\/instructions>|$)|^([\s\S]*?)<\/instructions>/i.exec(source);
    if (instructions) return (instructions[1] ?? instructions[2] ?? "").trim();
    const after = /<\/heartbeat>(?:\s*```)?([\s\S]*)$/i.exec(source);
    return after?.[1]?.trim() ?? "";
  }
  return text;
}

// The notification envelope keeps its own public field names.
export interface CodexHeartbeatAssistantMessage {
  decision: CodexHeartbeatDecision;
  visibleText: string | null;
  notificationMessage: string | null;
}

export function parseCodexHeartbeatAssistantMessage(
  text: string | null | undefined,
): CodexHeartbeatAssistantMessage | null {
  const reply = parseAutomationHeartbeatReply(text);
  return reply
    ? {
        decision: reply.decision,
        visibleText: reply.body || null,
        notificationMessage: reply.message,
      }
    : null;
}
