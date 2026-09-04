import type { PublicBlockTransferIntent } from "../../../shared/block-transfer-transport";
import type { ContentAccessContext } from "../../../shared/content-access-context";
import type {
  LibraryModuleApplyRequest,
  LibraryStructuralHistoryToken,
} from "../../../shared/library-module";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { applyLibraryModule } from "../api";
import { invokeRendererControl } from "../renderer-command";

export { promotionRetentionResources } from "../../../shared/block-transfer";

/** Main retains the exact cleanup request beyond the surface's lifetime. */
export const releaseStructuralHistory = async (
  access: ContentAccessContext,
  storeEpoch: string,
  tokens: readonly LibraryStructuralHistoryToken[],
  apply?: typeof applyLibraryModule,
): Promise<void> => {
  if (tokens.length === 0) return;
  const request: LibraryModuleApplyRequest = {
    operationId: createUuidV7(),
    storeEpoch,
    operation: { kind: "apply_structural_edit", command: { kind: "release_history", tokens } },
  };
  if (apply) {
    const result = await apply(access, request);
    if (!result.ok) throw new Error(result.error.message);
    return;
  }
  const result = await invokeRendererControl("editor-history:release", access, request);
  if (!result.accepted) throw new Error(result.message);
};

export const abandonStructuralHistory = async (
  access: ContentAccessContext,
  request: LibraryModuleApplyRequest,
): Promise<void> => {
  const result = await invokeRendererControl("editor-history:abandon", access, request);
  if (!result.accepted) throw new Error(result.message);
};

export const abandonPromotion = async (request: PublicBlockTransferIntent): Promise<void> => {
  const result = await invokeRendererControl(
    "editor-history:abandon-transfer",
    request.projectId,
    request,
  );
  if (!result.accepted) throw new Error(result.message);
};
