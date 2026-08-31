import type { HookEventName } from "@nodex/codex-app-server-protocol/v2/HookEventName";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import type { CodexHooksSettingsSelection, CodexHooksSettingsSource } from "./codex-hooks-route";
import { normalizeCodexHooksSettingsSource } from "./codex-hooks-route";

export const CODEX_HOOK_EVENT_ORDER: readonly HookEventName[] = [
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
  "interrupt",
];

export const CODEX_HOOK_SOURCE_ORDER: readonly CodexHooksSettingsSource[] = [
  "plugin",
  "user",
  "admin",
  "project",
  "sessionFlags",
  "unknown",
];

export interface CodexHooksSourceEntry extends HooksListEntry {
  selection: CodexHooksSettingsSelection;
}

export interface CodexHooksSourceSection {
  source: CodexHooksSettingsSource;
  entry?: CodexHooksSourceEntry;
  pluginEntries?: CodexHooksSourceEntry[];
  projectEntries?: CodexHooksSourceEntry[];
}

export interface CodexHookEventSummary {
  eventName: HookEventName;
  active: number;
  installed: number;
  needsReview: number;
}

export function doesCodexHookNeedReview(hook: HookMetadata): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

export function isCodexHookActive(hook: HookMetadata): boolean {
  return hook.trustStatus === "managed" || (hook.enabled && hook.trustStatus === "trusted");
}

function dedupeHooks(hooks: readonly HookMetadata[]): HookMetadata[] {
  const hooksByKey = new Map<string, HookMetadata>();
  for (const hook of hooks) {
    if (!hooksByKey.has(hook.key)) hooksByKey.set(hook.key, hook);
  }
  return Array.from(hooksByKey.values());
}

function dedupeErrors(errors: readonly HooksListEntry["errors"][number][]) {
  const errorsByIdentity = new Map<string, HooksListEntry["errors"][number]>();
  for (const error of errors) {
    errorsByIdentity.set(`${error.path}:${error.message}`, error);
  }
  return Array.from(errorsByIdentity.values());
}

function aggregateHooksEntry(
  entries: readonly HooksListEntry[],
  hooks: readonly HookMetadata[],
  extraIssueEntries: readonly HooksListEntry[] = [],
): HooksListEntry {
  const dedupedHooks = dedupeHooks(hooks);
  const hookKeys = new Set(dedupedHooks.map((hook) => hook.key));
  const contributingEntries = [
    ...entries.filter((entry) => entry.hooks.some((hook) => hookKeys.has(hook.key))),
    ...extraIssueEntries,
  ];

  return {
    cwd: "",
    hooks: dedupedHooks,
    warnings: Array.from(new Set(contributingEntries.flatMap((entry) => entry.warnings))),
    errors: dedupeErrors(contributingEntries.flatMap((entry) => entry.errors)),
  };
}

function withSelection(
  entry: HooksListEntry,
  selection: CodexHooksSettingsSelection,
): CodexHooksSourceEntry {
  return { ...entry, selection };
}

function buildProjectSection(entries: readonly HooksListEntry[]): CodexHooksSourceSection | null {
  const projectEntries = entries.flatMap((entry): CodexHooksSourceEntry[] => {
    const hooks = entry.hooks.filter(
      (hook) => normalizeCodexHooksSettingsSource(hook.source) === "project",
    );
    if (hooks.length === 0) return [];
    return [withSelection({ ...entry, hooks }, { source: "project", projectRoot: entry.cwd })];
  });

  return projectEntries.length === 0 ? null : { source: "project", projectEntries };
}

function buildPluginSection(entries: readonly HooksListEntry[]): CodexHooksSourceSection | null {
  const pluginHooks = entries.flatMap((entry) =>
    entry.hooks.filter((hook) => normalizeCodexHooksSettingsSource(hook.source) === "plugin"),
  );
  if (pluginHooks.length === 0) return null;

  const hooksByPlugin = new Map<string | null, HookMetadata[]>();
  for (const hook of pluginHooks) {
    const current = hooksByPlugin.get(hook.pluginId) ?? [];
    current.push(hook);
    hooksByPlugin.set(hook.pluginId, current);
  }

  const pluginEntries = Array.from(hooksByPlugin.entries())
    .sort(([left], [right]) => (left == null ? 1 : right == null ? -1 : left.localeCompare(right)))
    .map(([pluginId, hooks]) =>
      withSelection(aggregateHooksEntry(entries, hooks), { source: "plugin", pluginId }),
    );

  return {
    source: "plugin",
    entry: withSelection(aggregateHooksEntry(entries, pluginHooks), { source: "plugin" }),
    pluginEntries,
  };
}

function buildAggregateSection(
  entries: readonly HooksListEntry[],
  source: Exclude<CodexHooksSettingsSource, "plugin" | "project">,
): CodexHooksSourceSection | null {
  const hooks = entries.flatMap((entry) =>
    entry.hooks.filter((hook) => normalizeCodexHooksSettingsSource(hook.source) === source),
  );
  const extraIssueEntries =
    source === "unknown"
      ? entries.filter(
          (entry) =>
            entry.hooks.length === 0 && (entry.warnings.length > 0 || entry.errors.length > 0),
        )
      : [];
  if (hooks.length === 0 && extraIssueEntries.length === 0) return null;

  return {
    source,
    entry: withSelection(aggregateHooksEntry(entries, hooks, extraIssueEntries), { source }),
  };
}

export function groupCodexHooksListEntries(
  entries: readonly HooksListEntry[],
): CodexHooksSourceSection[] {
  return CODEX_HOOK_SOURCE_ORDER.flatMap((source): CodexHooksSourceSection[] => {
    if (source === "project") {
      const section = buildProjectSection(entries);
      return section ? [section] : [];
    }
    if (source === "plugin") {
      const section = buildPluginSection(entries);
      return section ? [section] : [];
    }

    const section = buildAggregateSection(entries, source);
    return section ? [section] : [];
  });
}

function selectionsEqual(
  left: CodexHooksSettingsSelection,
  right: CodexHooksSettingsSelection,
): boolean {
  if (left.source !== right.source) return false;
  if (left.source === "project" && right.source === "project") {
    return left.projectRoot === right.projectRoot;
  }
  if (left.source === "plugin" && right.source === "plugin") {
    return left.pluginId === right.pluginId;
  }
  return true;
}

export function resolveSelectedCodexHooksEntry(
  sections: readonly CodexHooksSourceSection[],
  selection: CodexHooksSettingsSelection | null,
): CodexHooksSourceEntry | null {
  if (!selection) return null;
  const section = sections.find((candidate) => candidate.source === selection.source);
  if (!section) return null;

  if (selection.source === "project") {
    return (
      section.projectEntries?.find((entry) => selectionsEqual(entry.selection, selection)) ?? null
    );
  }
  if (selection.source === "plugin" && selection.pluginId !== undefined) {
    return (
      section.pluginEntries?.find((entry) => selectionsEqual(entry.selection, selection)) ?? null
    );
  }
  return section.entry ?? null;
}

export function summarizeCodexHookEvents(hooks: readonly HookMetadata[]): CodexHookEventSummary[] {
  return CODEX_HOOK_EVENT_ORDER.map((eventName) => {
    const eventHooks = hooks.filter((hook) => hook.eventName === eventName);
    return {
      eventName,
      active: eventHooks.filter(isCodexHookActive).length,
      installed: eventHooks.length,
      needsReview: eventHooks.filter(doesCodexHookNeedReview).length,
    };
  });
}

export function sortCodexHooksForEvent(
  hooks: readonly HookMetadata[],
  eventName: HookEventName,
): HookMetadata[] {
  return hooks
    .filter((hook) => hook.eventName === eventName)
    .sort((left, right) =>
      left.displayOrder < right.displayOrder ? -1 : left.displayOrder > right.displayOrder ? 1 : 0,
    );
}
