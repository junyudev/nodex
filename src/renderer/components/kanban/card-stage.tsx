import { NfmEditor } from "./editor/nfm-editor";
import { cn } from "@/lib/utils";
import { CardStageInlinePropertyStrip } from "./card-stage/inline-property-strip";
import { CardStagePropertiesSection } from "./card-stage/properties-section";
import { CardStageToolbar } from "./card-stage/toolbar";
import { useCardStageController } from "./card-stage/use-card-stage-controller";
import type { CardStageProps } from "./card-stage/types";

export type { CardStageProps } from "./card-stage/types";

export function CardStage(props: CardStageProps) {
  const controller = useCardStageController(props);

  if (!controller.card) return null;

  return (
    <div className="flex h-full w-full flex-col bg-(--background)">
      <CardStageToolbar
        saving={controller.saving}
        historyPanelActive={controller.historyPanelActive}
        limitMainContentWidth={controller.limitMainContentWidth}
        onClose={() => {
          void controller.handleClose();
        }}
        onDelete={() => {
          void controller.handleDelete();
        }}
        onToggleContentWidth={controller.handleToggleContentWidth}
        onOpenHistoryPanel={controller.onOpenHistoryPanel}
      />

      {controller.updateConflict ? (
        <div className="mx-4 mt-3 rounded-md border border-(--orange-border) bg-(--orange-bg)/50 px-3 py-2 text-sm text-(--foreground)">
          <div className="flex items-center justify-between gap-3">
            <p className="text-(--foreground-secondary)">
              This card changed in another window. Choose how to proceed.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={controller.handleReloadLatest}
                className="rounded-sm border border-(--border) px-2 py-1 text-xs hover:bg-(--surface-hover)"
              >
                Reload Latest
              </button>
              <button
                type="button"
                onClick={() => {
                  void controller.handleOverwriteMine();
                }}
                className="rounded-sm bg-(--foreground) px-2 py-1 text-xs text-(--background) hover:opacity-90"
              >
                Overwrite Mine
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={controller.scrollContainerRef}
        onScroll={controller.handleScroll}
        className="notion-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div className={controller.contentGutterClassName}>
          <div className={controller.contentShellClassName}>
            <div className="h-toolbar-sm" />

            <textarea
              value={controller.title}
              onChange={(event) => controller.handleTitleChange(event.target.value)}
              onBlur={controller.handleTitleBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              rows={1}
              className={cn(
                "w-full resize-none overflow-hidden",
                "text-xl/snug-plus font-bold",
                "text-(--foreground)",
                "border-none px-0.5 pt-0.75",
                "bg-transparent focus-visible:ring-0 focus-visible:outline-none",
                "placeholder:text-(--foreground-disabled)",
                "field-sizing-content",
              )}
              placeholder="Untitled"
            />

            <div className="h-2" />

            <CardStageInlinePropertyStrip
              priority={controller.priority}
              estimate={controller.estimate}
              dueDate={controller.dueDate}
              currentColumnId={controller.currentColumnId}
              currentColumnName={controller.currentColumnName}
              colStyle={controller.colStyle}
              onPriorityChange={controller.handlePriorityChange}
              onEstimateChange={controller.handleEstimateChange}
              onDueDateChange={controller.handleDueDateChange}
              onClearDueDate={controller.handleClearDueDate}
              onSetDueDateToday={controller.handleSetDueDateToday}
              onColumnChange={controller.handleColumnChange}
            />

            <CardStagePropertiesSection controller={controller} />

            <div className="pt-2 pb-8">
              <NfmEditor
                key={`${props.projectId}:${controller.card.id}`}
                projectId={props.projectId}
                content={controller.description}
                onChange={controller.handleDescriptionChange}
                onBlur={controller.handleDescriptionBlur}
                sourceCardContext={{
                  cardId: controller.card.id,
                  columnId: controller.currentColumnId,
                }}
                placeholder="Add a description..."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
