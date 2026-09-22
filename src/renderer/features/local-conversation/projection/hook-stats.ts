import type { CodexCanonicalHookRun } from "../../../../shared/codex-conversation-state/codex-conversation-state";

type Run = CodexCanonicalHookRun["run"];
type VisibleEntry = { kind: Exclude<Run["entries"][number]["kind"], "context">; text: string };
export interface HookRunPresentation {
  id: string;
  eventName: Run["eventName"];
  source: Run["source"];
  statusMessage: string | null;
  entries: Array<{ tone: "error" | "warning"; text: string }>;
  count: number;
}
export interface HookStats {
  count: number;
  blockedCount: number;
  blockedMessages: string[];
  blockedSources: Run["source"][];
  errorCount: number;
  entries: VisibleEntry[];
  runs: HookRunPresentation[];
}

/** Turn sidecars own hook metadata; context output never becomes transcript content. */
export function buildHookStats(
  hooks: readonly CodexCanonicalHookRun[] | undefined,
): HookStats | null {
  if (!hooks?.length) return null;
  const stats: HookStats = {
    count: hooks.length,
    blockedCount: 0,
    blockedMessages: [],
    blockedSources: [],
    errorCount: 0,
    entries: [],
    runs: [],
  };
  for (const { id, run } of hooks) {
    const entries = run.entries.flatMap((entry): VisibleEntry[] =>
      entry.kind === "context" ? [] : [{ kind: entry.kind, text: entry.text }],
    );
    stats.entries.push(...entries);
    if (run.status === "blocked") {
      stats.blockedCount += 1;
      if (run.eventName === "userPromptSubmit") {
        stats.blockedSources.push(run.source);
        stats.blockedMessages.push(
          ...entries.flatMap((entry) =>
            entry.kind === "feedback" && entry.text.trim() ? [entry.text.trim()] : [],
          ),
        );
      }
    }
    if (run.status === "failed") stats.errorCount += 1;
    const row: HookRunPresentation = {
      id,
      eventName: run.eventName,
      source: run.source,
      statusMessage: run.statusMessage?.trim() || null,
      entries: entries.map((entry) => ({
        tone: entry.kind === "warning" ? "warning" : "error",
        text: entry.text,
      })),
      count: 1,
    };
    const previous = stats.runs.at(-1);
    if (
      previous &&
      previous.eventName === row.eventName &&
      previous.source === row.source &&
      previous.statusMessage === row.statusMessage &&
      previous.entries.length === row.entries.length &&
      previous.entries.every(
        (entry, index) =>
          entry.tone === row.entries[index]?.tone && entry.text === row.entries[index]?.text,
      )
    ) {
      previous.count += 1;
      continue;
    }
    stats.runs.push(row);
  }
  return stats;
}
