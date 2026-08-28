import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
} from "react";

import { ChevronRightIcon, LoadingIcon } from "@/components/shared/icons";
import { SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import {
  NodexContextMenuItem,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
} from "@/components/ui/context-menu";
import { NodexDropdown } from "@/components/ui/dropdown";
import { preserveInteractiveSubmenuRootFocus } from "@/lib/context-menu-submenu";
import { buildPagePropertyContextMenuModel } from "@/lib/page-property-context-menu-model";
import { cn } from "@/lib/utils";
import type { DataSourcePropertyEditorBinding } from "./data-source-property-editor-binding";
import type {
  DataSourcePagePropertyMenuDescriptor,
  DataSourcePagePropertyMenuSource,
} from "./data-source-page-property-menu-source";
import { dataSourcePropertyIcon } from "./data-source-property-presentation";
import { DataSourcePropertyValueEditor } from "./data-source-property-value-editor";
import { PropertyEditorFeedback } from "./property-editor-feedback";

const ITEM_CLASS_NAME = cn(
  "cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden",
  "text-token-foreground hover:bg-token-list-hover-background focus:bg-token-list-hover-background",
  "data-[highlighted]:bg-token-list-hover-background data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
);

const INPUT_CLASS_NAME = cn(
  "h-8 w-full rounded-lg border border-token-border bg-token-input-background px-2 text-sm",
  "text-token-text-primary outline-none placeholder:text-token-description-foreground focus-visible:ring-1 focus-visible:ring-token-focus",
);

const PropertyMenuTrigger = forwardRef<
  HTMLDivElement,
  {
    readonly descriptor: DataSourcePagePropertyMenuDescriptor;
    readonly itemDataAttribute?: string;
  } & ComponentPropsWithoutRef<"div">
>(function PropertyMenuTrigger({ descriptor, itemDataAttribute, className, ...props }, ref) {
  const Icon = dataSourcePropertyIcon(descriptor.property);
  return (
    <div
      ref={ref}
      {...props}
      data-page-property-menu-item="true"
      data-card-menu-item={itemDataAttribute}
      className={cn(ITEM_CLASS_NAME, "flex w-full items-center gap-2", className)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
        {descriptor.pending ? (
          <LoadingIcon className="size-4 animate-spin" />
        ) : (
          <Icon className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{descriptor.property.name}</span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-token-description-foreground" />
    </div>
  );
});

function ScalarPropertyEditorContent({
  binding,
}: {
  readonly binding: DataSourcePropertyEditorBinding;
}) {
  const number = binding.property.valueType === "number";
  const committed = number
    ? typeof binding.value === "number"
      ? String(binding.value)
      : ""
    : typeof binding.value === "string"
      ? binding.value
      : "";
  const [draft, setDraft] = useState(committed);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(committed);
    setError(null);
  }, [binding.revision, committed]);

  const commit = (): boolean => {
    if (!number) {
      binding.onChange(draft.trim() ? draft : null);
      return true;
    }
    if (!draft.trim()) {
      binding.onChange(null);
      return true;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setError("Enter a finite number");
      return false;
    }
    binding.onChange(parsed);
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveRef.current?.click();
  };

  return (
    <div className="p-2">
      <input
        autoFocus
        aria-label={`${binding.property.name} value`}
        inputMode={number ? "decimal" : "text"}
        value={draft}
        disabled={binding.disabled || binding.pending}
        placeholder="Empty"
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        className={INPUT_CLASS_NAME}
      />
      {error ? (
        <p role="alert" className="px-1 pt-1 text-xs text-token-error-foreground">
          {error}
        </p>
      ) : null}
      {binding.error ? <PropertyEditorFeedback message={binding.error} /> : null}
      <div className="mt-2 flex gap-1">
        <NodexContextMenuItem
          ref={saveRef}
          disabled={binding.disabled || binding.pending}
          className={cn(ITEM_CLASS_NAME, "flex-1 text-center")}
          onSelect={(event) => {
            if (!commit()) event.preventDefault();
          }}
        >
          Save
        </NodexContextMenuItem>
        {committed ? (
          <NodexContextMenuItem
            disabled={binding.disabled || binding.pending}
            className={cn(ITEM_CLASS_NAME, "flex-1 text-center text-token-description-foreground")}
            onSelect={() => binding.onChange(null)}
          >
            Clear
          </NodexContextMenuItem>
        ) : null}
      </div>
    </div>
  );
}

function SharedPropertyEditorContent({
  binding,
  onContextMenuCommit,
}: {
  readonly binding: DataSourcePropertyEditorBinding;
  readonly onContextMenuCommit: () => void;
}) {
  const embeddedOverlay =
    binding.property.valueType === "date" ||
    binding.property.valueType === "datetime" ||
    binding.property.valueType === "relation";
  return (
    <>
      {embeddedOverlay ? (
        <DataSourcePropertyValueEditor
          {...binding}
          showLabel={false}
          presentation="page"
          overlayHost="embedded"
          onOverlayRequestClose={onContextMenuCommit}
        />
      ) : (
        <>
          <NodexDropdown.SectionLabel>{binding.property.name}</NodexDropdown.SectionLabel>
          <div className="px-2 pb-2">
            <DataSourcePropertyValueEditor {...binding} showLabel={false} presentation="page" />
          </div>
        </>
      )}
      {binding.error ? (
        <div className="px-2 pb-2">
          <PropertyEditorFeedback message={binding.error} />
        </div>
      ) : null}
    </>
  );
}

const propertySubmenuContentClassName = (
  descriptor: DataSourcePagePropertyMenuDescriptor,
): string => {
  if (descriptor.property.valueType === "relation") {
    return "pointer-events-auto m-0 w-[min(360px,calc(100vw-16px))] p-0";
  }
  if (descriptor.property.valueType === "date" || descriptor.property.valueType === "datetime") {
    return "pointer-events-auto m-0 w-[280px] p-0";
  }
  if (
    descriptor.property.valueType === "select" ||
    descriptor.property.valueType === "multi_select"
  ) {
    return "pointer-events-auto m-0 w-[min(320px,calc(100vw-16px))] overflow-hidden p-0";
  }
  return "pointer-events-auto m-0 w-[265px]";
};

function ResolvedPropertyEditorContent({
  descriptor,
  source,
  onContextMenuCommit,
}: {
  readonly descriptor: DataSourcePagePropertyMenuDescriptor;
  readonly source: DataSourcePagePropertyMenuSource;
  readonly onContextMenuCommit: () => void;
}) {
  const binding = source.resolveBinding(descriptor.property.propertyId);
  if (binding.property.valueType === "select" || binding.property.valueType === "multi_select") {
    return (
      <DataSourcePropertyValueEditor
        {...binding}
        showLabel={false}
        presentation="page"
        optionPickerHost="embedded"
        onOptionPickerCommit={onContextMenuCommit}
      />
    );
  }
  if (binding.property.valueType === "text" || binding.property.valueType === "number") {
    return <ScalarPropertyEditorContent binding={binding} />;
  }
  return (
    <SharedPropertyEditorContent binding={binding} onContextMenuCommit={onContextMenuCommit} />
  );
}

function PropertySubmenu({
  descriptor,
  source,
  itemDataAttribute,
  onContextMenuCommit,
}: {
  readonly descriptor: DataSourcePagePropertyMenuDescriptor;
  readonly source: DataSourcePagePropertyMenuSource;
  readonly itemDataAttribute?: string;
  readonly onContextMenuCommit: () => void;
}) {
  return (
    <NodexContextMenuSubmenu
      disabled={descriptor.disabled || descriptor.pending}
      trigger={
        <PropertyMenuTrigger descriptor={descriptor} itemDataAttribute={itemDataAttribute} />
      }
      contentClassName={propertySubmenuContentClassName(descriptor)}
      onContentFocusOutside={preserveInteractiveSubmenuRootFocus}
      renderContent={() => (
        <ResolvedPropertyEditorContent
          descriptor={descriptor}
          source={source}
          onContextMenuCommit={onContextMenuCommit}
        />
      )}
    />
  );
}

export function DataSourcePagePropertyContextMenuItems({
  source,
  groupingPropertyId = null,
  query = "",
  itemDataAttribute,
  onContextMenuCommit,
}: {
  readonly source: DataSourcePagePropertyMenuSource;
  readonly groupingPropertyId?: string | null;
  readonly query?: string;
  readonly itemDataAttribute?: string;
  readonly onContextMenuCommit: () => void;
}) {
  const model = buildPagePropertyContextMenuModel(source.descriptors, {
    groupingPropertyId,
    query,
  });
  if (!model.hasMatches) return null;
  return (
    <>
      {model.visible.map((descriptor) => (
        <PropertySubmenu
          key={descriptor.property.propertyId}
          descriptor={descriptor}
          source={source}
          itemDataAttribute={itemDataAttribute}
          onContextMenuCommit={onContextMenuCommit}
        />
      ))}
      {!model.searching && model.overflow.length > 0 ? (
        <NodexContextMenuSubmenu
          trigger={
            <NodexContextMenuSubmenuTrigger
              data-page-property-menu-item="true"
              data-card-menu-item={itemDataAttribute}
              leftSlot={<SlidersHorizontal className="size-4" strokeWidth={1.8} />}
              rightSlot={<ChevronRightIcon className="size-3.5" />}
            >
              More properties…
            </NodexContextMenuSubmenuTrigger>
          }
          contentClassName="m-0 w-[265px]"
          onContentFocusOutside={preserveInteractiveSubmenuRootFocus}
          renderContent={() => (
            <>
              <NodexDropdown.SectionLabel>Properties</NodexDropdown.SectionLabel>
              {model.overflow.map((descriptor) => (
                <PropertySubmenu
                  key={descriptor.property.propertyId}
                  descriptor={descriptor}
                  source={source}
                  onContextMenuCommit={onContextMenuCommit}
                />
              ))}
            </>
          )}
        />
      ) : null}
    </>
  );
}

export const pagePropertyContextMenuHasMatches = (
  descriptors: readonly DataSourcePagePropertyMenuDescriptor[],
  query: string,
): boolean => buildPagePropertyContextMenuModel(descriptors, { query }).hasMatches;

export type { DataSourcePropertyEditorBinding };
