import type { CodexModelOption, CodexScheduledAutomation } from "../shared/types";

export interface CodexAutomationInboxItemDirective {
  title: string;
  summary: string;
}

export function buildCodexProjectlessThreadInstructions(input: {
  cwd: string;
  outputDirectory: string | null;
  workspaceBrowserRoot: string | null;
}): string {
  const outputRoot = input.outputDirectory ?? input.workspaceBrowserRoot ?? input.cwd;
  const splitOutputDirectory =
    input.outputDirectory !== null && input.outputDirectory !== input.cwd;

  return [
    "### Projectless Chat",
    "This projectless thread starts in a generated directory under the user's Documents/Nodex folder.",
    "Prefer answering inline in chat unless using local files would make the result more useful.",
    splitOutputDirectory
      ? `Use work/ for intermediate files, scratch analysis, scripts, drafts, and temporary assets. Use ${outputRoot} only for user-facing deliverables that should appear as outputs.`
      : `When using local files for this projectless thread, write scratch files, drafts, generated assets, and other outputs under ${outputRoot}.`,
    splitOutputDirectory
      ? `When referring to saved deliverables in the final response, link only files from ${outputRoot}.`
      : null,
    "Do not write directly in the home directory unless the user explicitly asks.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export interface CodexScheduledAutomationModelSettings {
  model: string | null;
  reasoningEffort: string | null;
}

export function buildCodexScheduledAutomationRunPrompt(
  automation: Pick<CodexScheduledAutomation, "id" | "name" | "prompt" | "lastRunAt">,
): string {
  const lastRun =
    automation.lastRunAt === null ? "never" : new Date(automation.lastRunAt).toISOString();

  return [
    `Automation: ${automation.name}`,
    `Automation ID: ${automation.id}`,
    `Last run: ${lastRun}`,
    "",
    automation.prompt,
  ].join("\n");
}

export function buildCodexScheduledAutomationHeartbeatPrompt(
  automation: Pick<CodexScheduledAutomation, "id" | "prompt">,
  now = Date.now(),
): string {
  return [
    "<heartbeat>",
    `  <automation_id>${automation.id}</automation_id>`,
    `  <current_time_iso>${new Date(now).toISOString()}</current_time_iso>`,
    "  <instructions>",
    automation.prompt,
    "  </instructions>",
    "</heartbeat>",
  ].join("\n");
}

export function resolveCodexScheduledAutomationModelSettings(input: {
  automation: Pick<CodexScheduledAutomation, "model" | "reasoningEffort">;
  models: readonly CodexModelOption[];
}): CodexScheduledAutomationModelSettings {
  const requestedModel = normalizeModel(input.automation.model);
  const selectedModel = requestedModel
    ? (input.models.find(
        (model) => model.model === requestedModel || model.id === requestedModel,
      ) ?? null)
    : null;
  const fallbackModel =
    selectedModel ??
    input.models.find((model) => model.isDefault) ??
    input.models.find((model) => !model.hidden) ??
    input.models[0] ??
    null;
  const reasoningEffort = resolveReasoningEffort(
    input.automation.reasoningEffort,
    selectedModel ?? fallbackModel,
  );

  return {
    model: fallbackModel?.model ?? requestedModel,
    reasoningEffort,
  };
}

function normalizeModel(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function resolveReasoningEffort(
  requested: string | null | undefined,
  model: CodexModelOption | null,
): string | null {
  const normalized = requested?.trim() ?? "";
  if (normalized.length > 0) {
    if (!model || model.supportedReasoningEfforts.length === 0) return normalized;
    if (model.supportedReasoningEfforts.some((option) => option.reasoningEffort === normalized)) {
      return normalized;
    }
  }

  return model?.defaultReasoningEffort ?? null;
}

export function parseCodexAutomationInboxItemDirective(
  markdown: string,
): CodexAutomationInboxItemDirective | null {
  let parsed: CodexAutomationInboxItemDirective | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*::inbox-item\{(.*)\}\s*$/.exec(line);
    if (!match) continue;

    const attributes = parseRemarkDirectiveAttributes(match[1] ?? "");
    const title = normalizeDirectiveValue(attributes?.title);
    const summary = normalizeDirectiveValue(attributes?.summary);
    if (!title || !summary) continue;

    parsed = { title, summary };
  }

  return parsed;
}

function parseRemarkDirectiveAttributes(source: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    if (source[index] === ",") return null;

    const keyStart = index;
    while (index < source.length && /[A-Za-z0-9_-]/.test(source[index] ?? "")) index += 1;
    const key = source.slice(keyStart, index);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;

    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") return null;
    index += 1;

    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== '"') return null;
    index += 1;

    let value = "";
    let closed = false;
    while (index < source.length) {
      const char = source[index] ?? "";
      if (char === "\\") {
        const next = source[index + 1];
        if (next === undefined) return null;
        value += next;
        index += 2;
        continue;
      }
      if (char === '"') {
        closed = true;
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }
    if (!closed) return null;

    attributes[key] = value;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] === ",") return null;
  }

  return attributes;
}

function normalizeDirectiveValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}
