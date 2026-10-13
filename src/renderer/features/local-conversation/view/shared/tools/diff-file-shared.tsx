import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ChevronRightIcon } from "../../../../../components/shared/icons";
import { NodexTooltip } from "../../../../../components/ui/tooltip";
import { cn } from "../../../../../lib/utils";
import { summarizeUnifiedDiffChanges } from "../../../../../lib/unified-diff-summary";
import { basename } from "@/lib/file-path";
export {
  basename,
  normalizePathSegments,
  normalizeSlashes,
  resolveOpenPath,
  stripPatchPrefix,
} from "@/lib/file-path";

export interface DiffSummary {
  additions: number;
  deletions: number;
}

export function summarizeFileDiffMetadata(fileDiff: FileDiffMetadata): DiffSummary {
  return fileDiff.hunks.reduce(
    (summary, hunk) => ({
      additions: summary.additions + hunk.additionLines,
      deletions: summary.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function summarizeDiff(diffText: string | undefined): DiffSummary {
  return summarizeUnifiedDiffChanges(diffText);
}

export function DiffStats({
  additions,
  deletions,
  className,
  showZero = false,
}: DiffSummary & {
  className?: string;
  showZero?: boolean;
}) {
  if (!showZero && additions === 0 && deletions === 0) return null;

  return (
    <span
      data-thread-find-skip="true"
      className={cn(
        "inline-flex items-center gap-1 disambiguated-digits tabular-nums tracking-tight",
        className,
      )}
    >
      <span className="flex shrink-0 items-center text-token-git-decoration-added-resource-foreground">
        +{additions}
      </span>
      <span className="flex shrink-0 items-center text-token-git-decoration-deleted-resource-foreground">
        -{deletions}
      </span>
    </span>
  );
}

function formatDiffNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, value));
}

function diffNumberParts(formatted: string) {
  let digitPlace = 0;
  return Array.from(formatted)
    .reverse()
    .map((char, indexFromRight) => {
      if (!/\d/.test(char)) {
        return {
          key: `separator-${indexFromRight}-${char}`,
          char,
          digit: null,
        };
      }

      const part = {
        key: `digit-${digitPlace}`,
        char,
        digit: Number(char),
      };
      digitPlace += 1;
      return part;
    })
    .reverse();
}

function AnimatedDiffNumber({ value }: { value: number }) {
  const formatted = formatDiffNumber(value);
  const parts = diffNumberParts(formatted);
  return (
    <>
      {parts.map((part) => {
        if (part.digit === null) {
          return <span key={part.key}>{part.char}</span>;
        }

        return (
          <span
            key={part.key}
            className="diff-stat-digit-column"
            data-diff-stat-digit-place={
              part.key.startsWith("digit-") ? part.key.slice("digit-".length) : undefined
            }
            aria-hidden="true"
          >
            <span className={`diff-stat-digit-stack diff-stat-digit-stack-${part.digit}`}>
              {Array.from({ length: 10 }, (_, digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </span>
          </span>
        );
      })}
      <span className="sr-only">{formatted}</span>
    </>
  );
}

export function AnimatedDiffStats({
  additions,
  deletions,
  className,
}: DiffSummary & {
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <span
      data-thread-find-skip="true"
      className={cn(
        "inline-flex items-center gap-1 disambiguated-digits tabular-nums tracking-tight",
        className,
      )}
    >
      <span
        className="flex flex-shrink-0 items-center text-token-git-decoration-added-resource-foreground"
        data-diff-stat-kind="additions"
      >
        +<AnimatedDiffNumber value={additions} />
      </span>
      <span
        className="flex flex-shrink-0 items-center text-token-git-decoration-deleted-resource-foreground"
        data-diff-stat-kind="deletions"
      >
        -<AnimatedDiffNumber value={deletions} />
      </span>
    </span>
  );
}

export function Chevron({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-chevron ml-1 text-token-input-placeholder-foreground transition-opacity duration-200 opacity-0 group-hover/activity-header:opacity-100",
        expanded && "opacity-100",
        className,
      )}
    >
      <ChevronRightIcon
        className={cn("text-current transition-transform duration-200", expanded && "rotate-90")}
      />
    </span>
  );
}

export function FilenameButton({
  displayPath,
  onOpen,
  dataState,
  className,
}: {
  displayPath: string;
  onOpen: ((intent?: FilenameOpenIntent) => void) | null;
  dataState?: "open" | "closed";
  className: string;
}) {
  const button = (
    <button
      type="button"
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ? "external" : "primary",
        );
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.("durable");
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen?.("external");
      }}
      data-state={dataState}
      disabled={!onOpen}
    >
      {basename(displayPath)}
    </button>
  );

  return (
    <NodexTooltip
      tooltipContent={<span className="font-mono">{displayPath}</span>}
      side="top"
      delay={0}
      tooltipBodyClassName="font-mono text-xs leading-4"
    >
      {button}
    </NodexTooltip>
  );
}

export type FilenameOpenIntent = "primary" | "durable" | "external";
