import type { CodexModelOption, Automation } from "../shared/types";

export interface AutomationInboxItemDirective {
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
    "This projectless thread starts in a directory Nodex generated for it.",
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

export interface AutomationModelSettings {
  model: string | null;
  reasoningEffort: string | null;
}

export interface AutomationRunbook {
  readonly title: string;
  readonly pageKey: string;
  readonly body: string;
}

const runbookInstructions = (runbook?: AutomationRunbook | null): string[] =>
  runbook
    ? [
        "",
        `Runbook: ${runbook.title} (${runbook.pageKey})`,
        runbook.body,
        "You may update this runbook Page with what future runs should know.",
      ]
    : [];

export function buildAutomationRunPrompt(
  automation: Pick<Automation, "id" | "name" | "prompt" | "lastRunAt">,
  instructions = automation.prompt,
  runbook?: AutomationRunbook | null,
): string {
  const lastRun =
    automation.lastRunAt === null ? "never" : new Date(automation.lastRunAt).toISOString();

  return [
    `Automation: ${automation.name}`,
    `Automation ID: ${automation.id}`,
    `Last run: ${lastRun}`,
    "",
    instructions,
    ...runbookInstructions(runbook),
  ].join("\n");
}

export function buildAutomationHeartbeatPrompt(
  automation: Pick<Automation, "id" | "prompt">,
  now = Date.now(),
  instructions = automation.prompt,
  runbook?: AutomationRunbook | null,
): string {
  return [
    "<heartbeat>",
    `  <automation_id>${automation.id}</automation_id>`,
    `  <current_time_iso>${new Date(now).toISOString()}</current_time_iso>`,
    "  <instructions>",
    instructions,
    ...runbookInstructions(runbook),
    "  </instructions>",
    "</heartbeat>",
  ].join("\n");
}

export function resolveAutomationModelSettings(input: {
  automation: Pick<Automation, "model" | "reasoningEffort">;
  models: readonly CodexModelOption[];
}): AutomationModelSettings {
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

export function parseAutomationInboxItemDirective(
  markdown: string,
): AutomationInboxItemDirective | null {
  let parsed: AutomationInboxItemDirective | null = null;

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
