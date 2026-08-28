import { FilterIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { commitDatabaseViewOperations } from "@/lib/database-view-row-mutations";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import { useEffect, useState } from "react";
import type { DatabaseViewConfigV4 } from "../../../shared/database-kernel";
import type { DatabasePropertyOption } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { DatabaseViewConfigEditor } from "./database-view-config-editor";
import {
  decodeDatabaseTaskFilter,
  encodeDatabaseTaskFilter,
  resolveDatabaseTaskFilterCapabilities,
} from "@/lib/database-view-task-filter";
import { DatabaseViewTaskFilterEditor } from "./database-view-task-filter-editor";

interface DatabaseViewFilterProps {
  readonly model: DatabaseViewRenderModel;
  readonly onCommitted?: () => void | Promise<void>;
  readonly commitOperations?: typeof commitDatabaseViewOperations;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly optionRegistries?: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
}

const EMPTY_OPTION_REGISTRIES: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {};

const hasFilter = (config: DatabaseViewConfigV4): boolean =>
  config.filter.kind === "clause" || config.filter.children.length > 0;

export function DatabaseViewFilter({
  model,
  onCommitted,
  commitOperations = commitDatabaseViewOperations,
  open: controlledOpen,
  onOpenChange,
  optionRegistries = EMPTY_OPTION_REGISTRIES,
  onRequestPropertyOptions,
}: DatabaseViewFilterProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [draft, setDraft] = useState(model.query.view.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  useEffect(() => {
    setDraft(model.query.view.config);
    setError(null);
  }, [model.query.view.config, model.query.view.revision]);
  useEffect(() => {
    if (!open || !onRequestPropertyOptions) return;
    const tagsProperty = model.query.properties.find(
      (property) => property.lifecycle === "active" && property.propertyId === "tags",
    );
    if (tagsProperty) onRequestPropertyOptions(tagsProperty);
  }, [model.query.properties, onRequestPropertyOptions, open]);
  const changed = JSON.stringify(draft.filter) !== JSON.stringify(model.query.view.config.filter);
  const taskFilterCapabilities = resolveDatabaseTaskFilterCapabilities(model.query.properties, {
    tags: optionRegistries.tags ?? [],
  });
  const taskFilterState = decodeDatabaseTaskFilter(draft.filter, taskFilterCapabilities);
  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await commitOperations({
        model,
        operations: [
          {
            kind: "put_view",
            databaseId: model.databaseId,
            dataSourceId: model.dataSourceId,
            viewId: model.databaseViewId,
            expectedRevision: model.query.view.revision,
            name: model.query.view.name,
            defaultLayout: model.query.view.defaultLayout,
            config: draft,
            isDefault: model.query.view.isDefault,
          },
        ],
      });
      await onCommitted?.();
      setOpen(false);
    } catch {
      setError("Couldn’t save this View filter. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <NodexIconButton
          icon={FilterIcon}
          size="sm"
          active={open || hasFilter(model.query.view.config)}
          ariaLabel="Filter View"
          title="Filter"
        />
      </NodexPopoverTrigger>
      <NodexPopoverContent align="end" className="w-[min(34rem,calc(100vw-2rem))] p-0">
        {taskFilterState ? (
          <DatabaseViewTaskFilterEditor
            state={taskFilterState}
            capabilities={taskFilterCapabilities}
            disabled={busy}
            onChange={(state) =>
              setDraft({
                ...draft,
                filter: encodeDatabaseTaskFilter(state, taskFilterCapabilities),
              })
            }
          />
        ) : (
          <>
            <div className="flex h-9 items-center px-3">
              <span className="text-xs font-medium uppercase tracking-label text-token-description-foreground">
                Filters
              </span>
              <span className="ml-auto text-[11px] text-token-description-foreground">
                Advanced rules
              </span>
            </div>
            <div className="max-h-[420px] overflow-y-auto px-2 pb-2">
              <DatabaseViewConfigEditor
                config={draft}
                layout={model.query.view.defaultLayout}
                properties={model.query.properties}
                optionRegistries={optionRegistries}
                onRequestPropertyOptions={onRequestPropertyOptions}
                disabled={busy}
                onlyFilter
                onChange={setDraft}
              />
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="px-3 pb-1 text-xs text-token-error-foreground">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2 border-t-[0.5px] border-token-border/70 px-2 py-2">
          <NodexButton
            size="xs"
            variant="ghost"
            disabled={busy || !changed}
            onClick={() => setDraft(model.query.view.config)}
          >
            Revert
          </NodexButton>
          <NodexButton
            size="xs"
            variant="secondary"
            className="ml-auto"
            disabled={busy || !changed}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save filter"}
          </NodexButton>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
