import type * as Y from "yjs";
import type { ContentAccessContext } from "../../../../shared/content-access-context";
import type { LibraryModuleApplyRequest } from "../../../../shared/library-module";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { applyLibraryModule } from "../../../lib/api";
import { invokeRendererControl } from "../../../lib/renderer-command";
import { registerDocumentHistoryRetention } from "../../../lib/document-history-retention";
import type { NfmTextHistoryJournal } from "./nfm-text-history-journal";

interface RetentionScope {
  readonly accessContext: ContentAccessContext;
  readonly source: {
    readonly documentId: string;
    readonly generation: number;
    readonly storeEpoch: string;
  };
}
interface RetentionOptions {
  readonly scope: () => RetentionScope;
  readonly apply?: typeof applyLibraryModule;
  readonly release?: (
    access: ContentAccessContext,
    request: LibraryModuleApplyRequest,
  ) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/** Pins only the reachable identity set. Core never receives per-key snapshots.
 * The Provider barrier makes pin admission precede the update that can delete
 * an identity; Main retains exact pending attempts independently of this view.
 */
export class NfmLocalHistoryRetention {
  private readonly surfaceId = createUuidV7();
  private revision = 0;
  private dirty = true;
  private contacted = false;
  private disposed = false;
  private task: Promise<void> | undefined;
  private pending:
    | { readonly access: ContentAccessContext; readonly request: LibraryModuleApplyRequest }
    | undefined;
  private closeTask: Promise<void> | undefined;
  private readonly unregister: () => void;
  private readonly unsubscribe: () => void;

  constructor(
    document: Y.Doc,
    private readonly journal: NfmTextHistoryJournal,
    private readonly options: RetentionOptions,
  ) {
    this.unregister = registerDocumentHistoryRetention(document, this.flush);
    this.unsubscribe = journal.subscribeRetention(this.changed);
  }

  private readonly changed = (): void => {
    this.dirty = true;
    queueMicrotask(() => {
      void this.flush().catch(this.options.onError);
    });
  };

  private request(closed: boolean) {
    const { accessContext, source } = this.options.scope();
    const blockIds = closed ? [] : this.journal.retainedBlockIds();
    const request: LibraryModuleApplyRequest = {
      operationId: createUuidV7(),
      storeEpoch: source.storeEpoch,
      operation: {
        kind: "apply_structural_edit",
        command: {
          kind: "set_local_history_retention",
          retention: {
            surfaceId: this.surfaceId,
            documentId: source.documentId,
            generation: source.generation,
            revision: ++this.revision,
            blockIds,
            retainDocument: blockIds.length > 0,
            closed,
          },
        },
      },
    };
    return { access: accessContext, request };
  }

  readonly flush = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.task) return this.task;
    this.task = this.flushChanges().finally(() => {
      this.task = undefined;
    });
    return this.task;
  };

  private async flushChanges(): Promise<void> {
    while (!this.disposed && (this.dirty || this.pending)) {
      if (!this.pending) {
        if (!this.contacted && this.journal.retainedIdentityCount === 0) {
          this.dirty = false;
          return;
        }
        this.pending = this.request(false);
        this.dirty = false;
      }
      const pending = this.pending;
      this.contacted = true;
      try {
        const result = await (this.options.apply ?? applyLibraryModule)(
          pending.access,
          pending.request,
        );
        if (!result.ok) {
          // Unknown retains the exact identity. An authoritative rejection may
          // retry the current membership, but never permits the Document save.
          if (result.error.code !== "unknown") {
            this.pending = undefined;
            this.dirty = true;
          }
          throw new Error(result.error.message);
        }
        this.pending = undefined;
      } catch (error) {
        if (!this.disposed) throw error;
      }
    }
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.disposed = true;
    this.unregister();
    this.unsubscribe();
    if (!this.contacted) return Promise.resolve();
    const { access, request } = this.request(true);
    this.closeTask = (async () => {
      if (this.options.release) return await this.options.release(access, request);
      const result = await invokeRendererControl("editor-history:release", access, request);
      if (!result.accepted) throw new Error(result.message);
    })();
    return this.closeTask;
  }
}
