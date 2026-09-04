import { describe, expect, test, vi } from "vite-plus/test";
import * as Y from "yjs";
import { registerDocumentHistoryRetention } from "./document-history-retention";
import type {
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncCommandResult,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
} from "../../shared/block-documents/document-sync";
import {
  BLOCK_CONTAINER_NODE_NAME,
  BLOCK_GROUP_NODE_NAME,
  BLOCK_ID_ATTRIBUTE,
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
  REUSABLE_TEMPLATE_SOURCE_TYPE,
  captureXmlSubtreeAt,
  createPageDocument,
  deleteXmlSubtreeAt,
  getRegisteredBlockDocumentSchemaAdapter,
  insertPortableXmlSubtree,
  openPageDocument,
  type RegisteredBlockDocumentSchemaAdapter,
} from "../../shared/block-documents";
import {
  createPageDocumentGenesis,
  materializePageDocument,
} from "../../shared/block-documents/block-document-codec";
import type {
  DocumentCheckpointBoundary,
  DocumentLocalCheckpoint,
  DocumentLocalCheckpointStore,
  DocumentRecoverySnapshot,
} from "./document-local-checkpoint";
import {
  isDocumentApplyAckHeadValid,
  mergeNextBoundedYjsUpdate,
  NodexYProvider,
  type DocumentSyncAdapter,
  type NodexYProviderOptions,
  type NodexYProviderRetryScheduler,
} from "./nodex-y-provider";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Could not create deferred promise");
  }
  return { promise, resolve: resolvePromise };
};

const success = <T>(value: T): DocumentSyncCommandResult<T> => ({
  ok: true,
  value,
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition did not settle");
};

const captureUpdate = (document: Y.Doc, mutate: () => void): Uint8Array => {
  let captured: Uint8Array | undefined;
  const listener = (update: Uint8Array) => {
    captured = update.slice();
  };
  document.on("update", listener);
  try {
    mutate();
  } finally {
    document.off("update", listener);
  }
  if (!captured) {
    throw new Error("Mutation did not produce a Yjs update");
  }
  return captured;
};

const getRootBlockGroup = (document: Y.Doc): Y.XmlElement => {
  const root = openPageDocument(document).body.toArray()[0];
  if (!(root instanceof Y.XmlElement) || root.nodeName !== BLOCK_GROUP_NODE_NAME) {
    throw new TypeError("Expected the canonical Card body blockGroup");
  }
  return root;
};

const findBlockElement = (document: Y.Doc, blockId: string): Y.XmlElement => {
  for (const node of openPageDocument(document).body.createTreeWalker(
    (candidate) => candidate instanceof Y.XmlElement,
  )) {
    if (node instanceof Y.XmlElement && node.getAttribute(BLOCK_ID_ATTRIBUTE) === blockId) {
      return node;
    }
  }
  throw new Error(`Could not find Block ${blockId}`);
};

const getFirstBlockText = (block: Y.XmlElement): Y.XmlText => {
  for (const node of block.createTreeWalker((candidate) => candidate instanceof Y.XmlText)) {
    if (node instanceof Y.XmlText) return node;
  }
  throw new TypeError("Expected the Block to contain text");
};

const getChildBlockGroup = (block: Y.XmlElement): Y.XmlElement | null =>
  block
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName === BLOCK_GROUP_NODE_NAME,
    ) ?? null;

const deleteDirectBlock = (group: Y.XmlElement, blockId: string): void => {
  const index = group
    .toArray()
    .findIndex(
      (node) => node instanceof Y.XmlElement && node.getAttribute(BLOCK_ID_ATTRIBUTE) === blockId,
    );
  if (index < 0) throw new Error(`Could not delete Block ${blockId}`);
  deleteXmlSubtreeAt(group, index);
};

const checkpointKey = (boundary: DocumentCheckpointBoundary): string =>
  JSON.stringify([boundary.documentId, boundary.storeEpoch, boundary.generation]);

class MemoryDocumentLocalCheckpointStore implements DocumentLocalCheckpointStore {
  private readonly checkpoints = new Map<string, DocumentLocalCheckpoint>();
  readonly clearedDocuments: string[] = [];
  readonly writeCalls: DocumentLocalCheckpoint[] = [];
  writeGate: Promise<void> | null = null;
  writeError: Error | null = null;

  read = async (boundary: DocumentCheckpointBoundary): Promise<DocumentLocalCheckpoint | null> => {
    const checkpoint = this.checkpoints.get(checkpointKey(boundary));
    return checkpoint ? { ...checkpoint, state: checkpoint.state.slice() } : null;
  };

  write = async (checkpoint: DocumentLocalCheckpoint): Promise<void> => {
    this.writeCalls.push({ ...checkpoint, state: checkpoint.state.slice() });
    await this.writeGate;
    if (this.writeError) throw this.writeError;
    const key = checkpointKey(checkpoint);
    const existing = this.checkpoints.get(key);
    this.checkpoints.set(key, {
      ...checkpoint,
      headSeq: Math.max(existing?.headSeq ?? 0, checkpoint.headSeq),
      state: existing
        ? Y.mergeUpdates([existing.state, checkpoint.state])
        : checkpoint.state.slice(),
    });
  };

  readonly recoveries: DocumentRecoverySnapshot[] = [];
  recordSubmission: DocumentLocalCheckpointStore["recordSubmission"] = async () => undefined;
  acknowledgeSubmission: DocumentLocalCheckpointStore["acknowledgeSubmission"] = async () =>
    undefined;
  readRecovery: DocumentLocalCheckpointStore["readRecovery"] = async () => this.recoveries;
  quarantine = async (snapshot: DocumentRecoverySnapshot): Promise<void> => {
    if (this.writeError) throw this.writeError;
    await this.writeGate;
    this.recoveries.push(snapshot);
    this.checkpoints.delete(checkpointKey(snapshot));
  };
}

const seedCanonicalPageDocument = (adapter: MemoryDocumentSyncAdapter, title: string): void => {
  const genesis = createPageDocument({
    documentId: "document-1",
    initialTitle: title,
  });
  try {
    Y.applyUpdate(adapter.serverDocument, Y.encodeStateAsUpdate(genesis.document));
    adapter.headSeq = 1;
  } finally {
    genesis.document.destroy();
  }
};

type ProviderDocumentSchema = NonNullable<NodexYProviderOptions["documentSchema"]>;

const seedRegisteredDocument = (
  adapter: MemoryDocumentSyncAdapter,
  schema: ProviderDocumentSchema,
): RegisteredBlockDocumentSchemaAdapter => {
  const schemaAdapter = getRegisteredBlockDocumentSchemaAdapter(schema);
  const genesis = schemaAdapter.create("document-1");
  try {
    Y.applyUpdate(adapter.serverDocument, Y.encodeStateAsUpdate(genesis.document));
    adapter.headSeq = 1;
  } finally {
    genesis.document.destroy();
  }
  return schemaAdapter;
};

const createParagraphBlock = (id: string, value: string): Y.XmlElement => {
  const container = new Y.XmlElement(BLOCK_CONTAINER_NODE_NAME);
  container.setAttribute(BLOCK_ID_ATTRIBUTE, id);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, value);
  paragraph.insert(0, [text]);
  container.insert(0, [paragraph]);
  return container;
};

const recoverDisconnectedRegisteredDocumentEdit = async (input: {
  readonly schema: ProviderDocumentSchema;
  readonly mutate: (document: Y.Doc, adapter: RegisteredBlockDocumentSchemaAdapter) => void;
  readonly assertRecovered: (
    document: Y.Doc,
    adapter: RegisteredBlockDocumentSchemaAdapter,
  ) => void;
}): Promise<void> => {
  const adapter = new MemoryDocumentSyncAdapter();
  const checkpoints = new MemoryDocumentLocalCheckpointStore();
  const schemaAdapter = seedRegisteredDocument(adapter, input.schema);
  const firstDocument = new Y.Doc({ guid: "document-1" });
  const first = new NodexYProvider({
    documentId: "document-1",
    document: firstDocument,
    adapter,
    documentSchema: input.schema,
    clientSessionId: "window-before-generic-restart",
    localCheckpointStore: checkpoints,
    autoConnect: false,
  });
  try {
    await first.connect();
    first.disconnect();
    input.mutate(firstDocument, schemaAdapter);
    await first.checkpoint();
  } finally {
    first.destroy();
    firstDocument.destroy();
  }

  const restartedDocument = new Y.Doc({ guid: "document-1" });
  const restarted = new NodexYProvider({
    documentId: "document-1",
    document: restartedDocument,
    adapter,
    documentSchema: input.schema,
    clientSessionId: "window-after-generic-restart",
    localCheckpointStore: checkpoints,
    autoConnect: false,
  });
  try {
    await restarted.connect();
    await waitUntil(() => {
      try {
        input.assertRecovered(restartedDocument, schemaAdapter);
        return true;
      } catch {
        return false;
      }
    });
    input.assertRecovered(restartedDocument, schemaAdapter);
    await restarted.flush();
    input.assertRecovered(adapter.serverDocument, schemaAdapter);
    expect(adapter.headSeq).toBe(2);
  } finally {
    restarted.destroy();
    restartedDocument.destroy();
    adapter.destroy();
  }
};

class MemoryDocumentSyncAdapter implements DocumentSyncAdapter {
  readonly serverDocument = new Y.Doc({ guid: "document-1" });
  readonly syncCalls: DocumentSyncRequest[] = [];
  readonly applyCalls: DocumentSyncApplyRequest[] = [];
  readonly awarenessCalls: DocumentAwarenessPublishRequest[] = [];
  readonly listeners = new Set<(event: DocumentSyncRealtimeEvent) => void>();
  readonly committedAcks = new Map<string, DocumentSyncApplyAck>();
  storeEpoch = "store-1";
  generation = 1;
  headSeq = 0;
  activeApplyCalls = 0;
  maxActiveApplyCalls = 0;
  emitApplyEcho = true;
  applyHandler:
    | ((
        request: DocumentSyncApplyRequest,
      ) => Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>>)
    | null = null;
  syncHandler:
    | ((request: DocumentSyncRequest) => Promise<DocumentSyncCommandResult<DocumentSyncResponse>>)
    | null = null;

  sync = async (
    request: DocumentSyncRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncResponse>> => {
    this.syncCalls.push(request);
    if (this.syncHandler) return this.syncHandler(request);
    return success({
      documentId: request.documentId,
      storeEpoch: this.storeEpoch,
      generation: this.generation,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.serverDocument),
      update: Y.encodeStateAsUpdate(this.serverDocument, request.stateVector),
    });
  };

  applyUpdate = async (
    request: DocumentSyncApplyRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>> => {
    this.applyCalls.push(request);
    this.activeApplyCalls += 1;
    this.maxActiveApplyCalls = Math.max(this.maxActiveApplyCalls, this.activeApplyCalls);
    try {
      if (this.applyHandler) {
        return await this.applyHandler(request);
      }
      return this.commit(request);
    } finally {
      this.activeApplyCalls -= 1;
    }
  };

  subscribe = (
    _request: DocumentSyncSubscribeRequest,
    listener: (event: DocumentSyncRealtimeEvent) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publishAwareness = async (
    request: DocumentAwarenessPublishRequest,
  ): Promise<DocumentSyncCommandResult<{ readonly accepted: true }>> => {
    this.awarenessCalls.push(request);
    this.emit({
      kind: "awareness",
      documentId: request.documentId,
      storeEpoch: request.storeEpoch,
      generation: request.generation,
      clientSessionId: request.clientSessionId,
      update: request.update,
    });
    return success({ accepted: true });
  };

  commit = (request: DocumentSyncApplyRequest): DocumentSyncCommandResult<DocumentSyncApplyAck> => {
    const existingAck = this.committedAcks.get(request.updateId);
    if (existingAck) {
      return success({
        ...existingAck,
        headSeq: this.headSeq,
        stateVector: Y.encodeStateVector(this.serverDocument),
        duplicate: true,
      });
    }

    Y.applyUpdate(this.serverDocument, request.update);
    this.headSeq += 1;
    if (this.emitApplyEcho) {
      this.emit({
        kind: "document-update",
        documentId: request.documentId,
        storeEpoch: this.storeEpoch,
        generation: this.generation,
        headSeq: this.headSeq,
        updateId: request.updateId,
        clientSessionId: request.clientSessionId,
        update: request.update,
      });
    }
    const ack: DocumentSyncApplyAck = {
      documentId: request.documentId,
      storeEpoch: this.storeEpoch,
      generation: this.generation,
      updateId: request.updateId,
      committedSeq: this.headSeq,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.serverDocument),
      duplicate: false,
      status: "committed",
      commit: {
        store_epoch: this.storeEpoch,
        commit_seq: this.headSeq,
        manifest_hash: "f".repeat(64),
      },
    };
    this.committedAcks.set(request.updateId, ack);
    return success(ack);
  };

  commitExternal = (mutate: (text: Y.Text) => void): Uint8Array => {
    const update = captureUpdate(this.serverDocument, () => {
      mutate(this.serverDocument.getText("title"));
    });
    this.headSeq += 1;
    return update;
  };

  emit = (event: DocumentSyncRealtimeEvent): void => {
    this.listeners.forEach((listener) => listener(event));
  };

  destroy = (): void => {
    this.serverDocument.destroy();
  };
}

describe("NodexYProvider", () => {
  test("keeps merged durability batches inside the transport byte limit", () => {
    const source = new Y.Doc({ guid: "source" });
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update.slice()));
    const text = source.getText("body");
    text.insert(0, "a".repeat(100));
    text.insert(text.length, "b".repeat(100));
    text.insert(text.length, "c".repeat(100));
    const maxUpdateBytes = Math.max(...updates.map((update) => update.byteLength));
    const replica = new Y.Doc({ guid: "replica" });
    try {
      let remaining = updates;
      let batches = 0;
      while (remaining.length > 0) {
        const batch = mergeNextBoundedYjsUpdate(remaining, maxUpdateBytes);
        expect(batch.update.byteLength).toBeLessThanOrEqual(maxUpdateBytes);
        expect(batch.consumedUpdates).toBeGreaterThan(0);
        Y.applyUpdate(replica, batch.update);
        remaining = remaining.slice(batch.consumedUpdates);
        batches += 1;
      }

      expect(batches).toBeGreaterThan(1);
      expect(replica.getText("body").toString()).toBe(text.toString());
    } finally {
      source.destroy();
      replica.destroy();
    }
  });

  test("accepts a redundant CRDT replay at the unchanged durable head", () => {
    expect(
      isDocumentApplyAckHeadValid(
        {
          status: "no_op",
          committedSeq: 4,
          headSeq: 4,
          duplicate: true,
        },
        { baseHeadSeq: 4 },
      ),
    ).toBe(true);
    expect(
      isDocumentApplyAckHeadValid(
        {
          status: "committed",
          committedSeq: 4,
          headSeq: 4,
          duplicate: false,
        },
        { baseHeadSeq: 4 },
      ),
    ).toBe(false);
  });

  test("converges concurrent clients while keeping a fresh client identity per surface", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const firstDocument = new Y.Doc({ guid: "document-1" });
    const secondDocument = new Y.Doc({ guid: "document-1" });
    const first = new NodexYProvider({
      documentId: "document-1",
      document: firstDocument,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    const second = new NodexYProvider({
      documentId: "document-1",
      document: secondDocument,
      adapter,
      clientSessionId: "window-2",
      autoConnect: false,
    });
    try {
      await Promise.all([first.connect(), second.connect()]);
      expect(firstDocument.clientID !== secondDocument.clientID).toBe(true);
      expect(first.clientSessionId !== second.clientSessionId).toBe(true);

      firstDocument.getText("title").insert(0, "A");
      secondDocument.getText("title").insert(0, "B");
      await Promise.all([first.flush(), second.flush()]);
      await waitUntil(() => first.getStatus().headSeq === 2 && second.getStatus().headSeq === 2);

      const serverText = adapter.serverDocument.getText("title").toString();
      expect(firstDocument.getText("title").toString()).toBe(serverText);
      expect(secondDocument.getText("title").toString()).toBe(serverText);
      expect(serverText.length).toBe(2);
    } finally {
      first.destroy();
      second.destroy();
      firstDocument.destroy();
      secondDocument.destroy();
      adapter.destroy();
    }
  });

  test("keeps a Card's title, nested Block tree, formatting, and stable identities convergent across two surfaces and restart", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const initialIds = ["block-root", "block-child", "block-sibling"];
    let nextInitialId = 0;
    const genesis = createPageDocumentGenesis({
      documentId: "document-1",
      title: "Shared Card",
      nfm: "Root\n\tChild\nSibling",
      allocateBlockId: () => {
        const blockId = initialIds[nextInitialId];
        if (!blockId) throw new Error("Unexpected genesis Block allocation");
        nextInitialId += 1;
        return blockId;
      },
    });
    const insertedGenesis = createPageDocumentGenesis({
      documentId: "insert-template",
      title: "",
      nfm: "Inserted **live**",
      allocateBlockId: () => "block-inserted",
    });
    const insertedPortable = captureXmlSubtreeAt(getRootBlockGroup(insertedGenesis.document), 0);
    Y.applyUpdate(adapter.serverDocument, genesis.update);
    adapter.headSeq = 1;

    const firstDocument = new Y.Doc({ guid: "document-1" });
    const secondDocument = new Y.Doc({ guid: "document-1" });
    const firstClientId = firstDocument.clientID;
    const secondClientId = secondDocument.clientID;
    const first = new NodexYProvider({
      documentId: "document-1",
      document: firstDocument,
      adapter,
      clientSessionId: "window-alpha",
      autoConnect: false,
    });
    const second = new NodexYProvider({
      documentId: "document-1",
      document: secondDocument,
      adapter,
      clientSessionId: "window-beta",
      autoConnect: false,
    });

    let restartedFirstDocument: Y.Doc | null = null;
    let restartedSecondDocument: Y.Doc | null = null;
    let restartedFirst: NodexYProvider | null = null;
    let restartedSecond: NodexYProvider | null = null;
    try {
      await Promise.all([first.connect(), second.connect()]);
      expect(firstDocument.clientID !== secondDocument.clientID).toBe(true);

      firstDocument.transact(() => {
        const title = openPageDocument(firstDocument).title;
        title.insert(title.length, " / Alpha");
        const rootText = getFirstBlockText(findBlockElement(firstDocument, "block-root"));
        rootText.insert(rootText.length, " edited by Alpha");
        rootText.format(0, "Root".length, { italic: {} });
      }, "window-alpha-edit");
      secondDocument.transact(() => {
        const title = openPageDocument(secondDocument).title;
        title.insert(title.length, " / Beta");
        const rootGroup = getRootBlockGroup(secondDocument);
        insertPortableXmlSubtree(rootGroup, rootGroup.length, insertedPortable);
      }, "window-beta-edit");

      await Promise.all([first.flush(), second.flush()]);
      await waitUntil(() => first.getStatus().headSeq === 3 && second.getStatus().headSeq === 3);
      const concurrentMaterialization = materializePageDocument(firstDocument);
      expect(concurrentMaterialization.title.includes(" / Alpha")).toBe(true);
      expect(concurrentMaterialization.title.includes(" / Beta")).toBe(true);
      expect(concurrentMaterialization.plainText.includes("Root edited by Alpha")).toBe(true);
      expect(concurrentMaterialization.nfm.includes("*Root* edited by Alpha")).toBe(true);
      expect(JSON.stringify(materializePageDocument(secondDocument))).toBe(
        JSON.stringify(concurrentMaterialization),
      );

      firstDocument.transact(() => {
        const sourceBlock = findBlockElement(firstDocument, "block-root");
        const sourceGroup = getChildBlockGroup(sourceBlock);
        if (!sourceGroup) throw new Error("Missing nested source blockGroup");
        const movedPortable = captureXmlSubtreeAt(sourceGroup, 0);
        deleteXmlSubtreeAt(sourceGroup, 0);
        const sourceGroupIndex = sourceBlock.toArray().indexOf(sourceGroup);
        if (sourceGroupIndex < 0) {
          throw new Error("Missing source blockGroup attachment");
        }
        sourceBlock.delete(sourceGroupIndex, 1);

        const targetBlock = findBlockElement(firstDocument, "block-inserted");
        const targetGroup = new Y.XmlElement(BLOCK_GROUP_NODE_NAME);
        targetBlock.insert(targetBlock.length, [targetGroup]);
        insertPortableXmlSubtree(targetGroup, 0, movedPortable);
      }, "window-alpha-nested-move");
      secondDocument.transact(() => {
        deleteDirectBlock(getRootBlockGroup(secondDocument), "block-sibling");
      }, "window-beta-delete");

      await Promise.all([first.flush(), second.flush()]);
      await waitUntil(() => first.getStatus().headSeq === 5 && second.getStatus().headSeq === 5);
      const beforeRestart = materializePageDocument(adapter.serverDocument);
      expect(JSON.stringify(materializePageDocument(firstDocument))).toBe(
        JSON.stringify(beforeRestart),
      );
      expect(JSON.stringify(materializePageDocument(secondDocument))).toBe(
        JSON.stringify(beforeRestart),
      );

      first.destroy();
      second.destroy();
      firstDocument.destroy();
      secondDocument.destroy();

      restartedFirstDocument = new Y.Doc({ guid: "document-1" });
      restartedSecondDocument = new Y.Doc({ guid: "document-1" });
      restartedFirst = new NodexYProvider({
        documentId: "document-1",
        document: restartedFirstDocument,
        adapter,
        clientSessionId: "window-alpha-restarted",
        autoConnect: false,
      });
      restartedSecond = new NodexYProvider({
        documentId: "document-1",
        document: restartedSecondDocument,
        adapter,
        clientSessionId: "window-beta-restarted",
        autoConnect: false,
      });
      await Promise.all([restartedFirst.connect(), restartedSecond.connect()]);
      expect(restartedFirstDocument.clientID !== firstClientId).toBe(true);
      expect(restartedSecondDocument.clientID !== secondClientId).toBe(true);
      expect(restartedFirstDocument.clientID !== restartedSecondDocument.clientID).toBe(true);

      const restartedMaterialization = materializePageDocument(restartedFirstDocument);
      expect(JSON.stringify(restartedMaterialization)).toBe(JSON.stringify(beforeRestart));
      expect(JSON.stringify(materializePageDocument(restartedSecondDocument))).toBe(
        JSON.stringify(beforeRestart),
      );
      expect(restartedMaterialization.blockTree.length).toBe(2);
      expect(restartedMaterialization.blockTree[0]?.id).toBe("block-root");
      expect(restartedMaterialization.blockTree[0]?.children.length).toBe(0);
      expect(restartedMaterialization.blockTree[1]?.id).toBe("block-inserted");
      expect(restartedMaterialization.blockTree[1]?.children[0]?.id).toBe("block-child");
      const survivingIds = restartedMaterialization.blockTree.flatMap((block) => [
        block.id,
        ...block.children.map((child) => child.id),
      ]);
      expect(survivingIds.join(",")).toBe("block-root,block-inserted,block-child");
      expect(new Set(survivingIds).size).toBe(survivingIds.length);
    } finally {
      restartedFirst?.destroy();
      restartedSecond?.destroy();
      restartedFirstDocument?.destroy();
      restartedSecondDocument?.destroy();
      first.destroy();
      second.destroy();
      firstDocument.destroy();
      secondDocument.destroy();
      genesis.document.destroy();
      insertedGenesis.document.destroy();
      adapter.destroy();
    }
  });

  test("pins local history before sending the Document update that may delete its identities", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const barrier = deferred<void>();
    let preparing = false;
    const unregister = registerDocumentHistoryRetention(document, async () => {
      preparing = true;
      await barrier.promise;
    });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      autoConnect: false,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "retained edit");
      const flushed = provider.flush();
      await waitUntil(() => preparing);
      expect(adapter.applyCalls).toHaveLength(0);
      barrier.resolve();
      await flushed;
      expect(adapter.applyCalls).toHaveLength(1);
      expect(adapter.serverDocument.getText("title").toString()).toBe("retained edit");
    } finally {
      barrier.resolve();
      unregister();
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("merges a local burst into one durable update and suppresses its realtime echo", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await provider.connect();
      const title = document.getText("title");
      title.insert(0, "a");
      title.insert(1, "b");
      title.insert(2, "c");
      await provider.flush();
      await Promise.resolve();

      const committedRequest = adapter.applyCalls[0];
      if (!committedRequest) {
        throw new Error("Missing committed request");
      }
      adapter.emit({
        kind: "document-update",
        documentId: "document-1",
        storeEpoch: adapter.storeEpoch,
        generation: adapter.generation,
        headSeq: 1,
        updateId: committedRequest.updateId,
        clientSessionId: committedRequest.clientSessionId,
        update: committedRequest.update,
      });
      await Promise.resolve();

      expect(adapter.applyCalls.length).toBe(1);
      expect(adapter.serverDocument.getText("title").toString()).toBe("abc");
      expect(provider.getStatus().phase).toBe("synced");
      expect(provider.getStatus().headSeq).toBe(1);
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("allows exactly one durable command in flight and sends later edits sequentially", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const replies = [
      deferred<DocumentSyncCommandResult<DocumentSyncApplyAck>>(),
      deferred<DocumentSyncCommandResult<DocumentSyncApplyAck>>(),
    ];
    adapter.applyHandler = (request) => {
      const callIndex = adapter.applyCalls.indexOf(request);
      const reply = replies[callIndex];
      if (!reply) {
        throw new Error("Unexpected durable apply call");
      }
      return reply.promise;
    };
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "a");
      await waitUntil(() => adapter.applyCalls.length === 1);
      document.getText("title").insert(1, "b");
      const flushed = provider.flush();
      await Promise.resolve();
      expect(adapter.applyCalls.length).toBe(1);

      const firstRequest = adapter.applyCalls[0];
      if (!firstRequest) {
        throw new Error("Missing first apply request");
      }
      replies[0]?.resolve(adapter.commit(firstRequest));
      await waitUntil(() => adapter.applyCalls.length === 2);

      const secondRequest = adapter.applyCalls[1];
      if (!secondRequest) {
        throw new Error("Missing second apply request");
      }
      replies[1]?.resolve(adapter.commit(secondRequest));
      await flushed;

      expect(adapter.maxActiveApplyCalls).toBe(1);
      expect(adapter.serverDocument.getText("title").toString()).toBe("ab");
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("keeps a later edit in its burst window when an earlier ACK wins", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const replies = [
      deferred<DocumentSyncCommandResult<DocumentSyncApplyAck>>(),
      deferred<DocumentSyncCommandResult<DocumentSyncApplyAck>>(),
    ];
    adapter.applyHandler = (request) => {
      const callIndex = adapter.applyCalls.indexOf(request);
      const reply = replies[callIndex];
      if (!reply) throw new Error("Unexpected durable apply call");
      return reply.promise;
    };
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "a");
      await vi.advanceTimersByTimeAsync(120);
      expect(adapter.applyCalls).toHaveLength(1);

      document.getText("title").insert(1, "b");
      await vi.advanceTimersByTimeAsync(50);
      const firstRequest = adapter.applyCalls[0];
      if (!firstRequest) throw new Error("Missing first apply request");
      replies[0]?.resolve(adapter.commit(firstRequest));
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);

      expect(adapter.applyCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(69);
      expect(adapter.applyCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.applyCalls).toHaveLength(2);

      const secondRequest = adapter.applyCalls[1];
      if (!secondRequest) throw new Error("Missing second apply request");
      replies[1]?.resolve(adapter.commit(secondRequest));
      await vi.runAllTicks();
      expect(adapter.serverDocument.getText("title").toString()).toBe("ab");
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  test("bounds durable commits and recovery-cache writes during an editor burst", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "");
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      await provider.checkpoint();
      checkpoints.writeCalls.length = 0;

      const title = document.getText("title");
      for (let index = 0; index < 200; index += 1) {
        title.insert(title.length, "x");
        await vi.advanceTimersByTimeAsync(5);
      }
      await provider.flush();
      await provider.checkpoint();

      expect(adapter.applyCalls.length).toBeGreaterThan(1);
      expect(adapter.applyCalls.length).toBeLessThanOrEqual(8);
      expect(adapter.maxActiveApplyCalls).toBe(1);
      expect(checkpoints.writeCalls).toHaveLength(1);
      expect(adapter.serverDocument.getText("title").length).toBe(200);
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  test("stores only local Yjs deltas in disposable crash recovery", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "Base");
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      provider.disconnect();
      openPageDocument(document).title.insert(4, " offline");
      await provider.checkpoint();

      const checkpoint = checkpoints.writeCalls.at(-1);
      if (!checkpoint) throw new Error("Missing local recovery checkpoint");
      expect(checkpoint.state.byteLength).toBeLessThan(Y.encodeStateAsUpdate(document).byteLength);

      const recovered = new Y.Doc({ guid: "document-1" });
      try {
        Y.applyUpdate(recovered, Y.encodeStateAsUpdate(adapter.serverDocument));
        Y.applyUpdate(recovered, checkpoint.state);
        expect(openPageDocument(recovered).title.toString()).toBe("Base offline");
      } finally {
        recovered.destroy();
      }
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("retries the exact same durable request after reconnect state-vector sync", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const retryCallbacks: Array<() => void> = [];
    const scheduleRetry: NodexYProviderRetryScheduler = (callback) => {
      retryCallbacks.push(callback);
      return () => undefined;
    };
    let applyAttempt = 0;
    adapter.applyHandler = async (request) => {
      applyAttempt += 1;
      if (applyAttempt === 1) {
        adapter.commit(request);
        return {
          ok: false,
          error: {
            code: "transport_unavailable",
            message: "offline",
            retryable: true,
            resetRequired: false,
          },
        };
      }
      return adapter.commit(request);
    };
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
      scheduleRetry,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "retry me");
      await waitUntil(() => retryCallbacks.length === 1);
      expect(provider.getStatus().phase).toBe("offline");

      retryCallbacks[0]?.();
      await waitUntil(() => adapter.applyCalls.length === 2);
      await provider.flush();

      const firstRequest = adapter.applyCalls[0];
      const secondRequest = adapter.applyCalls[1];
      expect(firstRequest === secondRequest).toBe(true);
      expect(firstRequest?.updateId).toBe(secondRequest?.updateId);
      expect(firstRequest?.update === secondRequest?.update).toBe(true);
      expect(adapter.syncCalls.length).toBe(2);
      expect(adapter.headSeq).toBe(1);
      expect(adapter.serverDocument.getText("title").toString()).toBe("retry me");
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("repairs a realtime sequence gap with a state-vector resync", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await provider.connect();
      adapter.commitExternal((title) => title.insert(0, "a"));
      const secondUpdate = adapter.commitExternal((title) => title.insert(1, "b"));
      adapter.emit({
        kind: "document-update",
        documentId: "document-1",
        storeEpoch: adapter.storeEpoch,
        generation: adapter.generation,
        headSeq: 2,
        updateId: "remote-2",
        clientSessionId: "window-2",
        update: secondUpdate,
      });

      await waitUntil(() => adapter.syncCalls.length === 2 && provider.getStatus().headSeq === 2);
      expect(document.getText("title").toString()).toBe("ab");
      expect(provider.getStatus().phase).toBe("synced");
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("shares ephemeral Awareness without turning remote presence into document writes", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const firstDocument = new Y.Doc({ guid: "document-1" });
    const secondDocument = new Y.Doc({ guid: "document-1" });
    const first = new NodexYProvider({
      documentId: "document-1",
      document: firstDocument,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    const second = new NodexYProvider({
      documentId: "document-1",
      document: secondDocument,
      adapter,
      clientSessionId: "window-2",
      autoConnect: false,
    });
    try {
      await Promise.all([first.connect(), second.connect()]);
      first.awareness.setLocalStateField("user", { name: "Ada" });
      await waitUntil(() => second.awareness.getStates().has(firstDocument.clientID));

      const remoteState = second.awareness.getStates().get(firstDocument.clientID) as
        | { user?: { name?: string } }
        | undefined;
      expect(remoteState?.user?.name).toBe("Ada");
      expect(adapter.applyCalls.length).toBe(0);
      first.destroy();
      await waitUntil(() => !second.awareness.getStates().has(firstDocument.clientID));
      expect(second.awareness.getStates().has(firstDocument.clientID)).toBe(false);
    } finally {
      first.destroy();
      second.destroy();
      firstDocument.destroy();
      secondDocument.destroy();
      adapter.destroy();
    }
  });

  test("requires a fresh Y.Doc when store epoch or document generation changes", async () => {
    const epochAdapter = new MemoryDocumentSyncAdapter();
    epochAdapter.storeEpoch = "store-restored";
    const epochDocument = new Y.Doc({ guid: "document-1" });
    const epochProvider = new NodexYProvider({
      documentId: "document-1",
      document: epochDocument,
      adapter: epochAdapter,
      clientSessionId: "stale-window",
      expectedStoreEpoch: "store-before-restore",
      autoConnect: false,
    });
    try {
      await epochProvider.connect();
      expect(epochProvider.getStatus().phase).toBe("reset-required");
      expect(epochProvider.getStatus().error?.code).toBe("store_epoch_mismatch");
      epochDocument.getText("title").insert(0, "must not replay");
      await Promise.resolve();
      expect(epochProvider.getStatus().pendingUpdateCount).toBe(0);
      expect(epochAdapter.applyCalls.length).toBe(0);
    } finally {
      epochProvider.destroy();
      epochDocument.destroy();
      epochAdapter.destroy();
    }

    const generationAdapter = new MemoryDocumentSyncAdapter();
    const generationDocument = new Y.Doc({ guid: "document-1" });
    const generationProvider = new NodexYProvider({
      documentId: "document-1",
      document: generationDocument,
      adapter: generationAdapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await generationProvider.connect();
      generationAdapter.emit({
        kind: "resync-required",
        documentId: "document-1",
        storeEpoch: generationAdapter.storeEpoch,
        generation: 2,
        headSeq: 0,
        reason: "transport-reconnected",
      });
      expect(generationProvider.getStatus().phase).toBe("reset-required");
      expect(generationProvider.getStatus().error?.code).toBe("document_generation_mismatch");
    } finally {
      generationProvider.destroy();
      generationDocument.destroy();
      generationAdapter.destroy();
    }
  });

  test.each([
    ["resource-integrity-failure", "recovery_required"],
    ["identity-boundary-changed", "recovery_required"],
    ["access-revoked", "unauthorized"],
  ] as const)("resets the DocumentSession on %s", async (reason, code) => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: `window:${reason}`,
      autoConnect: false,
    });
    try {
      await provider.connect();
      adapter.emit({
        kind: "resync-required",
        documentId: "document-1",
        storeEpoch: adapter.storeEpoch,
        generation: adapter.generation,
        headSeq: adapter.headSeq,
        reason,
      });

      expect(provider.getStatus()).toMatchObject({
        phase: "reset-required",
        error: { code, resetRequired: true, retryable: false },
      });
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("requires a fresh replica when a realtime editor observer rejects an applied update", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-observer-failure",
      autoConnect: false,
    });
    const title = document.getText("title");
    const rejectProjection = () => {
      throw new Error("editor projection failed");
    };
    try {
      await provider.connect();
      title.observe(rejectProjection);
      const update = adapter.commitExternal((serverTitle) => {
        serverTitle.insert(0, "Committed remotely");
      });

      adapter.emit({
        kind: "document-update",
        documentId: "document-1",
        storeEpoch: adapter.storeEpoch,
        generation: adapter.generation,
        headSeq: adapter.headSeq,
        updateId: "rust:observer-failure",
        clientSessionId: "rust:test",
        update,
      });

      expect(provider.getStatus()).toMatchObject({
        phase: "reset-required",
        headSeq: 0,
        error: {
          code: "recovery_required",
          resetRequired: true,
          retryable: false,
        },
      });
      expect(provider.getStatus().error?.message).toContain(
        "local editor could not integrate the realtime document update",
      );
      expect(title.toString()).toBe("Committed remotely");
    } finally {
      title.unobserve(rejectProjection);
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("quarantines old-epoch edits without replaying them after an explicit store reset", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-before-restore",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "must not cross restore");
      adapter.emit({
        kind: "store-reset",
        documentId: "document-1",
        storeEpoch: "store-restored",
      });

      await waitUntil(() => checkpoints.recoveries.length === 1);
      expect(provider.getStatus().phase).toBe("reset-required");
      expect(provider.getStatus().pendingUpdateCount).toBe(1);
      expect(provider.getStatus().error?.code).toBe("store_epoch_mismatch");
      expect(adapter.applyCalls.length).toBe(0);
      expect(checkpoints.recoveries[0]?.storeEpoch).toBe("store-1");
      const recovered = new Y.Doc();
      Y.applyUpdate(recovered, checkpoints.recoveries[0]!.state);
      expect(recovered.getText("title").toString()).toBe("must not cross restore");
      recovered.destroy();
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("stops retrying and requires reload when a durable update crosses relocation", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const retryCallbacks: Array<() => void> = [];
    adapter.applyHandler = async () => ({
      ok: false,
      error: {
        code: "block_relocated",
        message: "Block moved",
        retryable: true,
        resetRequired: false,
        relocationId: "relocation-1",
        recoveryArtifactId: "artifact-1",
      },
    });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "stale-window",
      autoConnect: false,
      scheduleRetry: (callback) => {
        retryCallbacks.push(callback);
        return () => undefined;
      },
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "offline edit");
      await waitUntil(() => provider.getStatus().phase === "reset-required");
      const status = provider.getStatus();
      expect(status.error?.code).toBe("block_relocated");
      expect(status.error?.relocationId).toBe("relocation-1");
      expect(status.error?.recoveryArtifactId).toBe("artifact-1");
      expect(status.error?.retryable).toBe(false);
      expect(status.error?.resetRequired).toBe(true);
      expect(retryCallbacks.length).toBe(0);
      expect(adapter.applyCalls.length).toBe(1);
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("recovers disconnected edits from the exact IndexedDB-style boundary after restart", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "Base");
    const firstDocument = new Y.Doc({ guid: "document-1" });
    const first = new NodexYProvider({
      documentId: "document-1",
      document: firstDocument,
      adapter,
      clientSessionId: "window-before-restart",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await first.connect();
      first.disconnect();
      openPageDocument(firstDocument).title.insert(4, " offline");
      await first.checkpoint();
    } finally {
      first.destroy();
      firstDocument.destroy();
    }

    const restartedDocument = new Y.Doc({ guid: "document-1" });
    const restarted = new NodexYProvider({
      documentId: "document-1",
      document: restartedDocument,
      adapter,
      clientSessionId: "window-after-restart",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await restarted.connect();
      await waitUntil(
        () => openPageDocument(restartedDocument).title.toString() === "Base offline",
      );
      expect(openPageDocument(restartedDocument).title.toString()).toBe("Base offline");
      await restarted.flush();
      expect(openPageDocument(adapter.serverDocument).title.toString()).toBe("Base offline");
      expect(adapter.headSeq).toBe(2);
    } finally {
      restarted.destroy();
      restartedDocument.destroy();
      adapter.destroy();
    }
  });

  test("recovers a body-only Document from its registered schema after restart", async () => {
    await recoverDisconnectedRegisteredDocumentEdit({
      schema: {
        ownerType: REUSABLE_TEMPLATE_SOURCE_TYPE,
        schemaKey: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
        schemaVersion: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
      },
      mutate: (document, adapter) => {
        if (adapter.contentModel !== "block_tree") {
          throw new TypeError("Expected the Template block-tree Adapter");
        }
        const root = adapter.inspect(document).envelope.body.toArray()[0];
        if (!(root instanceof Y.XmlElement)) {
          throw new TypeError("Expected the Template body root");
        }
        root.insert(0, [createParagraphBlock("offline-block", "Recovered offline body")]);
      },
      assertRecovered: (document, adapter) => {
        if (adapter.contentModel !== "block_tree") {
          throw new TypeError("Expected the Template block-tree Adapter");
        }
        expect(adapter.inspect(document).materialization.plainText).toBe("Recovered offline body");
      },
    });
  });

  test("does not let a stalled checkpoint block a durable update or fence", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "Base");
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      await provider.checkpoint();
      const gate = deferred<void>();
      checkpoints.writeGate = gate.promise;
      openPageDocument(document).title.insert(4, " pending");
      const checkpointing = provider.checkpoint();
      const flushing = provider.flush();
      await flushing;
      expect(adapter.applyCalls.length).toBe(1);
      expect(openPageDocument(adapter.serverDocument).title.toString()).toBe("Base pending");
      expect(provider.getStatus().checkpoint.phase).toBe("saving");

      gate.resolve(undefined);
      await checkpointing;
      await waitUntil(() => provider.getStatus().checkpoint.phase === "ready");
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("reports checkpoint failure without failing Core durability", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "Base");
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      await provider.checkpoint();
      checkpoints.writeError = new Error("checkpoint quota exhausted");

      openPageDocument(document).title.insert(4, " durable");
      await provider.flush();
      await expect(provider.checkpoint()).rejects.toThrow("checkpoint quota exhausted");

      expect(openPageDocument(adapter.serverDocument).title.toString()).toBe("Base durable");
      expect(provider.getStatus().phase).toBe("synced");
      expect(provider.getStatus().checkpoint).toMatchObject({
        phase: "degraded",
        lastFailureMessage: "checkpoint quota exhausted",
      });
      expect(provider.getStatus().checkpoint.failureCount).toBeGreaterThan(0);
    } finally {
      checkpoints.writeError = null;
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });

  test("does not spin when the disposable recovery cache keeps failing", async () => {
    vi.useFakeTimers();
    const adapter = new MemoryDocumentSyncAdapter();
    const checkpoints = new MemoryDocumentLocalCheckpointStore();
    seedCanonicalPageDocument(adapter, "Base");
    const document = new Y.Doc({ guid: "document-1" });
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      localCheckpointStore: checkpoints,
      autoConnect: false,
    });
    try {
      await provider.connect();
      checkpoints.writeError = new Error("checkpoint quota exhausted");

      openPageDocument(document).title.insert(4, " one");
      await vi.advanceTimersByTimeAsync(500);
      expect(checkpoints.writeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(checkpoints.writeCalls).toHaveLength(1);

      openPageDocument(document).title.insert(8, " two");
      await vi.advanceTimersByTimeAsync(500);
      expect(checkpoints.writeCalls).toHaveLength(2);
    } finally {
      checkpoints.writeError = null;
      provider.destroy();
      document.destroy();
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  test("rejects a pending flush on destroy without destroying the surface-owned Y.Doc", async () => {
    const adapter = new MemoryDocumentSyncAdapter();
    const document = new Y.Doc({ guid: "document-1" });
    const reply = deferred<DocumentSyncCommandResult<DocumentSyncApplyAck>>();
    adapter.applyHandler = () => reply.promise;
    const provider = new NodexYProvider({
      documentId: "document-1",
      document,
      adapter,
      clientSessionId: "window-1",
      autoConnect: false,
    });
    try {
      await provider.connect();
      document.getText("title").insert(0, "pending");
      await waitUntil(() => adapter.applyCalls.length === 1);

      let flushRejected = false;
      const flushing = provider.flush().catch(() => {
        flushRejected = true;
      });
      provider.destroy();
      await flushing;
      expect(flushRejected).toBe(true);
      expect(provider.getStatus().phase).toBe("destroyed");

      document.getText("title").insert(7, " surface");
      expect(document.getText("title").toString()).toBe("pending surface");
      expect(adapter.applyCalls.length).toBe(1);

      const request = adapter.applyCalls[0];
      if (!request) {
        throw new Error("Missing pending request");
      }
      reply.resolve(adapter.commit(request));
      await waitUntil(() => adapter.activeApplyCalls === 0);
    } finally {
      provider.destroy();
      document.destroy();
      adapter.destroy();
    }
  });
});

test("an older checkpoint completion cannot claim protection for a newer local edit", async () => {
  const adapter = new MemoryDocumentSyncAdapter();
  seedCanonicalPageDocument(adapter, "Base");
  const checkpoints = new MemoryDocumentLocalCheckpointStore();
  const document = new Y.Doc({ guid: "document-1" });
  const provider = new NodexYProvider({
    documentId: "document-1",
    document,
    adapter,
    autoConnect: false,
    localCheckpointStore: checkpoints,
  });
  const gate = deferred<void>();
  try {
    await provider.connect();
    await provider.checkpoint();
    checkpoints.writeGate = gate.promise;
    openPageDocument(document).title.insert(4, " first");
    const oldWrite = provider.checkpoint();
    openPageDocument(document).title.insert(10, " second");
    gate.resolve(undefined);
    await oldWrite;
    expect(provider.getStatus().checkpoint).toMatchObject({
      phase: "ready",
      localVersion: 2,
      protectedVersion: 1,
    });
    await provider.checkpoint();
    expect(provider.getStatus().checkpoint).toMatchObject({ localVersion: 2, protectedVersion: 2 });
  } finally {
    gate.resolve(undefined);
    provider.destroy();
    document.destroy();
    adapter.destroy();
  }
});

test("an unresolved previous-session save becomes an exportable draft without replaying or blocking canonical editing", async () => {
  const adapter = new MemoryDocumentSyncAdapter();
  seedCanonicalPageDocument(adapter, "canonical");
  const checkpoints = new MemoryDocumentLocalCheckpointStore();
  const draft = new Y.Doc();
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(adapter.serverDocument));
  const update = captureUpdate(draft, () => draft.getText("title").insert(0, "unconfirmed "));
  await checkpoints.write({
    documentId: "document-1",
    storeEpoch: adapter.storeEpoch,
    generation: adapter.generation,
    headSeq: adapter.headSeq,
    state: Y.encodeStateAsUpdate(draft),
    updatedAt: new Date().toISOString(),
    submissions: [
      {
        documentId: "document-1",
        storeEpoch: adapter.storeEpoch,
        generation: adapter.generation,
        baseHeadSeq: adapter.headSeq,
        clientSessionId: "old-window",
        updateId: "old-update",
        update,
        touchedBlockIds: [],
      },
    ],
  });
  const document = new Y.Doc({ guid: "document-1" });
  const provider = new NodexYProvider({
    documentId: "document-1",
    document,
    adapter,
    localCheckpointStore: checkpoints,
    clientSessionId: "new-window",
    autoConnect: false,
  });
  try {
    await provider.connect();
    await waitUntil(() => provider.getStatus().recoveredDraftCount === 1);
    expect(document.getText("title").toString()).toBe("canonical");
    expect(adapter.applyCalls).toHaveLength(0);
    const exported = JSON.parse(await provider.exportRecovery());
    expect(exported.snapshots[0].submissions[0]).toMatchObject({
      clientSessionId: "old-window",
      updateId: "old-update",
    });
    document.getText("title").insert(0, "next ");
    await provider.flush();
    expect(adapter.serverDocument.getText("title").toString()).toBe("next canonical");
  } finally {
    provider.destroy();
    document.destroy();
    draft.destroy();
    adapter.destroy();
  }
});

test("connect waits for a canonical resync requested by the first physical connection event", async () => {
  const adapter = new MemoryDocumentSyncAdapter();
  seedCanonicalPageDocument(adapter, "canonical");
  adapter.syncHandler = async (request) => {
    await Promise.resolve();
    adapter.syncHandler = null;
    adapter.emit({
      kind: "connection",
      documentId: "document-1",
      clientSessionId: "test-session",
      state: "connected",
    });
    return success({
      documentId: request.documentId,
      storeEpoch: adapter.storeEpoch,
      generation: adapter.generation,
      headSeq: adapter.headSeq,
      stateVector: Y.encodeStateVector(adapter.serverDocument),
      update: Y.encodeStateAsUpdate(adapter.serverDocument, request.stateVector),
    });
  };
  const document = new Y.Doc({ guid: "document-1" });
  const provider = new NodexYProvider({
    documentId: "document-1",
    document,
    adapter,
    localCheckpointStore: null,
    autoConnect: false,
  });
  try {
    await provider.connect();
    expect(provider.getStatus().phase).toBe("synced");
    expect(document.getText("title").toString()).toBe("canonical");
  } finally {
    provider.destroy();
    document.destroy();
    adapter.destroy();
  }
});
