import { randomUUID } from "node:crypto";
import type {
  BrowserAnnotationSave,
  BrowserSavedAnnotation,
  BrowserAnnotationAttachmentEvidence,
} from "../../shared/browser-annotation";

export type BrowserAnnotationSaveResult =
  | { ok: true; annotation: BrowserSavedAnnotation }
  | { ok: false; message: string };

/** Tab-owned notes. Physical capture and guest lifetimes belong to their runtime adapters. */
export class BrowserAnnotations {
  private records: BrowserSavedAnnotation[] = [];
  private nextNumber = 1;
  private acknowledgements = new Map<string, string>();
  sessionId: string | null = null;
  destination: string | null = null;

  constructor(
    private readonly publish: (annotations: BrowserSavedAnnotation[]) => void,
    private readonly browserTabId: string,
  ) {}

  save(
    input: BrowserAnnotationSave,
    pageUrl: string,
    pageTitle: string,
  ): BrowserAnnotationSaveResult {
    if (!this.destination || input.destination !== this.destination)
      return { ok: false, message: "This Browser has no matching chat destination" };
    if (input.sessionId !== this.sessionId)
      return { ok: false, message: "This annotation editor is no longer current" };
    if (input.pageUrl !== pageUrl || input.anchors.some((anchor) => anchor.pageUrl !== pageUrl))
      return { ok: false, message: "The page changed. Select the target again" };
    const acknowledged = this.acknowledgements.get(input.editorId);
    const duplicate = this.records.find((record) => record.id === acknowledged);
    if (duplicate) return { ok: true, annotation: duplicate };
    if (acknowledged) return { ok: false, message: "This annotation editor was already saved" };
    if (!input.note.trim() && input.designChanges.length === 0)
      return { ok: false, message: "Write a comment or choose a design change" };
    if (
      input.intent === "designChange" &&
      (!input.designChanges.length ||
        input.designChanges.some(
          (change) =>
            !change.after.trim() || !input.anchors.some((anchor) => anchor.id === change.anchorId),
        ))
    )
      return { ok: false, message: "Choose a design property and value" };
    const previous = this.records.find((record) => record.id === input.annotationId);
    if (input.annotationId && !previous)
      return { ok: false, message: "This annotation was removed" };
    const annotation: BrowserSavedAnnotation = {
      schemaVersion: 1,
      id: previous?.id ?? randomUUID(),
      number: previous?.number ?? this.nextNumber++,
      browserTabId: this.browserTabId,
      createdAt: previous?.createdAt ?? Date.now(),
      destination: input.destination,
      pageUrl,
      pageTitle,
      anchors: input.anchors,
      note: input.note.trim(),
      intent: input.intent,
      designChanges: input.designChanges,
      evidenceState: "pending",
    };
    this.records = [...this.records.filter((record) => record.id !== annotation.id), annotation];
    this.acknowledgements.set(input.editorId, annotation.id);
    this.publish(this.records);
    return { ok: true, annotation };
  }

  evidence(
    id: string,
    created: BrowserSavedAnnotation,
    result: BrowserAnnotationAttachmentEvidence | string,
  ): void {
    // An edit or removal retires a previous capture, even if its physical work finishes later.
    if (!this.records.includes(created)) return;
    this.records = this.records.map((record) =>
      record.id !== id
        ? record
        : typeof result === "string"
          ? { ...record, evidenceState: "failed", evidenceError: result }
          : { ...record, evidenceState: "ready", evidence: result },
    );
    this.publish(this.records);
  }

  remove(ids: readonly string[]): void {
    const records = this.records.filter((record) => !ids.includes(record.id));
    if (records.length === this.records.length) return;
    this.records = records;
    this.publish(records);
  }
}
