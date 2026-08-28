import { useCallback, useEffect, useMemo, useState } from "react";
import { XIcon } from "@/components/shared/icons/generic-icons";
import { PageIcon } from "@/components/shared/icons";
import { PageStage } from "./page-stage-dev-story-deps";
import { ReadonlyNfmBlockNotePreview } from "../editor/readonly-nfm-blocknote-preview";
import type { PageInput } from "../../../lib/types";
import {
  projectPageDetailToStageModel,
  type PageStagePageModel,
} from "../../../lib/page-stage-page";
import {
  buildPageStageStoryPage,
  buildPageStageStoryChats,
  PAGE_STAGE_STORY_PROJECT_ID,
  PAGE_STAGE_STORY_WORKSPACE_PATH,
  type PageStageStoryControls,
} from "./page-stage-dev-story-data";
import { createPageStageStoryDocument } from "./page-stage-story-document";
import { projectContentAccess } from "../../../../shared/content-access-context";
import { buildPageDetailStoryResult } from "./page-stage-story-page-detail";
import { readPageStageSemanticProperties } from "../../../lib/page-stage-properties";

export interface PageStageDevStoryPageProps extends PageStageStoryControls {
  renderPreview?: boolean;
  descriptionVariant?: "default" | "heading-rail" | "few-headings";
  standalone?: boolean;
  schemaVariant?:
    | "default"
    | "sparse-custom"
    | "missing-due-date"
    | "missing-assignee"
    | "missing-status"
    | "status-only-primary"
    | "single-schedule-boundary"
    | "empty-values"
    | "corrupt-property";
}

const headingRailDescription = [
  "# Heading rail parity",
  "",
  "This fixture has enough heading blocks for the automatic right navigation rail.",
  "",
  "## Capture goals",
  "Use this section to verify the marker rail in the right page gutter.",
  "",
  "### Marker states",
  "Markers should use active state, hover feedback, and compact spacing.",
  "",
  "## Scrub interaction",
  "Drag over the rail to jump between headings without opening a popup.",
  "",
  "### Interaction",
  "Click a row to jump to the matching heading while preserving the editor surface.",
  "",
  "## Tooltip preview",
  "Hover a marker to inspect the shared tooltip shell and heading preview.",
  "",
  "### Layout",
  "The rail appears only when the right gutter has room for marker navigation.",
  "",
  "## Final section",
  "Scrolling near this block should move the active indicator.",
].join("\n");

const fewHeadingsDescription = [
  "# Short document",
  "",
  "The automatic heading rail should stay hidden when fewer than four headings exist.",
  "",
  "## Only one section",
  "This short fixture should keep the editor free of navigation chrome.",
].join("\n");

export function PageStageDevStoryPage({
  chatDensity,
  showNewChatAction,
  enableOpenChat,
  historyPanelActive: initialHistoryPanelActive,
  renderPreview = true,
  descriptionVariant = "default",
  standalone = false,
  schemaVariant = "default",
}: PageStageDevStoryPageProps) {
  const [extraChatCount, setExtraChatCount] = useState(0);
  const [historyPanelActive, setHistoryPanelActive] = useState(initialHistoryPanelActive);

  useEffect(() => {
    setExtraChatCount(0);
    setHistoryPanelActive(initialHistoryPanelActive);
  }, [
    enableOpenChat,
    initialHistoryPanelActive,
    descriptionVariant,
    showNewChatAction,
    standalone,
    schemaVariant,
    chatDensity,
  ]);

  const page = useMemo(() => buildPageStageStoryPage(), []);
  const displayPage = useMemo(() => {
    const description =
      descriptionVariant === "heading-rail"
        ? headingRailDescription
        : descriptionVariant === "few-headings"
          ? fewHeadingsDescription
          : page.description;
    return {
      ...page,
      description,
      ...(schemaVariant === "empty-values"
        ? {
            priority: undefined,
            estimate: undefined,
            tags: [],
            dueDate: undefined,
            scheduledStart: undefined,
            scheduledEnd: undefined,
            assignee: undefined,
          }
        : {}),
    };
  }, [page, descriptionVariant, schemaVariant]);
  const stagePage = useMemo((): PageStagePageModel => {
    const result = buildPageDetailStoryResult(PAGE_STAGE_STORY_PROJECT_ID, displayPage);
    if (!result.ok) throw new Error(result.error.message);
    const projected = projectPageDetailToStageModel(result.value);
    if (standalone) {
      return {
        ...projected,
        page: { ...projected.page, pageKey: null },
        databaseContext: { kind: "standalone" },
      };
    }
    if (
      schemaVariant === "default" ||
      schemaVariant === "empty-values" ||
      projected.databaseContext.kind !== "member"
    ) {
      return projected;
    }
    const omittedByVariant: Readonly<
      Record<
        Exclude<
          NonNullable<PageStageDevStoryPageProps["schemaVariant"]>,
          "default" | "empty-values" | "corrupt-property"
        >,
        readonly string[]
      >
    > = {
      "sparse-custom": ["priority", "tags", "due_date", "assignee"],
      "missing-due-date": ["due_date"],
      "missing-assignee": ["assignee"],
      "missing-status": ["status"],
      "status-only-primary": ["priority", "estimate", "due_date"],
      "single-schedule-boundary": ["scheduled_end"],
    };
    const omitted = new Set(
      schemaVariant === "corrupt-property" ? [] : omittedByVariant[schemaVariant],
    );
    const properties = projected.databaseContext.properties
      .filter((item) => !omitted.has(item.property.propertyId))
      .map((item) =>
        schemaVariant === "corrupt-property" && item.property.propertyId === "due_date"
          ? { ...item, value: "not-a-date", error: "Expected an ISO date" }
          : item,
      );
    return {
      ...projected,
      databaseContext: {
        ...projected.databaseContext,
        properties,
        semanticProperties: readPageStageSemanticProperties(properties),
      },
    };
  }, [displayPage, schemaVariant, standalone]);
  const storyDocument = useMemo(
    () =>
      createPageStageStoryDocument({
        projectId: PAGE_STAGE_STORY_PROJECT_ID,
        pageId: displayPage.id,
        title: displayPage.title,
        description: displayPage.description,
      }),
    [displayPage.description, displayPage.id, displayPage.title],
  );
  useEffect(() => storyDocument.destroy, [storyDocument]);
  const relatedChats = useMemo(
    () => buildPageStageStoryChats({ chatDensity }, extraChatCount),
    [chatDensity, extraChatCount],
  );
  const historySnapshotDescription = useMemo(
    () =>
      [
        displayPage.description,
        "## Snapshot preview",
        "This read-only preview uses the same BlockNote rendering path as Page Detail.",
        "- Stable text, lists, and links render normally",
        "- Live page/thread embeds stay inert inside history",
        'Before <attachment kind="file" mode="link" source="/tmp/history-notes.md" name="history-notes.md" /> after',
        'Use <agent-config mode="plan" model="gpt-5.5" reasoning="high" /> for this prompt',
        '<page-ref url="nodex://pages/page-stage-preview" />',
        '<thread-section label="Follow-up investigation" thread="thr_preview" />',
        '<database-view-ref database-view="page-stage-view" display-hint="Planning" />',
      ].join("\n\n"),
    [displayPage.description],
  );

  const handleOpenNewChat = useCallback(() => {
    setExtraChatCount((current) => current + 1);
  }, []);

  const handleToggleHistoryPanel = useCallback(() => {
    setHistoryPanelActive((current) => !current);
  }, []);

  const handleUpdate = useCallback(async (pageId: string, updates: Partial<PageInput>) => {
    void pageId;
    void updates;
    return { status: "updated", didMutate: true } as const;
  }, []);

  const threadCountLabel =
    relatedChats.length === 1 ? "1 linked chat" : `${relatedChats.length} linked chats`;

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-[linear-gradient(180deg,var(--background),color-mix(in_srgb,var(--background),var(--background-secondary)_42%))] text-(--foreground)">
      <div className="mx-auto flex min-h-full w-full max-w-190 flex-col gap-4">
        <section className="rounded-[24px] border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary),transparent_10%)] px-5 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="text-sm font-semibold">Page Detail</div>
              <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
                Production-backed scene for the full page stage and the related-Chat property row.
                Presets and controls now live in Storybook stories and the Controls panel, not
                inside the canvas.
              </div>
            </div>
            <div className="flex max-w-sm flex-wrap justify-end gap-2">
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {threadCountLabel}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {historyPanelActive ? "history active" : "history idle"}
              </span>
            </div>
          </div>
        </section>

        <section className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-(--border) bg-(--background) shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
          {renderPreview ? (
            <PageStage
              contentAccessContext={projectContentAccess(PAGE_STAGE_STORY_PROJECT_ID)}
              key={descriptionVariant}
              onClose={() => undefined}
              page={stagePage}
              projectWorkspacePath={PAGE_STAGE_STORY_WORKSPACE_PATH}
              documentAuthority={storyDocument.authority}
              onUpdate={handleUpdate}
              onUpdateProperty={async () => ({
                status: "updated",
                didMutate: true,
              })}
              {...(stagePage.databaseContext.kind === "member"
                ? {
                    onDelete: async () => {},
                  }
                : {})}
              onToggleHistoryPanel={handleToggleHistoryPanel}
              relatedChats={relatedChats}
              relatedChatCandidates={[
                {
                  sessionId: "story-candidate",
                  displayTitle: "Review compact relation UI",
                  projectName: "Nodex",
                },
              ]}
              onOpenRelatedChat={enableOpenChat ? async () => {} : undefined}
              onLinkRelatedChat={async () => handleOpenNewChat()}
              onRemoveRelatedChat={async () => undefined}
              onOpenCodexThread={enableOpenChat ? async () => {} : undefined}
              onCreateRelatedChat={showNewChatAction ? handleOpenNewChat : undefined}
              historyPanelActive={historyPanelActive}
            />
          ) : (
            <div className="flex h-full min-h-120 items-center justify-center px-6 text-sm text-(--foreground-secondary)">
              Preview disabled for tests.
            </div>
          )}
        </section>
      </div>

      {historyPanelActive ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-4 py-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setHistoryPanelActive(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Version history"
            className="grid h-[min(92vh,calc(100vh-1.5rem))] w-[min(94vw,1600px)] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)_20rem] overflow-hidden rounded-xl bg-token-dropdown-background/95 text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl max-md:grid-cols-1"
          >
            <div className="flex min-h-0 min-w-0 flex-col bg-token-main-surface-primary">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[0.5px] border-token-border px-3">
                <PageIcon className="icon-2xs shrink-0 text-token-description-foreground" />
                <div className="min-w-0 flex-1 truncate text-sm font-medium text-token-text-secondary">
                  {page.title}
                </div>
                <div className="hidden shrink-0 text-xs text-token-description-foreground sm:block">
                  Today at 10:42
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-3xl">
                  <h2 className="wrap-break-word text-xl/snug-plus font-bold tracking-normal text-token-text-primary">
                    {page.title}
                  </h2>
                  <div className="mt-5 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <div className="contents">
                      <div className="truncate text-token-description-foreground">Status</div>
                      <div className="text-token-text-secondary">In progress</div>
                    </div>
                    <div className="contents">
                      <div className="truncate text-token-description-foreground">Tags</div>
                      <div className="text-token-text-secondary">ui, chats, page-stage</div>
                    </div>
                    <div className="contents">
                      <div className="truncate text-token-description-foreground">Priority</div>
                      <div className="text-token-text-secondary">p2 medium</div>
                    </div>
                  </div>
                  <ReadonlyNfmBlockNotePreview
                    content={historySnapshotDescription}
                    projectId={PAGE_STAGE_STORY_PROJECT_ID}
                    pageId={page.id}
                    historyId="storybook-active"
                    projectWorkspacePath={PAGE_STAGE_STORY_WORKSPACE_PATH}
                    className="mt-8 text-token-text-primary"
                  />
                  <div className="mt-8 rounded-lg bg-token-foreground/5 px-3 py-2 text-xs text-token-description-foreground">
                    Revert controls and field-level diffs remain available below the selected
                    snapshot in production.
                  </div>
                </div>
              </div>
            </div>
            <aside className="flex min-h-0 flex-col border-l border-[0.5px] border-token-border bg-token-bg-fog/70 max-md:border-l-0 max-md:border-t">
              <header className="flex shrink-0 items-start gap-2 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-semibold leading-6 text-token-text-primary">
                    Version history
                  </h3>
                  <div className="mt-0.5 text-xs text-token-description-foreground">3/3</div>
                </div>
                <button
                  type="button"
                  aria-label="Close history panel"
                  onClick={() => setHistoryPanelActive(false)}
                  className="inline-flex size-6 items-center justify-center rounded-full text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
                >
                  <XIcon className="icon-2xs" />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {["Jun 18, 10:42 AM", "Jun 18, 9:16 AM", "Jun 17, 4:08 PM"].map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    className={[
                      "w-full rounded-md px-2.5 py-2 text-left",
                      index === 0 ? "bg-token-foreground/10" : "hover:bg-token-foreground/5",
                    ].join(" ")}
                  >
                    <div className="truncate text-sm font-medium text-token-text-primary">
                      {label}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-token-description-foreground">
                      {index === 0
                        ? "Updated title and tags"
                        : index === 1
                          ? "Moved to In progress"
                          : "Created page"}
                    </div>
                  </button>
                ))}
              </div>
              <footer className="shrink-0 border-t border-[0.5px] border-token-border px-3 py-3">
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="inline-flex h-8 items-center justify-center rounded-lg bg-token-foreground px-3 text-sm text-token-background hover:bg-token-foreground/90"
                  >
                    Restore
                  </button>
                </div>
              </footer>
            </aside>
          </section>
        </div>
      ) : null}
    </div>
  );
}
