import type { OrchestrationMessageContext } from "@t3tools/contracts";

const ENVELOPE_TAG = "nodex_context";
const ENTRY_TAG = "context";
const ENVELOPE_MARKUP = new RegExp(String.raw`<(?=/?(?:${ENVELOPE_TAG}|${ENTRY_TAG})\b)`, "gi");

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * What the provider reads: the user's words, then every record once inside an envelope that marks
 * it as data. Captured text cannot close the envelope and forge a record of its own.
 */
export function projectMessageForProvider(message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): string {
  const records = message.context?.records ?? [];
  if (records.length === 0) return message.text;
  const entries = records.map((record) => {
    const body = JSON.stringify(record.payload).replace(ENVELOPE_MARKUP, "&lt;");
    return `<${ENTRY_TAG} kind="${escapeAttribute(record.kind)}" label="${escapeAttribute(record.label)}">\n${body}\n</${ENTRY_TAG}>`;
  });
  const envelope = `<${ENVELOPE_TAG}>\n${entries.join("\n")}\n</${ENVELOPE_TAG}>`;
  return message.text === "" ? envelope : `${message.text}\n\n${envelope}`;
}
