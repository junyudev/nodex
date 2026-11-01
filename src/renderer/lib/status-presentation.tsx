import type { SVGProps } from "react";
import type { WorkflowStatus } from "../../shared/workflow-status";
import { isWorkflowStatus, resolveWorkflowStatusName } from "../../shared/workflow-status";
import { cn } from "./utils";

type StatusVisualId = WorkflowStatus | "archived";

type StatusTone = {
  dotColor: string;
  headerBg: string;
  dropBg: string;
  accentColor: string;
};

type StatusIconPath = {
  kind: "path";
  d: string;
  fill: "currentColor" | "none";
  stroke?: "currentColor" | "none";
  strokeWidth?: number;
  transform?: string;
  fillRule?: "evenodd" | "nonzero";
};

type StatusIconRect = {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  fill: "currentColor" | "none";
  stroke: "currentColor" | "none";
  strokeWidth: number;
};

type StatusIconShape = StatusIconPath | StatusIconRect;

type StatusIconDefinition = {
  viewBox: string;
  shapes: readonly StatusIconShape[];
};

const STATUS_ICON_CLASS_NAME = "size-3.5 shrink-0";
const STATUS_LABEL_CLASS_NAME =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm/5 font-normal text-token-text-primary";

const WORKFLOW_ICON_VIEW_BOX = "0 0 14 14";
const PROGRESS_ICON_RADIUS = 3.5;

function createProgressIconDefinition(percentage: number): StatusIconDefinition {
  const degrees = 360 * percentage;
  const projectedDegrees = degrees > 180 ? 360 - degrees : degrees;
  const radians = (projectedDegrees * Math.PI) / 180;
  const chord = Math.sqrt(
    2 * PROGRESS_ICON_RADIUS * PROGRESS_ICON_RADIUS -
      2 * PROGRESS_ICON_RADIUS * PROGRESS_ICON_RADIUS * Math.cos(radians),
  );
  const horizontalOffset =
    projectedDegrees <= 90
      ? PROGRESS_ICON_RADIUS * Math.sin(radians)
      : PROGRESS_ICON_RADIUS * Math.sin(((180 - projectedDegrees) * Math.PI) / 180);
  const verticalOffset = Math.sqrt(chord * chord - horizontalOffset * horizontalOffset);
  const arcEndX =
    degrees <= 180
      ? PROGRESS_ICON_RADIUS + horizontalOffset
      : PROGRESS_ICON_RADIUS - horizontalOffset;
  const largeArcFlag = degrees <= 180 ? 0 : 1;

  return {
    viewBox: WORKFLOW_ICON_VIEW_BOX,
    shapes: [
      {
        kind: "rect",
        x: 1,
        y: 1,
        width: 12,
        height: 12,
        rx: 6,
        stroke: "currentColor",
        strokeWidth: 1.5,
        fill: "none",
      },
      {
        kind: "path",
        d: `M ${PROGRESS_ICON_RADIUS},${PROGRESS_ICON_RADIUS} L${PROGRESS_ICON_RADIUS},0 A${PROGRESS_ICON_RADIUS},${PROGRESS_ICON_RADIUS} 0 ${largeArcFlag},1 ${arcEndX}, ${verticalOffset} z`,
        transform: `translate(${PROGRESS_ICON_RADIUS},${PROGRESS_ICON_RADIUS})`,
        fill: "currentColor",
        stroke: "none",
      },
    ],
  };
}

const STATUS_ICON_DEFINITIONS: Record<StatusVisualId, StatusIconDefinition> = {
  triage: {
    viewBox: WORKFLOW_ICON_VIEW_BOX,
    shapes: [
      {
        kind: "path",
        d: "M13.9408 7.91426L11.9576 7.65557C11.9855 7.4419 12 7.22314 12 7C12 6.77686 11.9855 6.5581 11.9576 6.34443L13.9408 6.08573C13.9799 6.38496 14 6.69013 14 7C14 7.30987 13.9799 7.61504 13.9408 7.91426ZM13.4688 4.32049C13.2328 3.7514 12.9239 3.22019 12.5538 2.73851L10.968 3.95716C11.2328 4.30185 11.4533 4.68119 11.6214 5.08659L13.4688 4.32049ZM11.2615 1.4462L10.0428 3.03204C9.69815 2.76716 9.31881 2.54673 8.91341 2.37862L9.67951 0.531163C10.2486 0.767153 10.7798 1.07605 11.2615 1.4462ZM7.91426 0.0591659L7.65557 2.04237C7.4419 2.01449 7.22314 2 7 2C6.77686 2 6.5581 2.01449 6.34443 2.04237L6.08574 0.059166C6.38496 0.0201343 6.69013 0 7 0C7.30987 0 7.61504 0.0201343 7.91426 0.0591659ZM4.32049 0.531164L5.08659 2.37862C4.68119 2.54673 4.30185 2.76716 3.95716 3.03204L2.73851 1.4462C3.22019 1.07605 3.7514 0.767153 4.32049 0.531164ZM1.4462 2.73851L3.03204 3.95716C2.76716 4.30185 2.54673 4.68119 2.37862 5.08659L0.531164 4.32049C0.767153 3.7514 1.07605 3.22019 1.4462 2.73851ZM0.0591659 6.08574C0.0201343 6.38496 0 6.69013 0 7C0 7.30987 0.0201343 7.61504 0.059166 7.91426L2.04237 7.65557C2.01449 7.4419 2 7.22314 2 7C2 6.77686 2.01449 6.5581 2.04237 6.34443L0.0591659 6.08574ZM0.531164 9.67951L2.37862 8.91341C2.54673 9.31881 2.76716 9.69815 3.03204 10.0428L1.4462 11.2615C1.07605 10.7798 0.767153 10.2486 0.531164 9.67951ZM2.73851 12.5538L3.95716 10.968C4.30185 11.2328 4.68119 11.4533 5.08659 11.6214L4.32049 13.4688C3.7514 13.2328 3.22019 12.9239 2.73851 12.5538ZM6.08574 13.9408L6.34443 11.9576C6.5581 11.9855 6.77686 12 7 12C7.22314 12 7.4419 11.9855 7.65557 11.9576L7.91427 13.9408C7.61504 13.9799 7.30987 14 7 14C6.69013 14 6.38496 13.9799 6.08574 13.9408ZM9.67951 13.4688L8.91341 11.6214C9.31881 11.4533 9.69815 11.2328 10.0428 10.968L11.2615 12.5538C10.7798 12.9239 10.2486 13.2328 9.67951 13.4688ZM12.5538 11.2615L10.968 10.0428C11.2328 9.69815 11.4533 9.31881 11.6214 8.91341L13.4688 9.67951C13.2328 10.2486 12.924 10.7798 12.5538 11.2615Z",
        fill: "currentColor",
        stroke: "none",
      },
    ],
  },
  plan: createProgressIconDefinition(0),
  doing: createProgressIconDefinition(0.5),
  review: createProgressIconDefinition(0.75),
  done: {
    viewBox: WORKFLOW_ICON_VIEW_BOX,
    shapes: [
      {
        kind: "path",
        d: "M7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0ZM11.101 5.10104C11.433 4.76909 11.433 4.23091 11.101 3.89896C10.7691 3.56701 10.2309 3.56701 9.89896 3.89896L5.5 8.29792L4.10104 6.89896C3.7691 6.56701 3.2309 6.56701 2.89896 6.89896C2.56701 7.2309 2.56701 7.7691 2.89896 8.10104L4.89896 10.101C5.2309 10.433 5.7691 10.433 6.10104 10.101L11.101 5.10104Z",
        fill: "currentColor",
        fillRule: "evenodd",
      },
    ],
  },
  archived: {
    viewBox: "0 0 20 20",
    shapes: [
      {
        kind: "path",
        d: "M5.75 3.25A1.75 1.75 0 0 0 4 5v1.5c0 .83.565 1.528 1.33 1.73A2.75 2.75 0 0 0 5.25 9v4.5a3 3 0 0 0 3 3h3.5a3 3 0 0 0 3-3V9c0-.265-.028-.523-.08-.77A1.75 1.75 0 0 0 16 6.5V5a1.75 1.75 0 0 0-1.75-1.75h-8.5Zm0 1.5h8.5a.25.25 0 0 1 .25.25v1.5a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25V5a.25.25 0 0 1 .25-.25Zm1 3.5V13.5A1.5 1.5 0 0 0 8.25 15h3.5a1.5 1.5 0 0 0 1.5-1.5V8.25h-6.5Zm2.25 1.5a.75.75 0 0 0 0 1.5H11a.75.75 0 0 0 0-1.5H9Z",
        fill: "currentColor",
        fillRule: "evenodd",
      },
    ],
  },
};

export const columnStyles: Record<string, StatusTone> = {
  triage: {
    dotColor: "bg-[var(--column-triage-dot)]",
    headerBg: "bg-[var(--column-triage-header-bg)]",
    dropBg: "bg-[var(--column-triage-drop-bg)]",
    accentColor: "var(--status-triage-dot)",
  },
  plan: {
    dotColor: "bg-[var(--column-plan-dot)]",
    headerBg: "bg-[var(--column-plan-header-bg)]",
    dropBg: "bg-[var(--column-plan-drop-bg)]",
    accentColor: "var(--status-plan-dot)",
  },
  doing: {
    dotColor: "bg-[var(--column-doing-dot)]",
    headerBg: "bg-[var(--column-doing-header-bg)]",
    dropBg: "bg-[var(--column-doing-drop-bg)]",
    accentColor: "var(--status-doing-dot)",
  },
  review: {
    dotColor: "bg-[var(--column-review-dot)]",
    headerBg: "bg-[var(--column-review-header-bg)]",
    dropBg: "bg-[var(--column-review-drop-bg)]",
    accentColor: "var(--status-review-dot)",
  },
  done: {
    dotColor: "bg-[var(--column-done-dot)]",
    headerBg: "bg-[var(--column-done-header-bg)]",
    dropBg: "bg-[var(--column-done-drop-bg)]",
    accentColor: "var(--status-done-dot)",
  },
  archived: {
    dotColor: "bg-[var(--column-archive-dot)]",
    headerBg: "bg-[var(--column-archive-header-bg)]",
    dropBg: "bg-[var(--column-archive-drop-bg)]",
    accentColor: "var(--column-archive-dot)",
  },
};

const FALLBACK_STATUS_STYLE: StatusTone = {
  dotColor: "bg-[var(--foreground-tertiary)]",
  headerBg: "bg-[var(--background-secondary)]",
  dropBg: "bg-[var(--background-secondary)]",
  accentColor: "#8E8B86",
};

function resolveStatusVisualId(statusId?: string | null): StatusVisualId | null {
  if (isWorkflowStatus(statusId) || statusId === "archived") {
    return statusId;
  }
  return null;
}

function resolveStatusLabel(statusId: StatusVisualId, label?: string | null): string {
  if (label?.trim()) return label;
  if (statusId === "archived") return "Archived";
  return resolveWorkflowStatusName(statusId, []);
}

function setOptionalSvgAttribute(
  element: Element,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined) return;
  element.setAttribute(name, String(value));
}

function appendIconShapes(
  svg: SVGSVGElement,
  definition: StatusIconDefinition,
  documentRef: Document,
): void {
  for (const shape of definition.shapes) {
    const element = documentRef.createElementNS(svg.namespaceURI, shape.kind);
    element.setAttribute("fill", shape.fill);
    setOptionalSvgAttribute(element, "stroke", shape.stroke);
    setOptionalSvgAttribute(element, "stroke-width", shape.strokeWidth);

    if (shape.kind === "rect") {
      element.setAttribute("x", String(shape.x));
      element.setAttribute("y", String(shape.y));
      element.setAttribute("width", String(shape.width));
      element.setAttribute("height", String(shape.height));
      element.setAttribute("rx", String(shape.rx));
    } else {
      element.setAttribute("d", shape.d);
      setOptionalSvgAttribute(element, "transform", shape.transform);
      if (shape.fillRule) {
        element.setAttribute("fill-rule", shape.fillRule);
        element.setAttribute("clip-rule", shape.fillRule);
      }
    }

    svg.appendChild(element);
  }
}

export function getStatusStyle(statusId?: string | null): StatusTone {
  const resolved = resolveStatusVisualId(statusId);
  return resolved ? columnStyles[resolved] : FALLBACK_STATUS_STYLE;
}

export function createStatusIconElement(
  statusId?: string | null,
  options?: {
    className?: string;
    documentRef?: Document;
  },
): SVGSVGElement {
  const documentRef = options?.documentRef ?? document;
  const resolved = resolveStatusVisualId(statusId) ?? "triage";
  const definition = STATUS_ICON_DEFINITIONS[resolved];
  const style = getStatusStyle(resolved);
  const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", definition.viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("class", [STATUS_ICON_CLASS_NAME, options?.className].filter(Boolean).join(" "));
  svg.style.color = style.accentColor;
  appendIconShapes(svg, definition, documentRef);
  return svg;
}

export function StatusIcon({
  statusId,
  className,
  style: inlineStyle,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
  statusId?: string | null;
}) {
  const resolved = resolveStatusVisualId(statusId) ?? "triage";
  const definition = STATUS_ICON_DEFINITIONS[resolved];
  const tone = getStatusStyle(resolved);

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox={definition.viewBox}
      fill="none"
      className={cn(STATUS_ICON_CLASS_NAME, className)}
      {...props}
      style={{ color: tone.accentColor, ...inlineStyle }}
    >
      {definition.shapes.map((shape, index) =>
        shape.kind === "rect" ? (
          <rect
            key={`${resolved}:${index}`}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={shape.rx}
            fill={shape.fill}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth}
          />
        ) : (
          <path
            key={`${resolved}:${index}`}
            d={shape.d}
            fill={shape.fill}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth}
            transform={shape.transform}
            fillRule={shape.fillRule}
            clipRule={shape.fillRule}
          />
        ),
      )}
    </svg>
  );
}

export function StatusLabel({
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
  const resolved = resolveStatusVisualId(statusId) ?? "triage";
  const statusLabel = resolveStatusLabel(resolved, label);

  return (
    <span className={cn(STATUS_LABEL_CLASS_NAME, className)}>
      <StatusIcon statusId={resolved} className={cn("size-4", iconClassName)} />
      <span className={cn("truncate", labelClassName)}>{statusLabel}</span>
    </span>
  );
}
