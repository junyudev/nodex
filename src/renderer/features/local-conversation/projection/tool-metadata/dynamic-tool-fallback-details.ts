import type { CodexDynamicToolCallView } from "../../../../lib/types";
import { isLikelyJsonText, resolveDynamicToolFallbackLabel } from "./dynamic-tool-call-utils";
import { humanizeIdentifier } from "./tool-call-utils";

/** One titled text panel in an expanded fallback tool row. */
export interface DynamicToolDetailPanel {
  readonly title: string;
  readonly text: string;
}

function identityWords(value: string): string[] {
  return humanizeIdentifier(value.replace(/[^\p{L}\p{N}]+/gu, " "))
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** The qualified tool name, unless the activity label already names every part of it. */
export function resolveDynamicToolFallbackIdentity(call: CodexDynamicToolCallView): string | null {
  const identity = [call.namespace, call.tool].filter(Boolean).join(".");
  const labelWords = new Set(identityWords(resolveDynamicToolFallbackLabel(call)));
  return identityWords(identity).every((word) => labelWords.has(word)) ? null : identity;
}

function stringifyArguments(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Multi-line string arguments are authored text such as scripts and prompts, so they read
 * verbatim under their own name. Remaining arguments stay together as formatted JSON.
 */
export function buildDynamicToolArgumentPanels(
  call: CodexDynamicToolCallView,
): DynamicToolDetailPanel[] {
  const args = call.arguments;
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null;
  if (call.tool === "js" && typeof record?.code === "string") {
    return [{ title: "javascript", text: record.code }];
  }
  if (args === null || args === undefined) return [];
  if (typeof args === "string") return args.trim() ? [{ title: "Arguments", text: args }] : [];
  if (!record) return [{ title: "Arguments", text: stringifyArguments(args) }];

  const fields: Record<string, unknown> = {};
  const texts: DynamicToolDetailPanel[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.includes("\n")) texts.push({ title: key, text: value });
    else fields[key] = value;
  }
  return Object.keys(fields).length > 0
    ? [{ title: "Arguments", text: stringifyArguments(fields) }, ...texts]
    : texts;
}

/**
 * Indents compact JSON without reparsing its values, so large numbers and escapes display exactly
 * as the tool returned them. Other text is returned unchanged.
 */
export function formatToolOutputText(text: string): string {
  if (!isLikelyJsonText(text)) return text;
  const source = text.trim();
  let output = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (/\s/.test(char)) continue;
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]";
      const next = source.slice(index + 1).trimStart()[0];
      if (next === close) {
        output += `${char}${close}`;
        index = source.indexOf(close, index + 1);
      } else {
        depth += 1;
        output += `${char}${newline()}`;
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
      output += `${newline()}${char}`;
    } else if (char === ",") {
      output += `,${newline()}`;
    } else if (char === ":") {
      output += ": ";
    } else {
      output += char;
    }
  }
  return output;
}
