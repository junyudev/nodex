import { lazy } from "react";
import { toast } from "@/components/ui/toast";
import type { ScopeHandle } from "./maitai";
import { isModalOpen, openModal, updateOpenModalProps } from "./modal-registry";
import type { PageCreateDraftSnapshot } from "./page-create-draft";
import type { PageCreateOrigin, PageCreateOriginKind } from "./page-create-focus";
import { capturePageCreateSeed, type PageCreateSeed } from "./page-create-selection";
import {
  getPageCreateTarget,
  resolveRegisteredPageCreateTarget,
  type PageCreateTarget,
} from "./page-create-target-registry";

const PageCreateDialog = lazy(async () => ({
  default: (await import("@/components/board/page-create-dialog")).PageCreateDialog,
}));

interface PageCreateRequestBase {
  readonly target: PageCreateTarget;
  readonly origin: PageCreateOrigin;
  readonly initialExpanded?: boolean;
}

export type PageCreateRequest = PageCreateRequestBase &
  (
    | {
        readonly snapshot: PageCreateDraftSnapshot;
        readonly seed?: never;
      }
    | {
        readonly snapshot?: undefined;
        readonly seed?: PageCreateSeed;
      }
  );

type PageCreateDraftRestoreRequest = PageCreateRequestBase & {
  readonly snapshot: PageCreateDraftSnapshot;
};

export interface PageCreateContextRequest {
  readonly activeProjectId: string | null;
  readonly originKind?: PageCreateOriginKind;
  readonly unavailableFeedback?: "silent" | "toast";
  readonly captureSelection?: boolean;
  readonly expanded?: boolean;
}

function focusOpenPageCreateDialog(): void {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        "[data-page-create-dialog] input, [data-page-create-dialog] [contenteditable='true']",
      )
      ?.focus();
  });
}

export function requestPageCreate(appHandle: ScopeHandle, request: PageCreateRequest): boolean {
  if (isModalOpen(appHandle, PageCreateDialog)) {
    if (request.initialExpanded) {
      updateOpenModalProps(appHandle, PageCreateDialog, {
        expandRequestId: crypto.randomUUID(),
      });
    }
    focusOpenPageCreateDialog();
    return true;
  }

  openModal(appHandle, PageCreateDialog, {
    requestId: crypto.randomUUID(),
    target: request.target,
    origin: request.origin,
    restoredSnapshot: request.snapshot,
    seed: request.seed,
    initialExpanded: request.initialExpanded,
  });
  return true;
}

export function requestPageCreateFromContext(
  appHandle: ScopeHandle,
  {
    activeProjectId,
    originKind = "keyboard",
    unavailableFeedback = "toast",
    captureSelection = false,
    expanded = false,
  }: PageCreateContextRequest,
): boolean {
  const resolution = resolveRegisteredPageCreateTarget(appHandle, activeProjectId);
  if (resolution.status === "unavailable") {
    if (unavailableFeedback === "toast") {
      toast.info(resolution.reason, { id: "page-create-target-unavailable" });
    }
    return false;
  }

  const { target, columnId } = resolution;
  const seed =
    captureSelection && typeof window !== "undefined"
      ? (capturePageCreateSeed(window.getSelection()) ?? undefined)
      : undefined;
  return requestPageCreate(appHandle, {
    target,
    seed,
    initialExpanded: expanded,
    origin: {
      surfaceId: target.surfaceId,
      panelTabId: target.panelTabId,
      projectId: target.project.id,
      databaseViewId: target.databaseViewId,
      kind: originKind,
      columnId,
    },
  });
}

export function restorePageCreateDraft(
  appHandle: ScopeHandle,
  request: PageCreateDraftRestoreRequest,
): boolean {
  const mountedTarget = getPageCreateTarget(appHandle, request.target.surfaceId);
  if (!mountedTarget) {
    toast.info("Return to the original Board to restore this Page draft.", {
      id: "page-create-restore-unavailable",
    });
    return false;
  }

  return requestPageCreate(appHandle, {
    target: mountedTarget,
    origin: request.origin,
    snapshot: request.snapshot,
  });
}
