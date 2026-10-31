export type PageCreateOriginKind = "header" | "footer" | "auto-collapsed-column";

export interface PageCreateOrigin {
  readonly surfaceId: string;
  readonly panelTabId: string;
  readonly projectId: string;
  readonly databaseViewId: string;
  readonly kind: PageCreateOriginKind;
  readonly columnId: import("./types").WorkflowStatus;
}

const findElementByDataset = (
  selector: string,
  key: keyof DOMStringMap,
  value: string,
): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  return (
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.dataset[key] === value,
    ) ?? null
  );
};

export const restorePageCreateFocus = (origin: PageCreateOrigin, createdPageId?: string): void => {
  if (typeof document === "undefined") return;

  requestAnimationFrame(() => {
    const surface =
      findElementByDataset(
        "[data-page-create-surface-id], [data-board-surface-id]",
        "pageCreateSurfaceId",
        origin.surfaceId,
      ) ?? findElementByDataset("[data-board-surface-id]", "boardSurfaceId", origin.surfaceId);
    const createdCard = createdPageId
      ? ([...(surface?.querySelectorAll<HTMLElement>("[data-board-uuid-v7]") ?? [])].find(
          (element) => element.dataset.boardUuidV7 === createdPageId,
        ) ?? null)
      : null;
    if (createdCard) {
      createdCard.focus({ preventScroll: true });
      return;
    }

    const originTrigger = [
      ...(surface?.querySelectorAll<HTMLElement>(
        "[data-page-create-trigger][data-page-create-column-id]",
      ) ?? []),
    ].find(
      (element) =>
        element.dataset.pageCreateTrigger === origin.kind &&
        element.dataset.pageCreateColumnId === origin.columnId,
    );
    if (originTrigger) {
      originTrigger.focus();
      return;
    }

    if (surface) {
      surface.focus();
      return;
    }

    const panelTab = findElementByDataset("[data-panel-tab-id]", "panelTabId", origin.panelTabId);
    const panelTabFocusTarget = panelTab?.matches("button,[role='tab']")
      ? panelTab
      : (panelTab?.querySelector<HTMLElement>("button,[role='tab'],[tabindex='0']") ?? null);
    if (panelTabFocusTarget) {
      panelTabFocusTarget.focus({ preventScroll: true });
      return;
    }

    const projectRoot = findElementByDataset(
      "[data-page-create-project-focus-root]",
      "pageCreateProjectFocusRoot",
      origin.projectId,
    );
    projectRoot?.focus({ preventScroll: true });
  });
};
