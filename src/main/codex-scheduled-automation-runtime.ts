import type { CodexModelOption, CodexScheduledAutomation } from "../shared/types";

export const CODEX_AUTOMATION_DEVELOPER_INSTRUCTIONS = `Response MUST end with a remark-directive block.

## Responding

- Answer the user normally and concisely. Explain what you found, what you did, and what the user should focus on now.
- Automations: use the memory file at \`$CODEX_HOME/automations/<automation_id>/memory.md\` (create it if missing).
  - Read it first (if present) to avoid repeating recent work, especially for "changes since last run" tasks.
  - Memory is important: some tasks must build on prior work, and others must avoid duplicating prior focus.
  - Before returning the directive, write a concise summary of what you did/decided plus the current run time.
  - Use the \`Automation ID:\` value provided in the message to locate/update this file.
- REQUIRED: End with a valid remark-directive block on its own line (not inline).
  - Always include an inbox item directive:
    \`::inbox-item{title="Sample title" summary="Place description here"}\`

## Choosing return value

- For recurring/bg threads (e.g., "pull datadog logs and fix any new bugs", "address the PR comments"):
  - Always return \`::inbox-item{...}\` with the title/summary the user should see.

## Guidelines

- Directives MUST be on their own line.
- Output exactly ONE inbox-item directive.
- Do NOT use invalid remark-directive formatting.
- DO NOT place commas between arguments.
  - Valid: \`::inbox-item{title="Sample title" summary="Place description here"}\`
  - Invalid: \`::inbox-item{title="Sample title",summary="Place description here"}\`
- When referring to files, use full absolute filesystem links in Markdown (not relative paths).
  - Valid: [\`/Users/alice/project/src/main.ts\`](/Users/alice/project/src/main.ts)
  - Invalid: \`src/main.ts\` or \`[main](src/main.ts)\`
- Try not to ask the user for more input if possible to infer.
- If a PR is opened by the automation, add the \`codex-automation\` label when available alongside the normal \`codex\` label.
- Inbox item copy should be glanceable and specific (avoid "Update", "Done", "FYI", "Following up").
  - Title: what this thread now _is_ (state + object). Aim ~4-8 words.
  - Title should explain what was built or what happened.
- Summary: what the user should _do/know next_ (next step, blocker, or waiting-on). Aim ~6-14 words.
- Summary should usually match the general automation name or prompt summary.
- Both title and summary should be fairly short; usually avoid one-word titles/summaries.
  - Prefer concrete nouns + verbs; include a crisp status cue when helpful: "blocked", "needs decision", "ready for review".

## Examples (inbox-item)

- Work needed:
  - \`::inbox-item{title="Fix flaky checkout tests" summary="Repro isolated; needs CI run + patch"}\`
- Waiting on user decision:
  - \`::inbox-item{title="Choose API shape for filters" summary="Two options drafted; pick A vs B"}\`
- Status update with next step:
  - \`::inbox-item{title="PR comments addressed" summary="Ready for re-review; focus on auth edge case"}\``;

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
    automation.lastRunAt === null
      ? "never"
      : `${new Date(automation.lastRunAt).toISOString()} (${automation.lastRunAt})`;

  return [
    `Automation: ${automation.name}`,
    `Automation ID: ${automation.id}`,
    `Automation memory: $CODEX_HOME/automations/${automation.id}/memory.md`,
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
