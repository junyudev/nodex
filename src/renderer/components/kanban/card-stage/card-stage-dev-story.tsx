import { useCallback, useEffect, useMemo, useState } from "react";
import { CardStage } from "../card-stage";
import { useCardStageCollapsedProperties } from "../../../lib/use-card-stage-collapsed-properties";
import type { CardInput } from "../../../lib/types";
import {
  buildCardStageStoryCard,
  buildCardStageStoryCollapsedProperties,
  buildCardStageStoryThreads,
  CARD_STAGE_STORY_COLUMN_ID,
  CARD_STAGE_STORY_COLUMN_NAME,
  CARD_STAGE_STORY_PROJECT_ID,
  CARD_STAGE_STORY_WORKSPACE_PATH,
  type CardStageStoryControls,
} from "./card-stage-dev-story-data";

export interface CardStageDevStoryPageProps extends CardStageStoryControls {
  renderPreview?: boolean;
}

export function CardStageDevStoryPage({
  runInTarget,
  threadDensity,
  previewMode,
  existingWorktree,
  showNewThreadAction,
  enableOpenThread,
  collapseThreadsByDefault,
  collapseSecondaryProperties,
  historyPanelActive: initialHistoryPanelActive,
  renderPreview = true,
}: CardStageDevStoryPageProps) {
  const [extraThreadCount, setExtraThreadCount] = useState(0);
  const [historyPanelActive, setHistoryPanelActive] = useState(initialHistoryPanelActive);
  const { setCollapsedProperties } = useCardStageCollapsedProperties();

  useEffect(() => {
    setExtraThreadCount(0);
    setHistoryPanelActive(initialHistoryPanelActive);
  }, [
    collapseSecondaryProperties,
    collapseThreadsByDefault,
    enableOpenThread,
    existingWorktree,
    initialHistoryPanelActive,
    previewMode,
    runInTarget,
    showNewThreadAction,
    threadDensity,
  ]);

  useEffect(() => {
    setCollapsedProperties(buildCardStageStoryCollapsedProperties({
      collapseThreadsByDefault,
      collapseSecondaryProperties,
    }));
  }, [collapseSecondaryProperties, collapseThreadsByDefault, setCollapsedProperties]);

  const card = useMemo(() => buildCardStageStoryCard({
    runInTarget,
    existingWorktree,
  }), [existingWorktree, runInTarget]);
  const linkedThreads = useMemo(
    () => buildCardStageStoryThreads({ threadDensity, previewMode }, extraThreadCount),
    [extraThreadCount, previewMode, threadDensity],
  );

  const handleOpenNewThread = useCallback(() => {
    setExtraThreadCount((current) => current + 1);
  }, []);

  const handleOpenHistoryPanel = useCallback(() => {
    setHistoryPanelActive((current) => !current);
  }, []);

  const handleUpdate = useCallback(async (columnId: string, cardId: string, updates: Partial<CardInput>) => {
    void columnId;
    void cardId;
    void updates;
  }, []);

  const handleMove = useCallback(async (fromStatus: string, cardId: string, toStatus: string) => {
    void fromStatus;
    void cardId;
    void toStatus;
  }, []);

  const threadCountLabel = linkedThreads.length === 1 ? "1 linked thread" : `${linkedThreads.length} linked threads`;

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-[linear-gradient(180deg,var(--background),color-mix(in_srgb,var(--background),var(--background-secondary)_42%))] text-(--foreground)">
      <div className="mx-auto flex min-h-full w-full max-w-190 flex-col gap-4">
        <section className="rounded-[24px] border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary),transparent_10%)] px-5 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="text-sm font-semibold">Card Stage</div>
              <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
                Production-backed scene for the full card stage and the linked-thread property row. Presets and controls now live in Storybook stories and the Controls panel, not inside the canvas.
              </div>
            </div>
            <div className="flex max-w-sm flex-wrap justify-end gap-2">
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {runInTarget}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {threadCountLabel}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {collapseThreadsByDefault ? "threads collapsed" : "threads expanded"}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {historyPanelActive ? "history active" : "history idle"}
              </span>
            </div>
          </div>
        </section>

        <section className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-(--border) bg-(--background) shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
          {renderPreview ? (
            <CardStage
              onClose={() => undefined}
              card={card}
              columnId={CARD_STAGE_STORY_COLUMN_ID}
              columnName={CARD_STAGE_STORY_COLUMN_NAME}
              projectId={CARD_STAGE_STORY_PROJECT_ID}
              projectWorkspacePath={CARD_STAGE_STORY_WORKSPACE_PATH}
              availableTags={["ui", "threads", "card-stage", "spacing", "review"]}
              onUpdate={handleUpdate}
              onPatch={() => {
                // Keep optimistic patches local to the real CardStage controller state.
              }}
              onDelete={async () => {
              }}
              onMove={handleMove}
              onOpenHistoryPanel={handleOpenHistoryPanel}
              linkedCodexThreads={linkedThreads}
              onOpenCodexThread={enableOpenThread ? async () => {
              } : undefined}
              onOpenNewCodexThread={showNewThreadAction ? handleOpenNewThread : undefined}
              historyPanelActive={historyPanelActive}
            />
          ) : (
            <div className="flex h-full min-h-120 items-center justify-center px-6 text-sm text-(--foreground-secondary)">
              Preview disabled for tests.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
