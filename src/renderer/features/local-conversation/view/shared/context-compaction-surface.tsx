import { useEffect, useState } from "react";
import { ContextCompactionIcon } from "@/components/shared/icons";
import {
  CODEX_CONTEXT_COMPACTION_DELAY_NOTICE_MS,
  formatCodexContextCompactionLabel,
  type CodexContextCompactionSource,
} from "../../../../../shared/codex-context-compaction-presentation";
import type { CodexContextCompactionView } from "../../../../../shared/types";
import { resolveCodexThreadDetailLevel } from "../../../../lib/codex-thread-settings";
import { useCodexThreadSettings } from "../../../../lib/use-codex-thread-settings";
import { CodexShimmerText } from "./codex-shimmer-text";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";

/** Context compaction reads as one quiet activity row inside the Turn's work. */
export function ContextCompactionSurface({
  compaction,
}: {
  compaction: CodexContextCompactionView;
}) {
  const { settings } = useCodexThreadSettings();
  const proseSteps = resolveCodexThreadDetailLevel(settings.detailLevel) === "STEPS_PROSE";
  const summary =
    compaction.status === "inProgress" ? (
      <RunningContextCompactionLabel
        key={compaction.startedAtMs ?? "unknown"}
        source={compaction.source}
        startedAtMs={compaction.startedAtMs}
        proseSteps={proseSteps}
      />
    ) : (
      formatCodexContextCompactionLabel({
        status: compaction.status,
        source: compaction.source,
        proseSteps,
      })
    );

  return (
    <ThreadActivityShell
      header={<ThreadRichActivityHeader icon={<ContextCompactionIcon />} summary={summary} />}
    />
  );
}

function RunningContextCompactionLabel({
  source,
  startedAtMs,
  proseSteps,
}: {
  source: CodexContextCompactionSource;
  startedAtMs: number | null;
  proseSteps: boolean;
}) {
  const [showDelayNotice, setShowDelayNotice] = useState(
    () =>
      startedAtMs !== null && Date.now() - startedAtMs >= CODEX_CONTEXT_COMPACTION_DELAY_NOTICE_MS,
  );

  useEffect(() => {
    if (startedAtMs === null || showDelayNotice) return;
    const timeout = window.setTimeout(
      () => setShowDelayNotice(true),
      Math.max(0, startedAtMs + CODEX_CONTEXT_COMPACTION_DELAY_NOTICE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [showDelayNotice, startedAtMs]);

  return (
    <CodexShimmerText className="max-w-full whitespace-normal select-none">
      {formatCodexContextCompactionLabel({
        status: "inProgress",
        source,
        proseSteps,
        showDelayNotice,
      })}
    </CodexShimmerText>
  );
}
