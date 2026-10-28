import {
  appScope,
  scopedAtom,
  scopedAtomFamily,
  useScopeHandle,
  useScopedAtom,
} from "@/lib/maitai";
import {
  EMPTY_THREAD_TEXT_SELECTION_CONTEXT,
  type ResponseTextAnnotation,
  type ThreadTextSelectionContext,
} from "../../../shared/thread-text-selection";

export interface ThreadTextSelectionDraftSnapshot extends ThreadTextSelectionContext {
  readonly activeAnnotationId: string | null;
  readonly annotationMode: "create" | "edit";
  readonly annotationDraft: string;
}

interface ThreadTextSelectionDraft extends ThreadTextSelectionDraftSnapshot {
  readonly focusNonce: number;
  readonly submitNonce: number;
}

const emptyDraft: ThreadTextSelectionDraft = {
  ...EMPTY_THREAD_TEXT_SELECTION_CONTEXT,
  activeAnnotationId: null,
  annotationMode: "create",
  annotationDraft: "",
  focusNonce: 0,
  submitNonce: 0,
};

const draftFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "thread-text-selection-draft",
  key: (key: string) => key,
  create: () =>
    scopedAtom<ThreadTextSelectionDraft>(appScope, emptyDraft, {
      debugLabel: "thread-text-selection-draft-value",
    }),
});

/** One draft shared by the transcript and composer, scoped to the execution host and chat. */
export function useThreadTextSelectionDraft(
  hostId: string | null | undefined,
  conversationId: string | null | undefined,
) {
  const app = useScopeHandle(appScope);
  const definition = draftFamily(JSON.stringify([hostId ?? "local", conversationId ?? ""]));
  const [draft, setDraft] = useScopedAtom(definition);
  return {
    draft,
    readSnapshot(): ThreadTextSelectionDraftSnapshot {
      const current = app.get(definition);
      return {
        responseTextAnnotations: current.responseTextAnnotations,
        selectedTextAttachments: current.selectedTextAttachments,
        activeAnnotationId: current.activeAnnotationId,
        annotationMode: current.annotationMode,
        annotationDraft: current.annotationDraft,
      };
    },
    restore(snapshot: ThreadTextSelectionDraftSnapshot) {
      setDraft({ ...snapshot, focusNonce: 0, submitNonce: 0 });
    },
    addAnnotation(annotation: ResponseTextAnnotation) {
      if (!conversationId) return;
      setDraft((current) => ({
        ...current,
        responseTextAnnotations: [...current.responseTextAnnotations, annotation],
        activeAnnotationId: annotation.id,
        annotationMode: "create",
        annotationDraft: "",
      }));
    },
    editAnnotation(id: string | null) {
      setDraft((current) => ({
        ...current,
        activeAnnotationId: id,
        annotationMode: "edit",
        annotationDraft:
          current.responseTextAnnotations.find((entry) => entry.id === id)?.annotation ?? "",
      }));
    },
    updateAnnotation(id: string, comment: string) {
      setDraft((current) =>
        current.activeAnnotationId === id ? { ...current, annotationDraft: comment } : current,
      );
    },
    finishAnnotation(direct = false) {
      setDraft((current) => ({
        ...current,
        responseTextAnnotations: current.responseTextAnnotations.map((entry) =>
          entry.id === current.activeAnnotationId
            ? { ...entry, annotation: current.annotationDraft.trim() || undefined }
            : entry,
        ),
        activeAnnotationId: null,
        annotationDraft: "",
        focusNonce: current.focusNonce + 1,
        submitNonce: direct ? current.submitNonce + 1 : current.submitNonce,
      }));
    },
    escapeAnnotation() {
      setDraft((current) => ({
        ...current,
        activeAnnotationId: null,
        annotationDraft: "",
        responseTextAnnotations:
          current.annotationMode === "create"
            ? current.responseTextAnnotations.filter(
                (entry) => entry.id !== current.activeAnnotationId,
              )
            : current.responseTextAnnotations,
      }));
    },
    consumeSubmission() {
      setDraft((current) => ({ ...current, submitNonce: 0 }));
    },
    consumeFocus() {
      setDraft((current) => ({ ...current, focusNonce: 0 }));
    },
    removeAnnotation(id: string) {
      setDraft((current) => ({
        ...current,
        responseTextAnnotations: current.responseTextAnnotations.filter((entry) => entry.id !== id),
        activeAnnotationId: current.activeAnnotationId === id ? null : current.activeAnnotationId,
      }));
    },
    removeSelection(id: string) {
      setDraft((current) => ({
        ...current,
        selectedTextAttachments: current.selectedTextAttachments.filter((entry) => entry.id !== id),
      }));
    },
    replace(context: ThreadTextSelectionContext, append = false) {
      setDraft((current) => ({
        ...current,
        activeAnnotationId: null,
        responseTextAnnotations: append
          ? mergeById(current.responseTextAnnotations, context.responseTextAnnotations)
          : context.responseTextAnnotations,
        selectedTextAttachments: append
          ? mergeById(current.selectedTextAttachments, context.selectedTextAttachments)
          : context.selectedTextAttachments,
      }));
    },
    clear() {
      setDraft(emptyDraft);
    },
  };
}

function mergeById<T extends { id: string }>(current: readonly T[], added: readonly T[]): T[] {
  const incoming = new Set(added.map((entry) => entry.id));
  return [...current.filter((entry) => !incoming.has(entry.id)), ...added];
}
