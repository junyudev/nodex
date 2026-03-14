import type { SVGProps } from "react";
import type { CardStatus } from "../../shared/card-status";
import { CARD_STATUS_LABELS } from "../../shared/card-status";
import { cn } from "./utils";

type StatusVisualId = CardStatus | "archived";

type StatusTone = {
  dotColor: string;
  headerBg: string;
  badgeBg: string;
  badgeText: string;
  dropBg: string;
  accentColor: string;
};

type StatusIconPath = {
  d: string;
  fillRule?: "evenodd" | "nonzero";
};

type StatusIconDefinition = {
  viewBox: string;
  paths: StatusIconPath[];
};

const STATUS_ICON_CLASS_NAME = "size-4.5 shrink-0";
const STATUS_CHIP_CLASS_NAME = "inline-flex h-5.5 max-w-full items-center gap-0.5 overflow-hidden rounded-full pl-1 pr-2 text-sm/5 font-normal";

const STATUS_ID_BY_LABEL: Record<string, StatusVisualId> = {
  Draft: "draft",
  Backlog: "backlog",
  "In Progress": "in_progress",
  "In Review": "in_review",
  Done: "done",
  Archived: "archived",
};

const STATUS_ICON_DEFINITIONS: Record<StatusVisualId, StatusIconDefinition> = {
  draft: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M9.501 2.391a8 8 0 0 1 .998 0 .625.625 0 0 1-.081 1.247 7 7 0 0 0-.836 0 .625.625 0 0 1-.08-1.247m3.034 1.053a.625.625 0 0 1 .838-.284q.45.222.863.5a.625.625 0 0 1-.695 1.038 6 6 0 0 0-.722-.417.625.625 0 0 1-.284-.837m-5.072 0a.625.625 0 0 1-.284.837q-.375.185-.722.417a.625.625 0 0 1-.695-1.038q.414-.278.863-.5a.625.625 0 0 1 .838.284m8.009 2.147a.625.625 0 0 1 .867.172q.278.414.5.863a.625.625 0 0 1-1.12.554 6 6 0 0 0-.418-.722.625.625 0 0 1 .171-.867m-10.946 0c.287.192.363.58.171.867q-.232.346-.417.722a.625.625 0 1 1-1.12-.554q.221-.45.499-.863a.625.625 0 0 1 .867-.172m12.418 3.327a.625.625 0 0 1 .664.583 8 8 0 0 1 0 .998.625.625 0 0 1-1.248-.081 6 6 0 0 0 0-.836.625.625 0 0 1 .584-.664m-13.89 0c.345.022.606.32.583.664a7 7 0 0 0 0 .836.625.625 0 0 1-1.247.08 8 8 0 0 1 0-.997.625.625 0 0 1 .664-.583m13.501 3.618c.31.153.437.528.284.838q-.222.45-.5.863a.625.625 0 1 1-1.038-.695q.231-.346.417-.722a.625.625 0 0 1 .837-.284m-13.112 0a.625.625 0 0 1 .837.284q.185.375.417.722a.625.625 0 0 1-1.038.695 8 8 0 0 1-.5-.864.625.625 0 0 1 .284-.837m2.147 2.937a.625.625 0 0 1 .867-.171q.346.231.722.417a.625.625 0 1 1-.554 1.12 8 8 0 0 1-.863-.499.625.625 0 0 1-.172-.867m8.818 0a.625.625 0 0 1-.172.867 8 8 0 0 1-.864.5.625.625 0 0 1-.553-1.12q.375-.187.722-.418a.625.625 0 0 1 .867.171m-5.491 1.472a.625.625 0 0 1 .664-.584 6 6 0 0 0 .836 0 .625.625 0 0 1 .08 1.248 8 8 0 0 1-.997 0 .625.625 0 0 1-.583-.664",
      },
    ],
  },
  backlog: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M8.125 6.625h3.75a.625.625 0 0 1 0 1.25h-3.75a.625.625 0 0 1 0-1.25m0 2.75h3.75a.625.625 0 0 1 0 1.25h-3.75a.625.625 0 0 1 0-1.25m0 2.75h3.75a.625.625 0 0 1 0 1.25h-3.75a.625.625 0 0 1 0-1.25",
      },
      {
        d: "M10 2.375a7.625 7.625 0 1 0 0 15.25 7.625 7.625 0 0 0 0-15.25M3.625 10a6.375 6.375 0 1 1 12.75 0 6.375 6.375 0 0 1-12.75 0",
        fillRule: "evenodd",
      },
    ],
  },
  in_progress: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M8.954 12.856a.718.718 0 0 1-1.079-.62V7.764c0-.554.6-.9 1.08-.62l3.833 2.236a.718.718 0 0 1 0 1.24z",
      },
      {
        d: "M2.375 10a7.625 7.625 0 1 0 15.25 0 7.625 7.625 0 0 0-15.25 0M10 16.375a6.375 6.375 0 1 1 0-12.75 6.375 6.375 0 0 1 0 12.75",
        fillRule: "evenodd",
      },
    ],
  },
  in_review: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M10 2.375a7.625 7.625 0 1 0 0 15.25 7.625 7.625 0 0 0 0-15.25M3.625 10a6.375 6.375 0 1 1 12.75 0 6.375 6.375 0 0 1-12.75 0M6.75 9.25a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0m.875 0a1.625 1.625 0 1 1 3.25 0 1.625 1.625 0 1 1-3.25 0",
        fillRule: "evenodd",
      },
      {
        d: "M11.39 10.61L13.14 12.36A.55.55 0 0 1 12.36 13.14L10.61 11.39A.55.55 0 0 0 11.39 10.61Z",
      },
    ],
  },
  done: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M12.876 7.982a.625.625 0 1 0-1.072-.644L9.25 11.595 7.815 9.92a.625.625 0 0 0-.95.813l2 2.334a.625.625 0 0 0 1.01-.085z",
      },
      {
        d: "M10 2.375a7.625 7.625 0 1 0 0 15.25 7.625 7.625 0 0 0 0-15.25M3.625 10a6.375 6.375 0 1 1 12.75 0 6.375 6.375 0 0 1-12.75 0",
        fillRule: "evenodd",
      },
    ],
  },
  archived: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M5.75 3.25A1.75 1.75 0 0 0 4 5v1.5c0 .83.565 1.528 1.33 1.73A2.75 2.75 0 0 0 5.25 9v4.5a3 3 0 0 0 3 3h3.5a3 3 0 0 0 3-3V9c0-.265-.028-.523-.08-.77A1.75 1.75 0 0 0 16 6.5V5a1.75 1.75 0 0 0-1.75-1.75h-8.5Zm0 1.5h8.5a.25.25 0 0 1 .25.25v1.5a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25V5a.25.25 0 0 1 .25-.25Zm1 3.5V13.5A1.5 1.5 0 0 0 8.25 15h3.5a1.5 1.5 0 0 0 1.5-1.5V8.25h-6.5Zm2.25 1.5a.75.75 0 0 0 0 1.5H11a.75.75 0 0 0 0-1.5H9Z",
        fillRule: "evenodd",
      },
    ],
  },
};

export const columnStyles: Record<string, StatusTone> = {
  draft: {
    dotColor: "bg-[var(--column-ideas-dot)]",
    headerBg: "bg-[var(--column-ideas-header-bg)]",
    badgeBg: "bg-[var(--status-ideas-bg)]",
    badgeText: "text-[var(--status-ideas-text)]",
    dropBg: "bg-[var(--column-ideas-drop-bg)]",
    accentColor: "var(--status-ideas-dot)",
  },
  backlog: {
    dotColor: "bg-[var(--column-backlog-dot)]",
    headerBg: "bg-[var(--column-backlog-header-bg)]",
    badgeBg: "bg-[var(--status-backlog-bg)]",
    badgeText: "text-[var(--status-backlog-text)]",
    dropBg: "bg-[var(--column-backlog-drop-bg)]",
    accentColor: "var(--status-backlog-dot)",
  },
  in_progress: {
    dotColor: "bg-[var(--column-in-progress-dot)]",
    headerBg: "bg-[var(--column-in-progress-header-bg)]",
    badgeBg: "bg-[var(--status-in-progress-bg)]",
    badgeText: "text-[var(--status-in-progress-text)]",
    dropBg: "bg-[var(--column-in-progress-drop-bg)]",
    accentColor: "var(--status-in-progress-dot)",
  },
  in_review: {
    dotColor: "bg-[var(--column-review-dot)]",
    headerBg: "bg-[var(--column-review-header-bg)]",
    badgeBg: "bg-[var(--status-review-bg)]",
    badgeText: "text-[var(--status-review-text)]",
    dropBg: "bg-[var(--column-review-drop-bg)]",
    accentColor: "var(--status-review-dot)",
  },
  done: {
    dotColor: "bg-[var(--column-done-dot)]",
    headerBg: "bg-[var(--column-done-header-bg)]",
    badgeBg: "bg-[var(--status-done-bg)]",
    badgeText: "text-[var(--status-done-text)]",
    dropBg: "bg-[var(--column-done-drop-bg)]",
    accentColor: "var(--status-done-dot)",
  },
  archived: {
    dotColor: "bg-[var(--column-archive-dot)]",
    headerBg: "bg-[var(--column-archive-header-bg)]",
    badgeBg: "bg-[var(--column-archive-badge-bg)]",
    badgeText: "text-[var(--column-archive-badge-text)]",
    dropBg: "bg-[var(--column-archive-drop-bg)]",
    accentColor: "var(--column-archive-dot)",
  },
};

const FALLBACK_STATUS_STYLE: StatusTone = {
  dotColor: "bg-[var(--foreground-tertiary)]",
  headerBg: "bg-[var(--background-secondary)]",
  badgeBg: "bg-[var(--gray-bg)]",
  badgeText: "text-[var(--foreground-secondary)]",
  dropBg: "bg-[var(--background-secondary)]",
  accentColor: "#8E8B86",
};

function resolveStatusVisualId(statusId?: string | null, label?: string | null): StatusVisualId | null {
  if (statusId && statusId in columnStyles) {
    return statusId as StatusVisualId;
  }
  if (label) {
    return STATUS_ID_BY_LABEL[label] ?? null;
  }
  return null;
}

function resolveStatusLabel(statusId: StatusVisualId, label?: string | null): string {
  if (label?.trim()) return label;
  if (statusId === "archived") return "Archived";
  return CARD_STATUS_LABELS[statusId];
}

function appendIconPaths(
  svg: SVGSVGElement,
  definition: StatusIconDefinition,
  documentRef: Document,
): void {
  for (const pathDefinition of definition.paths) {
    const path = documentRef.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", pathDefinition.d);
    path.setAttribute("fill", "currentColor");
    if (pathDefinition.fillRule) {
      path.setAttribute("fill-rule", pathDefinition.fillRule);
      path.setAttribute("clip-rule", pathDefinition.fillRule);
    }
    svg.appendChild(path);
  }
}

export function getStatusStyle(statusId?: string | null, label?: string | null): StatusTone {
  const resolved = resolveStatusVisualId(statusId, label);
  return resolved ? columnStyles[resolved] : FALLBACK_STATUS_STYLE;
}

export function getStatusIdByLabel(label: string): CardStatus | undefined {
  const resolved = STATUS_ID_BY_LABEL[label];
  return resolved && resolved !== "archived" ? resolved : undefined;
}

export function getStatusAccentColorByLabel(label: string): string | undefined {
  const resolved = resolveStatusVisualId(undefined, label);
  return resolved ? columnStyles[resolved].accentColor : undefined;
}

export function getStatusDotColor(label: string): string | undefined {
  return getStatusAccentColorByLabel(label);
}

export function getStatusChipClassName(statusId?: string | null, label?: string | null): string {
  const style = getStatusStyle(statusId, label);
  return cn(STATUS_CHIP_CLASS_NAME, style.badgeBg, style.badgeText);
}

export function createStatusIconElement(
  statusId?: string | null,
  options?: {
    className?: string;
    label?: string | null;
    documentRef?: Document;
  },
): SVGSVGElement {
  const documentRef = options?.documentRef ?? document;
  const resolved = resolveStatusVisualId(statusId, options?.label) ?? "draft";
  const definition = STATUS_ICON_DEFINITIONS[resolved];
  const style = getStatusStyle(resolved);
  const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("viewBox", definition.viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", [STATUS_ICON_CLASS_NAME, options?.className].filter(Boolean).join(" "));
  svg.style.color = style.accentColor;
  appendIconPaths(svg, definition, documentRef);
  return svg;
}

export function StatusIcon({
  statusId,
  label,
  className,
  style: inlineStyle,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
  statusId?: string | null;
  label?: string | null;
}) {
  const resolved = resolveStatusVisualId(statusId, label) ?? "draft";
  const definition = STATUS_ICON_DEFINITIONS[resolved];
  const tone = getStatusStyle(resolved);

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={definition.viewBox}
      fill="none"
      className={cn(STATUS_ICON_CLASS_NAME, className)}
      {...props}
      style={{ color: tone.accentColor, ...inlineStyle }}
    >
      {definition.paths.map((pathDefinition, index) => (
        <path
          key={`${resolved}:${index}`}
          d={pathDefinition.d}
          fill="currentColor"
          fillRule={pathDefinition.fillRule}
          clipRule={pathDefinition.fillRule}
        />
      ))}
    </svg>
  );
}

export function StatusChip({
  statusId,
  label,
  className,
  labelClassName,
  iconClassName,
}: {
  statusId?: string | null;
  label?: string | null;
  className?: string;
  labelClassName?: string;
  iconClassName?: string;
}) {
  const resolved = resolveStatusVisualId(statusId, label) ?? "draft";
  const chipLabel = resolveStatusLabel(resolved, label);
  const style = getStatusStyle(resolved);

  return (
    <span className={cn(STATUS_CHIP_CLASS_NAME, style.badgeBg, style.badgeText, className)}>
      <StatusIcon statusId={resolved} className={iconClassName} />
      <span className={cn("truncate", labelClassName)}>{chipLabel}</span>
    </span>
  );
}
