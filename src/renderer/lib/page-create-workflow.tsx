import { lazy } from "react";
import { toast } from "@/components/ui/toast";
import type { ScopeHandle } from "./maitai";
import { isModalOpen, openModal } from "./modal-registry";
import type { PageCreateDraftSnapshot } from "./page-create-draft";
import type { PageCreateOrigin } from "./page-create-focus";
import { getPageCreateTarget, type PageCreateTarget } from "./page-create-target-registry";

const PageCreateDialog = lazy(async () => ({
  default: (await import("@/components/board/page-create-dialog")).PageCreateDialog,
}));

export interface PageCreateRequest {
  readonly target: PageCreateTarget;
  readonly origin: PageCreateOrigin;
  readonly snapshot?: PageCreateDraftSnapshot;
}

interface PageCreateDraftRestoreRequest extends PageCreateRequest {
  readonly snapshot: PageCreateDraftSnapshot;
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
    focusOpenPageCreateDialog();
    return true;
  }

  openModal(appHandle, PageCreateDialog, {
    requestId: crypto.randomUUID(),
    target: request.target,
    origin: request.origin,
    restoredSnapshot: request.snapshot,
  });
  return true;
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
