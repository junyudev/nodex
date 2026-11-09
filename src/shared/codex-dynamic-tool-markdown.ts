import type { CodexDynamicToolCallView } from "./types";

type DynamicToolMarkdownInput = Pick<
  CodexDynamicToolCallView,
  "contentItems" | "namespace" | "success" | "tool"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseAnyInputTextJson(call: DynamicToolMarkdownInput): Record<string, unknown> | null {
  for (const item of call.contentItems ?? []) {
    if (item.type !== "inputText") continue;
    const text = item.text.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // Keep scanning; dynamic tools often emit human-readable text before JSON.
    }
  }
  return null;
}

function formatBlock(title: string, lines: readonly string[]): string {
  const body = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return body.length === 0 ? title : `${title}\n\n${body}`;
}

function formatAutomationUpdateMarkdownFallback(call: DynamicToolMarkdownInput): string {
  const parsed = call.success === true ? parseAnyInputTextJson(call) : null;
  return formatBlock("Automation update", [
    `Operation: ${normalizeOptionalString(parsed?.operation) ?? "pending"}`,
    `Automation ID: ${normalizeOptionalString(parsed?.automationId) ?? "pending"}`,
  ]);
}

export function formatDynamicToolCallMarkdownFallback(
  call: DynamicToolMarkdownInput,
): string | null {
  if (call.namespace === "codex_app" && call.tool === "automations_update") {
    return formatAutomationUpdateMarkdownFallback(call);
  }
  return null;
}
