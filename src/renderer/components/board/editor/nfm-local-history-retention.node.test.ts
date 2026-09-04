import { expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import type {
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
} from "../../../../shared/library-module";
import { prepareDocumentHistoryRetention } from "../../../lib/document-history-retention";
import { NfmLocalHistoryRetention } from "./nfm-local-history-retention";
import { NfmTextHistoryJournal } from "./nfm-text-history-journal";

const scope = {
  accessContext: { kind: "project", projectId: "project" } as const,
  source: { documentId: "history", generation: 1, storeEpoch: "epoch" },
};
const success = (): LibraryModuleApplyResult => ({
  ok: true,
  localCommit: { status: "no_op", observed: { store_epoch: "epoch", commit_head: 1 } },
  value: {
    operationId: "operation",
    profileId: "profile",
    storeEpoch: "epoch",
    libraryId: "library",
    operationKind: "apply_structural_edit",
    duplicate: false,
    didMutate: false,
    createdTarget: null,
    canvasMutation: null,
    structuralEdit: null,
    affectedParentKeys: [],
    affectedPageIds: [],
    affectedDatabaseIds: [],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 1,
    committedAt: "now",
  },
});
const membership = (request: LibraryModuleApplyRequest) => {
  if (
    request.operation.kind !== "apply_structural_edit" ||
    request.operation.command.kind !== "set_local_history_retention"
  )
    throw new Error("Expected retention membership");
  return request.operation.command.retention;
};
const fixture = (
  apply: (request: LibraryModuleApplyRequest) => Promise<LibraryModuleApplyResult>,
) => {
  const { document } = createPageDocumentGenesis({ documentId: "history", nfm: "One" });
  const body = document.getXmlFragment("body");
  const container = (body.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  const text = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const manager = new Y.UndoManager(body, { trackedOrigins: new Set(["local"]) });
  const journal = new NfmTextHistoryJournal(body, manager);
  const releases: LibraryModuleApplyRequest[] = [];
  const errors: unknown[] = [];
  const retention = new NfmLocalHistoryRetention(document, journal, {
    scope: () => scope,
    apply: async (_access, request) => await apply(request),
    release: async (_access, request) => {
      releases.push(request);
    },
    onError: (error) => errors.push(error),
  });
  return {
    document,
    manager,
    releases,
    retention,
    errors,
    edit: () => document.transact(() => text.insert(0, "X"), "local"),
    close: async () => {
      await retention.close();
      journal.dispose();
      manager.destroy();
      document.destroy();
    },
  };
};

test("typing reuses identity pins and the last reachable group releases them", async () => {
  const requests: LibraryModuleApplyRequest[] = [];
  const f = fixture(async (request) => {
    requests.push(request);
    return success();
  });
  try {
    f.edit();
    await prepareDocumentHistoryRetention(f.document);
    expect(requests).toHaveLength(1);
    expect(membership(requests[0]!).blockIds).toHaveLength(1);
    f.edit();
    f.manager.stopCapturing();
    f.edit();
    await prepareDocumentHistoryRetention(f.document);
    expect(requests).toHaveLength(1);
    f.manager.discardStackItems([f.manager.undoStack[0]!]);
    await prepareDocumentHistoryRetention(f.document);
    expect(requests).toHaveLength(1);
    f.manager.clear();
    await prepareDocumentHistoryRetention(f.document);
    expect(membership(requests[1]!)).toMatchObject({
      blockIds: [],
      retainDocument: false,
      revision: 2,
      closed: false,
    });
    await f.retention.close();
    expect(membership(f.releases[0]!)).toMatchObject({ blockIds: [], closed: true, revision: 3 });
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a lost pin response retries the frozen request before the changed membership", async () => {
  const requests: LibraryModuleApplyRequest[] = [];
  const f = fixture(async (request) => {
    requests.push(request);
    if (requests.length === 1)
      return { ok: false, error: { code: "unknown", message: "lost reply", retryable: true } };
    return success();
  });
  try {
    f.edit();
    await expect(f.retention.flush()).rejects.toThrow("lost reply");
    f.manager.clear();
    await f.retention.flush();
    expect(requests[1]).toBe(requests[0]);
    expect(membership(requests[2]!)).toMatchObject({ blockIds: [], revision: 2 });
  } finally {
    await f.close();
  }
});

test("closing hands off a terminal revision without awaiting the pending pin", async () => {
  let complete!: (result: LibraryModuleApplyResult) => void;
  const response = new Promise<LibraryModuleApplyResult>((resolve) => {
    complete = resolve;
  });
  const requests: LibraryModuleApplyRequest[] = [];
  const f = fixture(async (request) => {
    requests.push(request);
    return await response;
  });
  try {
    f.edit();
    const pending = f.retention.flush();
    await f.retention.close();
    expect(membership(f.releases[0]!)).toMatchObject({ revision: 2, closed: true, blockIds: [] });
    await prepareDocumentHistoryRetention(f.document);
    complete(success());
    await pending;
    expect(requests).toHaveLength(1);
  } finally {
    complete(success());
    await f.close();
  }
});
