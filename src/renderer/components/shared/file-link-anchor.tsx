import { parseLocalFileLinkHref } from "../../../shared/file-link-openers";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

interface FileLinkAnchorProps {
  href?: string;
  className?: string;
  children: ReactNode;
  showLocalFileTooltip?: boolean;
}

function resolveLocalFileTooltipLabel(href?: string): string | null {
  if (!href) return null;

  const target = parseLocalFileLinkHref(href);
  if (!target) return null;
  if (!target.line) return target.path;
  if (!target.column) return `${target.path} (line ${target.line})`;

  return `${target.path} (line ${target.line}, column ${target.column})`;
}

export function FileLinkAnchor({
  href,
  className,
  children,
  showLocalFileTooltip = false,
}: FileLinkAnchorProps) {
  const tooltipLabel = showLocalFileTooltip
    ? resolveLocalFileTooltipLabel(href)
    : null;

  const anchor = (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      title={tooltipLabel ?? undefined}
    >
      {children}
    </a>
  );

  if (!tooltipLabel) return anchor;

  return (
    <RadixTooltip.Root delayDuration={0}>
      <RadixTooltip.Trigger asChild>{anchor}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side="top"
          sideOffset={8}
          collisionPadding={8}
          className={[
            "z-50 max-w-[min(64rem,calc(100vw-1.5rem))] rounded-full border px-4 py-2 text-[12.5px] font-medium leading-tight",
            "border-[color-mix(in_srgb,var(--border)_85%,transparent)]",
            "bg-[color-mix(in_srgb,var(--background-secondary)_96%,transparent)] text-[var(--foreground)]",
            "shadow-[0_12px_30px_rgba(0,0,0,0.22)] backdrop-blur-md outline-none",
          ].join(" ")}
        >
          {tooltipLabel}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
