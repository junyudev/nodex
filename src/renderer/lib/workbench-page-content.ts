import { contentAccessContextKey } from "../../shared/content-access-context";
import type { WorkbenchSurfaceReference } from "../../shared/nodex-app-tools/workbench";
import type {
  WorkbenchPreparedPageContent,
  WorkbenchPrepareContentRequest,
  WorkbenchPrepareContentResult,
  WorkbenchValidateContentResult,
} from "../../shared/nodex-app-tools/workbench-content";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import { DocumentWaitError } from "./document-wait";
import {
  resolvePageEditorObservationParticipant,
  type PageEditorObservationParticipant,
} from "./page-editor-observation-registry";
import { workbenchPageEditorKey } from "./workbench-page-editor-key";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

type PageSurface = Extract<WorkbenchSurfaceReference, { kind: "page_stage" }>;
type EditorState = ReturnType<PageEditorObservationParticipant["read"]>;
interface Preparation {
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly surface: PageSurface;
  readonly participant: PageEditorObservationParticipant;
  readonly ready: WorkbenchPreparedPageContent;
  readonly expiresAt: number;
}
const PREPARATION_TTL_MS = 30_000;
const PREPARE_WAIT_MS = 8_000;
const MAX_PREPARATIONS = 128;

const samePage = (left: PageSurface, right: PageSurface) =>
  left.id === right.id &&
  left.config.pageId === right.config.pageId &&
  contentAccessContextKey(left.config.accessContext) ===
    contentAccessContextKey(right.config.accessContext);
const pending = (state: EditorState): boolean =>
  state.transientInput ||
  !state.status.ready ||
  state.status.reloadRequired ||
  state.status.provider.phase !== "synced" ||
  !state.status.provider.connected ||
  state.status.provider.pendingUpdateCount !== 0 ||
  state.status.provider.inFlightUpdateId !== undefined ||
  state.status.provider.recovery !== undefined ||
  !Number.isSafeInteger(state.status.provider.checkpoint.localVersion);
const matchesPage = (state: EditorState, surface: PageSurface): boolean => {
  const { descriptor, provider } = state.status;
  return (
    state.mounted &&
    descriptor.ownerType === "page" &&
    descriptor.ownerBlockId === surface.config.pageId &&
    descriptor.ownerLifecycle === "active" &&
    descriptor.readiness === "ready" &&
    descriptor.documentId === provider.documentId &&
    descriptor.storeEpoch === provider.storeEpoch &&
    descriptor.generation === provider.generation &&
    contentAccessContextKey(descriptor.accessContext) ===
      contentAccessContextKey(surface.config.accessContext)
  );
};

/** One bridge generation owns these short-lived proofs; content and Scene state stay with their owners. */
export function createWorkbenchPageContent(
  owner: WorkbenchWindowOwner,
  options: {
    readonly resolve?: (editorSurfaceId: string) => PageEditorObservationParticipant | null;
    readonly now?: () => number;
  } = {},
) {
  const resolve = options.resolve ?? resolvePageEditorObservationParticipant;
  const now = options.now ?? Date.now;
  const preparations = new Map<string, Preparation>();
  let disposed = false;
  const page = (sceneOwner: WorkbenchSceneOwner, tabId: string): PageSurface | null => {
    const surface = readWorkbenchAgentContext(owner.read(), sceneOwner)?.tabs.find(
      (tab) => tab.tabId === tabId,
    )?.surface;
    return surface?.kind === "page_stage" ? surface : null;
  };
  return {
    async prepare(
      input: WorkbenchPrepareContentRequest,
      signal: AbortSignal,
      isCurrent: () => boolean,
    ): Promise<WorkbenchPrepareContentResult> {
      if (disposed || signal.aborted || !isCurrent()) return { status: "cancelled" };
      if (owner.read().presentationRevision !== input.expectedPresentationRevision)
        return { status: "stale_presentation" };
      const surface = page(input.sceneOwner, input.tabId);
      if (!surface) return { status: "surface_unavailable" };
      const editorSurfaceId = workbenchPageEditorKey(input.sceneOwner, input.tabId);
      const participant = resolve(editorSurfaceId);
      if (!participant) return { status: "surface_unavailable" };
      const before = participant.read();
      if (!matchesPage(before, surface)) return { status: "surface_unavailable" };
      if (before.transientInput) return { status: "pending_local_edits" };
      try {
        const fence = await participant.prepare({ signal, deadlineAt: now() + PREPARE_WAIT_MS });
        if (disposed || signal.aborted || !isCurrent()) return { status: "cancelled" };
        if (owner.read().presentationRevision !== input.expectedPresentationRevision)
          return { status: "stale_presentation" };
        if (resolve(editorSurfaceId) !== participant) return { status: "surface_unavailable" };
        const after = participant.read();
        if (
          !matchesPage(after, surface) ||
          fence.documentId !== after.status.descriptor.documentId ||
          fence.storeEpoch !== after.status.provider.storeEpoch ||
          fence.generation !== after.status.provider.generation
        )
          return { status: "surface_unavailable" };
        if (pending(after) || after.status.provider.headSeq < fence.expectedHeadSeq)
          return { status: "pending_local_edits" };
        const preparedAt = now();
        for (const [token, value] of preparations)
          if (value.expiresAt <= preparedAt) preparations.delete(token);
        if (preparations.size >= MAX_PREPARATIONS) return { status: "surface_unavailable" };
        const expiresAt = preparedAt + PREPARATION_TTL_MS;
        const ready: WorkbenchPreparedPageContent = {
          status: "ready",
          token: crypto.randomUUID(),
          editorSurfaceId,
          pageId: surface.config.pageId,
          documentId: fence.documentId,
          libraryId: after.status.descriptor.libraryId,
          accessContext: surface.config.accessContext,
          storeEpoch: fence.storeEpoch,
          generation: fence.generation,
          expectedHeadSeq: after.status.provider.headSeq,
          localEditRevision: after.status.provider.checkpoint.localVersion!,
          preparedAt: new Date(preparedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
        };
        preparations.set(ready.token, {
          sceneOwner: input.sceneOwner,
          surface,
          participant,
          ready,
          expiresAt,
        });
        return ready;
      } catch (error) {
        if (
          disposed ||
          signal.aborted ||
          !isCurrent() ||
          (error instanceof DocumentWaitError && error.reason === "cancelled")
        )
          return { status: "cancelled" };
        return { status: "pending_local_edits" };
      }
    },
    validate(token: string, isCurrent: () => boolean): WorkbenchValidateContentResult {
      if (disposed || !isCurrent()) return { status: "cancelled" };
      const preparation = preparations.get(token);
      preparations.delete(token);
      if (!preparation || preparation.expiresAt <= now()) return { status: "expired" };
      const { ready, participant, surface, sceneOwner } = preparation;
      const currentSurface = page(sceneOwner, surface.id);
      if (
        !currentSurface ||
        !samePage(surface, currentSurface) ||
        resolve(ready.editorSurfaceId) !== participant
      )
        return { status: "surface_unavailable" };
      const current = participant.read();
      if (
        !matchesPage(current, surface) ||
        current.status.provider.storeEpoch !== ready.storeEpoch ||
        current.status.provider.generation !== ready.generation
      )
        return { status: "surface_unavailable" };
      if (
        pending(current) ||
        current.status.provider.checkpoint.localVersion !== ready.localEditRevision ||
        current.status.provider.headSeq < ready.expectedHeadSeq
      )
        return { status: "pending_local_edits" };
      return {
        status: "synchronized",
        token,
        checkedAt: new Date(now()).toISOString(),
        headSeq: current.status.provider.headSeq,
        localEditRevision: ready.localEditRevision,
      };
    },
    dispose: () => {
      disposed = true;
      preparations.clear();
    },
  };
}
