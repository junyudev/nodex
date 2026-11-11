import { DataSourcePropertyValueEditor } from "@/components/database/data-source-property-value-editor";
import { PropertyEditorFeedback } from "@/components/database/property-editor-feedback";
import { cn } from "@/lib/utils";
import type { PageStageDataSourceProperty } from "@/lib/page-stage-properties";
import type { PageStagePropertyControls } from "./use-page-stage-properties";

export function PageStageDataSourcePropertyControl({
  item,
  controls,
  showLabel = false,
  openOnMount = false,
  className,
}: {
  readonly item: PageStageDataSourceProperty;
  readonly controls: PageStagePropertyControls;
  readonly showLabel?: boolean;
  /** Opens the value editor as this control mounts, for a property the person just chose. */
  readonly openOnMount?: boolean;
  readonly className?: string;
}) {
  const propertyId = item.property.propertyId;
  const error = item.error
    ? "This property value has an unsupported format."
    : (controls.errors[propertyId] ?? null);
  const pending = controls.busyPropertyIds.has(propertyId);
  const disabled = item.error !== null;
  return (
    <div className={cn("min-w-0", className)}>
      <DataSourcePropertyValueEditor
        property={item.property}
        value={item.value}
        revision={item.valueRevision}
        disabled={disabled}
        pending={pending}
        showLabel={showLabel}
        openOnMount={openOnMount}
        presentation="page"
        relationSourcePageId={controls.pageId ?? undefined}
        options={controls.options[propertyId] ?? []}
        optionRegistryState={controls.optionRegistryStates[propertyId] ?? "ready"}
        optionRegistryHasMore={controls.optionRegistryHasMore[propertyId] ?? false}
        optionRegistryLoadingMore={controls.optionRegistryLoadingMore[propertyId] ?? false}
        onRequestOptions={() => controls.requestOptions(item)}
        onRequestMoreOptions={() => controls.requestMoreOptions(item)}
        onChange={(value) => {
          void controls.edit(item, {
            kind: "replace",
            value,
            expectedValueRevision: item.valueRevision,
          });
        }}
        onCreateOption={async (option) => {
          const result = await controls.createOptionAndSelect(item, option);
          if (result.status === "updated") return;
          if (result.status === "error") throw new Error(result.error);
          if (result.status === "conflict") {
            throw new Error("Property changed elsewhere. Review the refreshed options.");
          }
          throw new Error("Property is no longer available.");
        }}
        onPatchRelation={(delta) => {
          void controls.patchRelation(item, delta);
        }}
        onReplaceOneRelation={(targetPageId) => {
          void controls.replaceRelation(item, targetPageId);
        }}
        onPatchOptions={(delta) => {
          void controls.patchMultiSelect(item, delta);
        }}
        onLoadRelationTargets={(after) => controls.loadRelationTargets(item, after)}
        onSearchRelationCandidates={(query, after) =>
          controls.searchRelationCandidates(item, query, after)
        }
        onLoadRelationTargetDescriptor={() => controls.loadRelationTargetDescriptor(item)}
        onOpenRelationPage={controls.openRelationPage}
        onRelationValueStale={() => {
          void controls.refreshRelationValue();
        }}
      />
      {error ? <PropertyEditorFeedback message={error} /> : null}
    </div>
  );
}
