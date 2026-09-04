import type { DocumentHeadFence } from "./block-document-surface-runtime";
import type { DocumentWaitOptions } from "./document-wait";

/**
 * One mounted editor's complete preparation boundary for a structural command.
 * The participant settles transient editor state before returning the durable
 * Document head that Core must recheck.
 */
export interface BlockDocumentStructuralMutationParticipant {
  readonly documentId?: string;
  readonly prepareAndFence: (options?: DocumentWaitOptions) => Promise<DocumentHeadFence>;
}

/**
 * Resolves the live structural participant for a mounted document surface.
 * Drag payloads carry this renderer-local identity so a target can prepare the
 * actual source editor before Core captures its structural fence.
 */
const participants = new Map<string, Map<number, BlockDocumentStructuralMutationParticipant>>();
let nextRegistrationId = 1;

export const registerBlockDocumentStructuralMutationParticipant = (
  surfaceId: string,
  participant: BlockDocumentStructuralMutationParticipant,
): (() => void) => {
  const registrationId = nextRegistrationId;
  nextRegistrationId += 1;
  const registrations = participants.get(surfaceId) ?? new Map();
  registrations.set(registrationId, participant);
  participants.set(surfaceId, registrations);
  return () => {
    const current = participants.get(surfaceId);
    if (!current || !current.delete(registrationId)) return;
    if (current.size === 0) participants.delete(surfaceId);
  };
};

export const resolveBlockDocumentStructuralMutationParticipant = (
  surfaceId: string,
): BlockDocumentStructuralMutationParticipant | null => {
  const registrations = participants.get(surfaceId);
  if (!registrations || registrations.size === 0) return null;
  return [...registrations.values()].at(-1) ?? null;
};

export const resolveBlockDocumentStructuralMutationParticipantByDocumentId = (
  documentId: string,
): BlockDocumentStructuralMutationParticipant | null => {
  let match: BlockDocumentStructuralMutationParticipant | null = null;
  let matchRegistrationId = -1;
  for (const registrations of participants.values()) {
    for (const [registrationId, participant] of registrations) {
      if (participant.documentId !== documentId || registrationId <= matchRegistrationId) continue;
      match = participant;
      matchRegistrationId = registrationId;
    }
  }
  return match;
};
