import { useCallback, useEffect, useMemo, useState } from "react";
import { DevStoryFontSettingsSection } from "../../dev-story/dev-story-font-settings";
import { useDevStoryFontSize } from "../../../lib/use-dev-story-font-size";
import { CardStage } from "../card-stage";
import { cn } from "../../../lib/utils";
import { useCardStageCollapsedProperties } from "../../../lib/use-card-stage-collapsed-properties";
import type { CardInput, CardRunInTarget } from "../../../lib/types";
import {
  buildCardStageStoryCard,
  buildCardStageStoryCollapsedProperties,
  buildCardStageStoryThreads,
  CARD_STAGE_STORY_COLUMN_ID,
  CARD_STAGE_STORY_COLUMN_NAME,
  CARD_STAGE_STORY_DEFAULT_PRESET,
  CARD_STAGE_STORY_PRESETS,
  CARD_STAGE_STORY_PROJECT_ID,
  CARD_STAGE_STORY_WORKSPACE_PATH,
  resolveCardStageStoryPreset,
  type CardStageStoryControls,
  type CardStageStoryPreviewMode,
  type CardStageStoryThreadDensity,
} from "./card-stage-dev-story-data";

interface CardStageDevStoryPageProps {
  onExit: () => void;
  renderPreview?: boolean;
}

export function CardStageDevStoryPage({ onExit, renderPreview = true }: CardStageDevStoryPageProps) {
  const [selectedPresetId, setSelectedPresetId] = useState(CARD_STAGE_STORY_DEFAULT_PRESET.id);
  const [controls, setControls] = useState<CardStageStoryControls>({ ...CARD_STAGE_STORY_DEFAULT_PRESET.controls });
  const [extraThreadCount, setExtraThreadCount] = useState(0);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const { setCollapsedProperties } = useCardStageCollapsedProperties();
  const {
    sansFontSize,
    codeFontSize,
    setSansFontSize,
    setCodeFontSize,
    fontSizeVariables,
  } = useDevStoryFontSize();

  const pushLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setActionLog((previous) => [`${timestamp} - ${message}`, ...previous].slice(0, 12));
  }, []);

  useEffect(() => {
    setCollapsedProperties(buildCardStageStoryCollapsedProperties(controls));
  }, [controls, setCollapsedProperties]);

  const applyPreset = useCallback((presetId: string) => {
    const preset = resolveCardStageStoryPreset(presetId);
    const nextControls = { ...preset.controls };

    setSelectedPresetId(preset.id);
    setControls(nextControls);
    setExtraThreadCount(0);
    setActionLog([]);
    setCollapsedProperties(buildCardStageStoryCollapsedProperties(nextControls));
  }, [setCollapsedProperties]);

  const updateControl = useCallback(
    <K extends keyof CardStageStoryControls>(key: K, value: CardStageStoryControls[K]) => {
      setSelectedPresetId("custom");
      setControls((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const card = useMemo(() => buildCardStageStoryCard(controls), [controls]);
  const linkedThreads = useMemo(
    () => buildCardStageStoryThreads(controls, extraThreadCount),
    [controls, extraThreadCount],
  );

  const handleOpenNewThread = useCallback(() => {
    setSelectedPresetId("custom");
    setExtraThreadCount((current) => current + 1);
    pushLog("Queued a mock linked thread from the Threads property row.");
  }, [pushLog]);

  const handleOpenHistoryPanel = useCallback(() => {
    setSelectedPresetId("custom");
    setControls((previous) => {
      const next = !previous.historyPanelActive;
      pushLog(next ? "Marked History as active." : "Marked History as inactive.");
      return { ...previous, historyPanelActive: next };
    });
  }, [pushLog]);

  const handleUpdate = useCallback(async (_columnId: string, cardId: string, updates: Partial<CardInput>) => {
    const changedFields = Object.keys(updates);
    pushLog(
      `Saved ${changedFields.length > 0 ? changedFields.join(", ") : "card changes"} for ${cardId}.`,
    );
  }, [pushLog]);

  const handleMove = useCallback(async (_fromColumnId: string, cardId: string, toColumnId: string) => {
    pushLog(`Moved ${cardId} to ${toColumnId}.`);
  }, [pushLog]);

  const threadCountLabel = linkedThreads.length === 1 ? "1 linked thread" : `${linkedThreads.length} linked threads`;
  const currentPreset = selectedPresetId === "custom"
    ? null
    : CARD_STAGE_STORY_PRESETS.find((preset) => preset.id === selectedPresetId) ?? CARD_STAGE_STORY_DEFAULT_PRESET;

  return (
    <div
      className="h-screen min-h-0 bg-(--background) text-(--foreground)"
      style={fontSizeVariables}
    >
      <div className="flex h-full min-h-0">
        <aside className="scrollbar-token w-88 shrink-0 overflow-y-auto border-r border-(--border) bg-(--background-secondary)">
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold">Card Stage Story</div>
              <div className="text-sm/normal text-(--foreground-secondary)">
                Development-only mock page for refining the full card stage, with extra coverage for the <code>Threads</code> property row.
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded-sm border border-(--border) bg-(--background) px-1.5 py-1 text-xs">
                  ?dev-story=card-stage
                </code>
                <button
                  type="button"
                  className="h-7 rounded-sm border border-(--border) px-2.5 text-xs transition-colors hover:bg-(--background-tertiary)"
                  onClick={onExit}
                >
                  Back to app
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Presets</div>
              <div className="space-y-1.5">
                {CARD_STAGE_STORY_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    className={cn(
                      "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                      selectedPresetId === preset.id
                        ? "border-(--foreground) bg-(--background)"
                        : "border-(--border) bg-(--background) hover:bg-(--background-tertiary)",
                    )}
                  >
                    <div className="text-sm font-medium">{preset.name}</div>
                    <div className="mt-0.5 text-xs text-(--foreground-tertiary)">{preset.description}</div>
                  </button>
                ))}
              </div>
              {selectedPresetId === "custom" && (
                <div className="rounded-md border border-dashed border-(--border) px-2.5 py-2 text-xs text-(--foreground-secondary)">
                  Custom state: controls have diverged from the saved presets.
                </div>
              )}
            </div>

            <div className="space-y-2.5">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Controls</div>

              <label className="block text-xs text-(--foreground-secondary)">
                Run target
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.runInTarget}
                  onChange={(event) => updateControl("runInTarget", event.target.value as CardRunInTarget)}
                >
                  <option value="localProject">localProject</option>
                  <option value="newWorktree">newWorktree</option>
                  <option value="cloud">cloud</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Linked threads
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.threadDensity}
                  onChange={(event) => updateControl("threadDensity", event.target.value as CardStageStoryThreadDensity)}
                >
                  <option value="none">none</option>
                  <option value="few">few</option>
                  <option value="many">many</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Preview text
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.previewMode}
                  onChange={(event) => updateControl("previewMode", event.target.value as CardStageStoryPreviewMode)}
                >
                  <option value="none">none</option>
                  <option value="mixed">mixed</option>
                  <option value="all">all</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.showNewThreadAction}
                  onChange={(event) => updateControl("showNewThreadAction", event.target.checked)}
                />
                Show New action
              </label>

              <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.enableOpenThread}
                  onChange={(event) => updateControl("enableOpenThread", event.target.checked)}
                />
                Thread rows clickable
              </label>

              <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.collapseThreadsByDefault}
                  onChange={(event) => updateControl("collapseThreadsByDefault", event.target.checked)}
                />
                Collapse threads by default
              </label>

              <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.collapseSecondaryProperties}
                  onChange={(event) => updateControl("collapseSecondaryProperties", event.target.checked)}
                />
                Collapse tags + assignee too
              </label>

              <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.historyPanelActive}
                  onChange={(event) => updateControl("historyPanelActive", event.target.checked)}
                />
                History button active
              </label>

              {controls.runInTarget === "newWorktree" && (
                <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
                  <input
                    type="checkbox"
                    checked={controls.existingWorktree}
                    onChange={(event) => updateControl("existingWorktree", event.target.checked)}
                  />
                  Existing worktree path
                </label>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Scenario</div>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-full border border-(--border) bg-(--background) px-2 py-1 text-xs text-(--foreground-secondary)">
                  {controls.runInTarget}
                </span>
                <span className="rounded-full border border-(--border) bg-(--background) px-2 py-1 text-xs text-(--foreground-secondary)">
                  {threadCountLabel}
                </span>
                <span className="rounded-full border border-(--border) bg-(--background) px-2 py-1 text-xs text-(--foreground-secondary)">
                  {controls.collapseThreadsByDefault ? "threads collapsed" : "threads expanded"}
                </span>
                <span className="rounded-full border border-(--border) bg-(--background) px-2 py-1 text-xs text-(--foreground-secondary)">
                  {controls.enableOpenThread ? "open enabled" : "open disabled"}
                </span>
              </div>
              <div className="rounded-md border border-(--border) bg-(--background) px-2.5 py-2 text-xs/relaxed text-(--foreground-secondary)">
                {currentPreset?.description ?? "Manual state for comparing property density, copy, and action placement."}
              </div>
            </div>

            <DevStoryFontSettingsSection
              sansFontSize={sansFontSize}
              codeFontSize={codeFontSize}
              setSansFontSize={setSansFontSize}
              setCodeFontSize={setCodeFontSize}
            />

            <div className="space-y-2">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Action log</div>
              <div className="scrollbar-token max-h-42 space-y-1 overflow-y-auto rounded-md border border-(--border) bg-(--background) p-2">
                {actionLog.length === 0 ? (
                  <div className="text-xs text-(--foreground-tertiary)">No mock actions yet.</div>
                ) : (
                  actionLog.map((entry) => (
                    <div key={entry} className="text-xs/relaxed text-(--foreground-secondary)">
                      {entry}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </aside>

        <main className="scrollbar-token min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,var(--background),color-mix(in_srbg,var(--background),var(--background-secondary)_42%))]">
          <div className="mx-auto flex min-h-full w-full max-w-190 flex-col gap-4 px-5 py-5">
            <section className="rounded-xl border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary),transparent_12%)] px-4 py-3 shadow-[0_16px_40px_rgba(0,0,0,0.2)]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">Mock card stage shell</div>
                  <div className="mt-0.5 text-xs text-(--foreground-secondary)">
                    Uses the real <code>CardStage</code> component with mocked save/open handlers so UI tweaks are isolated from real project state.
                  </div>
                </div>
                <div className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                  {threadCountLabel}
                </div>
              </div>
            </section>

            <section className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-(--border) bg-(--background) shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
              {renderPreview ? (
                <CardStage
                  onClose={() => pushLog("Requested close from the card stage toolbar.")}
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
                  onDelete={async (_columnId: string, cardId: string) => {
                    pushLog(`Requested delete for ${cardId}.`);
                  }}
                  onMove={handleMove}
                  onOpenHistoryPanel={handleOpenHistoryPanel}
                  linkedCodexThreads={linkedThreads}
                  onOpenCodexThread={controls.enableOpenThread
                    ? async (threadId: string) => {
                      pushLog(`Opened mock linked thread ${threadId}.`);
                    }
                    : undefined}
                  onOpenNewCodexThread={controls.showNewThreadAction ? handleOpenNewThread : undefined}
                  historyPanelActive={controls.historyPanelActive}
                />
              ) : (
                <div className="flex h-full min-h-120 items-center justify-center px-6 text-sm text-(--foreground-secondary)">
                  Preview disabled for tests.
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
