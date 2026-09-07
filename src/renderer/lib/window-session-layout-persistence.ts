import { WorkbenchLayoutSnapshotSchema } from "../../shared/schemas/workbench-layout";
import type {
  WindowSessionBootstrap,
  WindowSessionSaveLayoutInput,
} from "../../shared/window-session";
import type { WorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import type {
  WorkbenchWindowPersistenceReceipt,
  WorkbenchWindowPersistenceSnapshot,
} from "./workbench-window-owner";

export class WorkbenchLayoutCommitRejected extends Error {
  constructor(readonly acceptedLayoutRevision: number) {
    super("Window Session did not accept the requested layout snapshot");
    this.name = "WorkbenchLayoutCommitRejected";
  }
}

/** One save sequence serves both debounced UI changes and exact command commits. */
export function createWindowSessionLayoutPersistence(input: {
  readonly sessionId: string;
  readonly initialRevision: number;
  readonly initialLayout: WorkbenchLayoutSnapshot;
  readonly save: (input: WindowSessionSaveLayoutInput) => Promise<WindowSessionBootstrap>;
}) {
  let acceptedRevision = input.initialRevision;
  let acceptedSerialized = JSON.stringify(WorkbenchLayoutSnapshotSchema.parse(input.initialLayout));
  let saveChain: Promise<void> = Promise.resolve();

  const commit = (
    snapshot: WorkbenchWindowPersistenceSnapshot,
  ): Promise<WorkbenchWindowPersistenceReceipt> => {
    // Capture before entering the async queue; a later presentation must not change this receipt.
    const layout = WorkbenchLayoutSnapshotSchema.parse(snapshot.layout);
    const serialized = JSON.stringify(layout);
    const presentationRevision = snapshot.presentationRevision;
    const save = saveChain.then(async () => {
      if (serialized !== acceptedSerialized) {
        const revision = acceptedRevision + 1;
        const accepted = await input.save({ sessionId: input.sessionId, revision, layout });
        if (accepted.session.id !== input.sessionId)
          throw new WorkbenchLayoutCommitRejected(accepted.session.layoutRevision);
        acceptedRevision = Math.max(acceptedRevision, accepted.session.layoutRevision);
        acceptedSerialized = JSON.stringify(
          WorkbenchLayoutSnapshotSchema.parse(accepted.session.layout),
        );
        if (accepted.session.layoutRevision < revision || acceptedSerialized !== serialized) {
          throw new WorkbenchLayoutCommitRejected(accepted.session.layoutRevision);
        }
      }
      return {
        sessionId: input.sessionId,
        layoutRevision: acceptedRevision,
        presentationRevision,
        layout,
      };
    });
    // One failed save rejects its callers without preventing later repair attempts.
    saveChain = save.then(
      () => undefined,
      () => undefined,
    );
    return save;
  };

  return { commit };
}
