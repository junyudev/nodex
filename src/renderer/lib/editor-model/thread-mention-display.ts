import { presentSessionTitle } from "@/lib/session-title-presentation";
import { getIntl } from "@/lib/i18n";
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
  intl: ReturnType<typeof getIntl>,
): string {
  if (resolving)
    return intl.formatMessage({
      id: "lib.threadMentionDisplay.loading",
      defaultMessage: "Loading",
    });
  if (missing)
    return intl.formatMessage({
      id: "lib.threadMentionDisplay.missing",
      defaultMessage: "Missing",
    });
  if (!thread)
    return intl.formatMessage({
      id: "lib.threadMentionDisplay.thread",
      defaultMessage: "Thread",
    });
  return resolveThreadStatusDisplayLabel(thread);
}

export function resolveThreadMentionDisplay(
  input: ThreadMentionDisplayInput,
  intl = getIntl(),
): ThreadMentionDisplay {
  const uuid = input.uuid.trim();
  const thread = input.thread ?? null;
  const resolving = input.resolving === true;
  const missing = input.missing === true;
  const label = missing
    ? intl.formatMessage({
        id: "lib.threadMentionDisplay.missingThread",
        defaultMessage: "Missing thread",
      })
    : presentSessionTitle(
        resolveCodexElectronDisplayThreadTitle({
          threadName: thread?.threadName,
          threadPreview: thread?.threadPreview,
          fallback: formatThreadMentionShortUuid(uuid),
        }),
        intl,
      );
  const stateLabel = resolveThreadStateLabel(thread, resolving, missing, intl);
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
