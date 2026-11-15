import type { BrowserAnnotationAttachment } from "../../../shared/browser-annotation";

export type BrowserAnnotationAdmission = (
  annotations: readonly BrowserAnnotationAttachment[],
) => Promise<boolean>;
const recipients = new Map<string, BrowserAnnotationAdmission>();

/** Registers a mounted chat's existing admission path, never its draft or attachments. */
export function registerBrowserAnnotationAdmission(
  destination: string,
  admit: BrowserAnnotationAdmission,
): () => void {
  recipients.set(destination, admit);
  return () => {
    if (recipients.get(destination) === admit) recipients.delete(destination);
  };
}

/** Notes are saved before this handoff. Only an acknowledged admission consumes them. */
export async function deliverBrowserAnnotations(input: {
  destination: string;
  annotations: readonly BrowserAnnotationAttachment[];
  consume: (ids: readonly string[]) => Promise<void>;
  admit?: BrowserAnnotationAdmission;
}): Promise<{ admitted: boolean; reason?: string }> {
  const admit = input.admit ?? recipients.get(input.destination);
  if (!admit)
    return { admitted: false, reason: "The chat is unavailable. Your annotations are saved" };
  if (!input.annotations.length)
    return { admitted: false, reason: "There are no annotations to send" };
  try {
    if (!(await admit(input.annotations)))
      return {
        admitted: false,
        reason: "The chat could not accept the message. Your annotations are saved",
      };
  } catch (error) {
    return {
      admitted: false,
      reason: `${error instanceof Error ? error.message : "Could not send to the chat"}. Your annotations are saved`,
    };
  }
  // Admission is final even if clearing its UI projection fails; never retry a delivered message.
  try {
    await input.consume(input.annotations.map((annotation) => annotation.id));
  } catch (error) {
    console.warn("Browser annotations admitted but could not be cleared", {
      destination: input.destination,
      error,
    });
    return { admitted: true, reason: "Message sent, but annotations could not be cleared" };
  }
  return { admitted: true };
}
