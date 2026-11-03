import type { MutableRefObject } from "react";
import type { OwnedDocumentDescriptor } from "../../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { DocumentSessionRegistry, EditorSurfaceLease } from "@/lib/document-session-registry";

interface SessionSnapshot {
  readonly session: EditorSurfaceLease | null;
  readonly startupError: Error | null;
}

const EMPTY: SessionSnapshot = { session: null, startupError: null };
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** Publishes the external registry lease held by one committed editor view. */
export class PageEditorSessionObservation {
  private snapshot: SessionSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: SessionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  readonly clear = () => this.publish(EMPTY);

  attach(input: {
    readonly registry: Pick<DocumentSessionRegistry, "acquire" | "dispose">;
    readonly sessionKey: string;
    readonly descriptor: OwnedDocumentDescriptor;
    readonly createRuntime: () => BlockDocumentSurfaceRuntime;
    readonly runtimeRef?: MutableRefObject<BlockDocumentSurfaceRuntime | null>;
    readonly retainModel: () => boolean;
  }): () => void {
    let live = true;
    let session: EditorSurfaceLease | null = null;
    let viewGeneration = 0;
    this.clear();
    try {
      session = input.registry.acquire({
        key: input.sessionKey,
        descriptor: input.descriptor,
        createRuntime: input.createRuntime,
      });
      viewGeneration = session.claimView();
      if (input.runtimeRef) input.runtimeRef.current = session.runtime;
      this.publish({ session, startupError: null });
      void session.connect().catch((error: unknown) => {
        if (!live || this.snapshot.session !== session) return;
        this.publish({ session, startupError: toError(error) });
      });
    } catch (error) {
      this.publish({ session: null, startupError: toError(error) });
    }
    return () => {
      live = false;
      if (input.runtimeRef && input.runtimeRef.current === session?.runtime)
        input.runtimeRef.current = null;
      if (!session) return;
      const retainModel = input.retainModel();
      const released = session.releaseView(viewGeneration, { persist: retainModel });
      if (!released || retainModel) return;
      void input.registry.dispose(input.sessionKey, session).catch(() => undefined);
    };
  }
}
