import type { CodexDynamicToolCallView } from "../../../../lib/types";
import { isLikelyJsonText } from "./dynamic-tool-call-utils";

/** One titled text panel in an expanded fallback tool row. */
export interface DynamicToolDetailPanel {
  readonly title: string;
  readonly text: string;
}

/**
 * Text the caller authored, such as a script or a prompt, reads verbatim under its own name. Other
 * arguments are the call's plumbing and stay with its exact record.
 */
export function buildDynamicToolAuthoredPanels(
  call: CodexDynamicToolCallView,
): DynamicToolDetailPanel[] {
  const args = call.arguments;
  if (typeof args === "string") return args.trim() ? [{ title: "Input", text: args }] : [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  if (call.tool === "js" && typeof record.code === "string")
    return [{ title: "javascript", text: record.code }];
  return Object.entries(record).flatMap(([key, value]) =>
    typeof value === "string" && value.includes("\n") ? [{ title: key, text: value }] : [],
  );
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
