import { getIntl } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import type {
  BrowserAnnotationAttachment,
  BrowserSavedAnnotation,
} from "../../../shared/browser-annotation";
import { invokeBrowserSidebarCommand } from "./browser-sidebar-commands";
import { invokeRendererQuery } from "@/lib/renderer-command";
export type { BrowserAnnotationAttachment } from "../../../shared/browser-annotation";

const EMPTY: readonly BrowserAnnotationAttachment[] = [];
let annotations: readonly BrowserSavedAnnotation[] = [];
let revision = 0;
const projections = new Map<string, readonly BrowserAnnotationAttachment[]>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
function publish(next: readonly BrowserSavedAnnotation[]): void {
  annotations = next;
  revision++;
  projections.clear();
  for (const listener of listeners) listener();
}
export function getBrowserAnnotationAttachmentsSnapshot(
  destination: string,
): readonly BrowserAnnotationAttachment[] {
  const existing = projections.get(destination);
  if (existing) return existing;
  const selected = annotations
    .filter(
      (annotation) =>
        annotation.destination === destination && annotation.deliveryState !== "sending",
    )
    .map(({ destination: _destination, ...attachment }) => attachment);
  const result = selected.length ? selected : EMPTY;
  projections.set(destination, result);
  return result;
}
export function subscribeBrowserAnnotationAttachments(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribe && window.api) {
    unsubscribe = window.api.on("browser-annotations", (value) =>
      publish(value as BrowserSavedAnnotation[]),
    );
    const initial = revision;
    void invokeRendererQuery("browser-sidebar-runtime-snapshot")
      .then((snapshot) => {
        if (initial === revision) publish(snapshot.annotations ?? []);
      })
      .catch((error) => console.warn("Could not load Browser annotations", error));
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    unsubscribe?.();
    unsubscribe = undefined;
  };
}
export function removeBrowserAnnotationAttachment(destination: string, id: string): void {
  clearBrowserAnnotationAttachments(destination, [id]);
}
/** Consume the exact admitted set, so annotations saved while sending remain pending. */
export function clearBrowserAnnotationAttachments(
  destination: string,
  ids: readonly string[],
): void {
  if (!ids.length) return;
  void invokeBrowserSidebarCommand({ type: "consume-annotations", destination, ids: [...ids] })
    .then((result) => {
      if (!result.ok) toast.danger(result.message);
    })
    .catch((error: unknown) => {
      console.warn("Could not remove Browser annotations", { destination, ids, error });
      toast.danger(
        getIntl().formatMessage({
          id: "browser.browserAnnotationAttachments.removeFailed",
          defaultMessage: "Could not remove Browser annotations",
        }),
      );
    });
}

/** Wait for this saved set's capture work without relying on renderer paint or fixed sleeps. */
export function waitForBrowserAnnotationEvidence(
  destination: string,
  ids: readonly string[],
): Promise<readonly BrowserAnnotationAttachment[]> {
  return new Promise((resolve) => {
    let stop = () => {};
    const finish = () => {
      clearTimeout(timer);
      stop();
      resolve(
        annotations
          .filter((entry) => entry.destination === destination && ids.includes(entry.id))
          .map(({ destination: _destination, ...entry }) => entry),
      );
    };
    const check = () => {
      const selected = annotations.filter(
        (entry) => entry.destination === destination && ids.includes(entry.id),
      );
      if (
        selected.length === ids.length &&
        selected.every((entry) => entry.evidenceState !== "pending")
      )
        finish();
    };
    const timer = setTimeout(finish, 5_000);
    stop = subscribeBrowserAnnotationAttachments(check);
    check();
  });
}
