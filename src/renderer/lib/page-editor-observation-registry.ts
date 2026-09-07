import type {
  BlockDocumentSurfaceStatus,
  DocumentHeadFence,
} from "./block-document-surface-runtime";
import type { DocumentWaitOptions } from "./document-wait";

export interface PageEditorObservationParticipant {
  readonly read: () => {
    readonly mounted: boolean;
    readonly transientInput: boolean;
    readonly status: BlockDocumentSurfaceStatus;
  };
  readonly prepare: (options: DocumentWaitOptions) => Promise<DocumentHeadFence>;
}

/** Capabilities of actual mounted editors. Exact lease keys keep shared-Document views distinct. */
const participants = new Map<string, PageEditorObservationParticipant>();

export function registerPageEditorObservationParticipant(
  editorSurfaceId: string,
  participant: PageEditorObservationParticipant,
): () => void {
  const registration = { read: participant.read, prepare: participant.prepare };
  participants.set(editorSurfaceId, registration);
  return () => {
    if (participants.get(editorSurfaceId) === registration) participants.delete(editorSurfaceId);
  };
}

export const resolvePageEditorObservationParticipant = (
  editorSurfaceId: string,
): PageEditorObservationParticipant | null => participants.get(editorSurfaceId) ?? null;
