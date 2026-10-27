import { useId, useLayoutEffect, useRef, useState } from "react";
import { CheckmarkMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { DetailSection } from "@/components/ui/detail-page";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { cn } from "@/lib/utils";
import type {
  PluginDependency,
  PluginDependenciesView,
} from "../../../../shared/codex-plugin-settings";
import { PluginLogoImage } from "./plugin-logo";

const CHIP_CLASS =
  "inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-full border ps-2 pe-3 py-0 text-sm leading-[18px] whitespace-nowrap select-none";
const CHIP_GAP_PX = 8;

interface DependencyGroup {
  readonly id: string;
  readonly label: string;
  readonly providers: readonly PluginDependency[];
}

function isUnavailable(provider: PluginDependency): boolean {
  return provider.enabled === false || provider.unavailableReason != null;
}

/** Providers grouped by category, categories by label, available providers first. */
export function groupDependencies(
  dependencies: readonly PluginDependency[],
  locale?: string,
): DependencyGroup[] {
  const groups = new Map<string, { label: string; providers: PluginDependency[] }>();
  for (const dependency of dependencies) {
    for (const category of dependency.categories) {
      const group = groups.get(category.id) ?? { label: category.label, providers: [] };
      group.providers.push(dependency);
      groups.set(category.id, group);
    }
  }
  return [...groups]
    .map(([id, group]) => ({
      id,
      label: group.label,
      providers: group.providers.toSorted(
        (a, b) => Number(isUnavailable(a)) - Number(isUnavailable(b)),
      ),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label, locale));
}

function statusLabel(provider: PluginDependency): string | null {
  if (provider.unavailableReason != null) return provider.unavailableReason;
  if (provider.enabled === false) return "Not available";
  return null;
}

function DependencyChipContent({ provider }: { readonly provider: PluginDependency }) {
  const unavailable = isUnavailable(provider);
  return (
    <>
      <PluginLogoImage
        source={{
          logoUrl: provider.logoUrl,
          logoDarkUrl: provider.logoDarkUrl,
          name: provider.displayName,
        }}
        className={cn("size-5 shrink-0 rounded-2xs", unavailable && "opacity-40 grayscale")}
      />
      <span className={cn("truncate", unavailable && "text-tertiary")}>{provider.displayName}</span>
      {!unavailable && provider.installed === true ? (
        <CheckmarkMdIcon className="text-tertiary" />
      ) : null}
    </>
  );
}

function DependencyChip({ provider }: { readonly provider: PluginDependency }) {
  const unavailable = isUnavailable(provider);
  const status = statusLabel(provider);
  const chip = (
    <span
      tabIndex={status == null ? undefined : 0}
      aria-description={status ?? (provider.installed === true ? "Installed" : undefined)}
      className={cn(
        CHIP_CLASS,
        "max-w-full",
        unavailable
          ? "border-transparent bg-text/5 text-tertiary"
          : "border-(--color-border) bg-(--color-surface)",
      )}
    >
      <DependencyChipContent provider={provider} />
    </span>
  );
  return status == null ? (
    chip
  ) : (
    <NodexTooltip tooltipContent={status} side="top">
      {chip}
    </NodexTooltip>
  );
}

/**
 * One category of providers on a single line: as many chips as fit, then "+N" to show the
 * rest. Expanded, the chips wrap and "Show less" folds them back.
 */
function DependencyCategoryRow({ group }: { readonly group: DependencyGroup }) {
  const labelId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(group.providers.length);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (row == null || measure == null) return;
    const update = () => {
      const available = row.getBoundingClientRect().width;
      const chips = [...measure.children] as HTMLElement[];
      const overflow = chips.at(-1);
      const widths = chips.slice(0, -1).map((chip) => chip.getBoundingClientRect().width);
      const overflowWidth = overflow?.getBoundingClientRect().width ?? 0;
      let used = 0;
      let count = 0;
      for (const [index, width] of widths.entries()) {
        const next = used + (index > 0 ? CHIP_GAP_PX : 0) + width;
        const remaining = widths.length - (index + 1);
        const reserve = remaining > 0 ? CHIP_GAP_PX + overflowWidth : 0;
        if (next + reserve > available) break;
        used = next;
        count += 1;
      }
      setVisibleCount(Math.max(count, 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const hiddenCount = group.providers.length - visibleCount;
  const shown = expanded ? group.providers : group.providers.slice(0, visibleCount);
  return (
    <div className={cn("flex min-w-0 gap-4", expanded ? "items-start" : "items-center")}>
      <dt
        id={labelId}
        className="w-1/3 shrink-0 text-sm break-words text-(--color-text-secondary) sm:w-32"
      >
        {group.label}
      </dt>
      <dd className="relative m-0 min-w-0 flex-1">
        <div
          ref={rowRef}
          role="group"
          aria-labelledby={labelId}
          tabIndex={-1}
          className={cn("flex min-w-0 items-center gap-2", expanded && "flex-wrap")}
          onKeyDown={(event) => {
            if (expanded && event.key === "Escape") {
              event.preventDefault();
              setExpanded(false);
            }
          }}
        >
          {shown.map((provider) => (
            <DependencyChip key={provider.pluginId} provider={provider} />
          ))}
          {hiddenCount > 0 || expanded ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? `Show fewer plugins in ${group.label}`
                  : `Show ${hiddenCount} more ${hiddenCount === 1 ? "plugin" : "plugins"} in ${group.label}`
              }
              className={cn(
                CHIP_CLASS,
                "cursor-interaction border-(--color-border) bg-(--color-surface) hover:bg-token-list-hover-background",
              )}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `+${hiddenCount}`}
            </button>
          ) : null}
        </div>
        <div
          ref={measureRef}
          aria-hidden
          inert
          className="pointer-events-none invisible absolute inset-x-0 top-0 flex h-0 items-center gap-2 overflow-hidden"
        >
          {group.providers.map((provider) => (
            <span key={provider.pluginId} className={cn(CHIP_CLASS, "border-(--color-border)")}>
              <DependencyChipContent provider={provider} />
            </span>
          ))}
          <span className={cn(CHIP_CLASS, "border-(--color-border)")}>
            +{group.providers.length}
          </span>
        </div>
      </dd>
    </div>
  );
}

/** "Works with": the plugins this one connects to, by category. */
export function PluginWorksWith({
  worksWith,
  onRetry,
}: {
  readonly worksWith: PluginDependenciesView;
  readonly onRetry: () => void;
}) {
  if (worksWith.error != null) {
    return (
      <DetailSection title="Works with" showDivider={false}>
        <div className="flex items-center justify-between gap-4 text-sm text-(--color-text-secondary)">
          Couldn’t load dependencies
          <ToolbarButton color="secondary" onClick={onRetry}>
            Retry
          </ToolbarButton>
        </div>
      </DetailSection>
    );
  }
  const groups = groupDependencies(worksWith.dependencies);
  if (groups.length === 0) return null;
  return (
    <DetailSection id="plugin-dependencies" title="Works with" showDivider={false}>
      <dl className="flex min-w-0 flex-col gap-3 select-none">
        {groups.map((group) => (
          // A row measures its chips once; a different set of providers is a new row.
          <DependencyCategoryRow
            key={`${group.id}:${group.providers.map((provider) => provider.pluginId).join(",")}`}
            group={group}
          />
        ))}
      </dl>
    </DetailSection>
  );
}
