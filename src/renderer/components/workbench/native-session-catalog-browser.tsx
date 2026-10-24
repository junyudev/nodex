import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  NativeSessionCatalogEntry,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ProjectWindow } from "../../../shared/types";
import { formatCompactRelativeTime } from "../../lib/compact-relative-time";
import { cn } from "../../lib/utils";
import { NodexButton } from "../ui/button";
import {
  NodexDropdownActionRow,
  NodexDropdownSeparator,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
} from "../ui/dropdown";

export const nativeSessionErrorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const nativeSessionTitle = (title: string) => title || "Untitled conversation";

/** Bounded native catalog pages; a superseded read or a closed page never lands. */
export function useNativeSessionCatalog(
  list: (input: NativeSessionCatalogInput) => Promise<NativeSessionCatalogPage>,
  open: boolean,
) {
  const [page, setPage] = useState<NativeSessionCatalogPage | null>(null);
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    return () => {
      generation.current += 1;
      setLoading(false);
    };
  }, [open]);

  const load = async (
    input: NativeSessionCatalogInput,
    history: readonly (string | undefined)[],
  ) => {
    const ownGeneration = ++generation.current;
    const cursor = history.at(-1);
    setLoading(true);
    setError(null);
    try {
      const next = await list(cursor ? { ...input, cursor } : input);
      if (generation.current !== ownGeneration) return;
      setPage(next);
      setCursors(history);
    } catch (cause) {
      if (generation.current === ownGeneration) setError(nativeSessionErrorMessage(cause));
    } finally {
      if (generation.current === ownGeneration) setLoading(false);
    }
  };

  return {
    page,
    cursors,
    loading,
    error,
    browse: (input: NativeSessionCatalogInput) => load(input, [undefined]),
    previous: (input: NativeSessionCatalogInput) =>
      cursors.length > 1 ? load(input, cursors.slice(0, -1)) : Promise.resolve(),
    next: (input: NativeSessionCatalogInput) =>
      page?.nextCursor ? load(input, [...cursors, page.nextCursor]) : Promise.resolve(),
    update: (change: (current: NativeSessionCatalogPage) => NativeSessionCatalogPage): void =>
      setPage((current) => (current ? change(current) : current)),
    reset: () => {
      generation.current += 1;
      setPage(null);
      setCursors([undefined]);
      setLoading(false);
      setError(null);
    },
  };
}

export type NativeSessionCatalogState = ReturnType<typeof useNativeSessionCatalog>;

/** Absolute paths keep their trailing folders visible when truncated, aligned like LTR text. */
export function NativeSessionPath({ path, className }: { path: string; className?: string }) {
  return (
    <span className={cn("block min-w-0 truncate text-left [direction:rtl]", className)}>
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}

export function NativeSessionUpdatedAt({ updatedAt }: { updatedAt: number }) {
  return (
    <time
      className="shrink-0 text-xs text-token-description-foreground tabular-nums"
      dateTime={new Date(updatedAt).toISOString()}
    >
      {formatCompactRelativeTime(updatedAt)}
    </time>
  );
}

export function NativeSessionCatalogRow({
  entry,
  action,
}: {
  entry: NativeSessionCatalogEntry;
  action: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-sm text-token-text-primary">
          {nativeSessionTitle(entry.title)}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-token-text-secondary">
          <NativeSessionPath path={entry.cwd} />
          {entry.cwdAvailable === false ? (
            <span className="shrink-0 text-danger">Folder missing</span>
          ) : null}
        </div>
      </div>
      <NativeSessionUpdatedAt updatedAt={entry.updatedAt} />
      {action}
    </div>
  );
}

export function NativeSessionCatalogList({
  catalog,
  input,
  disabled,
  emptyMessage,
  renderEntry,
}: {
  catalog: NativeSessionCatalogState;
  input: NativeSessionCatalogInput;
  disabled: boolean;
  emptyMessage: string;
  renderEntry: (entry: NativeSessionCatalogEntry, page: NativeSessionCatalogPage) => ReactNode;
}) {
  const { page, cursors, loading, error } = catalog;
  return (
    <>
      {page ? (
        <div className="flex min-w-0 items-center gap-3 px-4 py-2 text-xs text-token-description-foreground">
          <span className="shrink-0">Recent conversations</span>
          <NativeSessionPath path={page.nativeHome} className="ml-auto text-right" />
        </div>
      ) : null}
      {page?.entries.map((entry) => renderEntry(entry, page))}
      {page && page.entries.length === 0 ? (
        <div className="px-4 py-3 text-sm text-token-text-secondary">{emptyMessage}</div>
      ) : null}
      {page && (cursors.length > 1 || page.nextCursor) ? (
        <div className="flex justify-end gap-1 px-3 py-2">
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={disabled || loading || cursors.length === 1}
            onClick={() => void catalog.previous(input)}
          >
            Previous
          </NodexButton>
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={disabled || loading || !page.nextCursor}
            onClick={() => void catalog.next(input)}
          >
            Next
          </NodexButton>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
    </>
  );
}

export interface NativeSessionDestinations {
  readonly window: ProjectWindow | null;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  /** The active Project when it is a loaded destination; otherwise Projectless. */
  readonly defaultProjectId: string | null;
}

const PROJECTLESS = "projectless";

export function NativeSessionDestinationPicker({
  destinations,
  value,
  onValueChange,
  disabled,
  ariaLabel,
}: {
  destinations: NativeSessionDestinations;
  value: string | null;
  onValueChange: (projectId: string | null) => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  const projects = destinations.window?.items ?? [];
  return (
    <NodexOptionPicker
      value={value ?? PROJECTLESS}
      options={[
        { value: PROJECTLESS, label: "Projectless" },
        ...projects.map((project) => ({ value: project.id, label: project.name })),
      ]}
      search="filter"
      disabled={disabled || !destinations.window}
      onValueChange={(next) => onValueChange(next === PROJECTLESS ? null : next)}
      footer={
        destinations.window?.nextCursor ? (
          <>
            <NodexDropdownSeparator />
            <NodexDropdownActionRow
              disabled={destinations.loadingMore}
              onClick={destinations.loadMore}
            >
              {destinations.loadingMore ? "Loading…" : "Load more projects"}
            </NodexDropdownActionRow>
          </>
        ) : null
      }
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label={ariaLabel}>
          {projects.find((project) => project.id === value)?.name ?? "Projectless"}
        </NodexSettingsDropdownTrigger>
      }
    />
  );
}
