import type { CodexThreadSummary } from "@/lib/types";
import { resolveThreadStatusDisplayLabel } from "@/lib/thread-status-display";
import { resolveCodexElectronDisplayThreadTitle } from "../../../shared/codex-thread-title";

export type ThreadMentionTone = "normal" | "muted" | "error";

export interface ThreadMentionDisplayInput {
  uuid: string;
  thread?: CodexThreadSummary | null;
  resolving?: boolean;
  missing?: boolean;
}

export interface ThreadMentionDisplay {
  label: string;
  detail: string;
  stateLabel: string;
  shortUuid: string;
  title: string;
  tone: ThreadMentionTone;
}

export function formatThreadMentionShortUuid(uuid: string): string {
  const trimmed = uuid.trim();
  if (trimmed.length <= 12) return trimmed || "unknown";
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function resolveThreadStateLabel(
  thread: CodexThreadSummary | null,
  resolving: boolean,
  missing: boolean,
): string {
  if (resolving) return "Loading";
  if (missing) return "Missing";
  if (!thread) return "Thread";
  return resolveThreadStatusDisplayLabel(thread);
}

export function resolveThreadMentionDisplay(
  input: ThreadMentionDisplayInput,
): ThreadMentionDisplay {
  const uuid = input.uuid.trim();
  const thread = input.thread ?? null;
  const resolving = input.resolving === true;
  const missing = input.missing === true;
  const label = missing
    ? "Missing thread"
    : resolveCodexElectronDisplayThreadTitle({
        threadName: thread?.threadName,
        threadPreview: thread?.threadPreview,
        fallback: formatThreadMentionShortUuid(uuid),
      });
  const stateLabel = resolveThreadStateLabel(thread, resolving, missing);
  const shortUuid = formatThreadMentionShortUuid(uuid);
  const detail = [stateLabel, shortUuid].filter((value) => value.trim().length > 0).join(" · ");
  const title = [label, detail, thread?.cwd ?? ""]
    .filter((value) => value.trim().length > 0)
    .join(" - ");
  const tone =
    missing || thread?.statusType === "systemError"
      ? "error"
      : thread?.archived || resolving
        ? "muted"
        : "normal";

  return { label, detail, stateLabel, shortUuid, title, tone };
}
