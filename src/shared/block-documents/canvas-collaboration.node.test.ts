import { describe, expect, test } from "vite-plus/test";
import {
  canonicalizeCanvasSceneElement,
  chooseCanvasSceneElementWinner,
  type CanvasSceneElement,
} from "./canvas-scene";
import { createUuidV7FromTimestamp } from "../uuid-v7";
import {
  assertExistingCanvasBlockId,
  assertExistingCanvasDocumentId,
  isPrimaryCanvasBlockId,
  isPrimaryCanvasDocumentId,
  primaryCanvasBlockId,
  primaryCanvasDocumentId,
} from "./canvas-document-identity";
import * as Y from "yjs";
import {
  CanvasDocumentSchemaError,
  applyCanvasForwardRestorePlan,
  applyRebasedCanvasSceneObservation,
  applyCanvasSceneSnapshot,
  canonicalCanvasSceneFingerprint,
  canonicalCanvasSceneSemanticFingerprint,
  canvasElementRevisionKey,
  chooseCanvasElementWinner,
  compileCanvasForwardRestorePlan,
  createCanvasDocument,
  inspectCanvasDocument,
  parseCanvasSceneMaterialization,
} from "./canvas-document";
import {
  decodeCanvasSceneMutationRequestHttp,
  decodeCanvasSceneMutationResultHttp,
  decodeCanvasSceneSseEvent,
  decodeCanvasSceneSyncRequestHttp,
  decodeCanvasSceneSyncResultHttp,
  encodeCanvasSceneMutationRequestHttp,
  encodeCanvasSceneSyncRequestHttp,
} from "./canvas-scene-http-contract";
import { committedLocalCommit } from "../testing/local-commit";
import {
  canonicalizeCanvasSceneMutationIntent,
  canonicalizeCanvasSceneMutationRequest,
  encodeCanonicalCanvasSceneMutationIntent,
  encodeCanonicalCanvasSceneMutationRequest,
} from "./canvas-scene-sync";

describe("canvas collaboration protocol model", () => {
  interface PendingMutation {
    readonly mutationId: string;
    readonly candidate: CanvasSceneElement;
  }

  const elementId = (element: CanvasSceneElement): string => String(element.id);

  const elementVersion = (element: CanvasSceneElement | undefined): number =>
    Number(element?.version ?? 0);

  const seededRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const applyCandidate = (
    scene: Map<string, CanvasSceneElement>,
    candidate: CanvasSceneElement,
  ): boolean => {
    const id = elementId(candidate);
    const current = scene.get(id);
    const winner = current ? chooseCanvasSceneElementWinner(current, candidate) : candidate;
    if (winner === current) return false;
    scene.set(id, winner);
    return true;
  };

  const sceneEvidence = (scene: ReadonlyMap<string, CanvasSceneElement>): readonly unknown[] =>
    [...scene.values()]
      .sort((left, right) => elementId(left).localeCompare(elementId(right)))
      .map((element) => element.value);

  describe("seeded Canvas collaboration protocol model", () => {
    test.each([0x5eed_0001, 0x5eed_0002, 0x5eed_0003])(
      "converges after reorder, duplication, loss, retry, and snapshot repair (seed %i)",
      (seed) => {
        const random = seededRandom(seed);
        const server = new Map<string, CanvasSceneElement>();
        const clients = [
          new Map<string, CanvasSceneElement>(),
          new Map<string, CanvasSceneElement>(),
        ];
        const pending: PendingMutation[] = [];
        const receipts = new Map<string, CanvasSceneElement>();
        let mutationSequence = 0;
        let headSeq = 0;

        const deliver = (mutation: PendingMutation): void => {
          const receipt = receipts.get(mutation.mutationId);
          if (receipt) {
            for (const client of clients) {
              if (random() > 0.35) applyCandidate(client, receipt);
            }
            return;
          }
          const changed = applyCandidate(server, mutation.candidate);
          receipts.set(mutation.mutationId, mutation.candidate);
          if (changed) headSeq += 1;
          for (const client of clients) {
            if (random() > 0.35) applyCandidate(client, mutation.candidate);
            if (random() > 0.8) applyCandidate(client, mutation.candidate);
          }
        };

        for (let turn = 0; turn < 240; turn += 1) {
          const clientIndex = random() < 0.5 ? 0 : 1;
          const elementId = `element-${Math.floor(random() * 12)}`;
          const local = clients[clientIndex]!;
          const current = local.get(elementId);
          const version = elementVersion(current) + 1;
          mutationSequence += 1;
          const candidate = canonicalizeCanvasSceneElement({
            id: elementId,
            type: "rectangle",
            index: `a${elementId.padStart(12, "0")}`,
            version,
            versionNonce: Math.floor(random() * 1_000_000) + 1,
            isDeleted: random() < 0.08,
            x: Math.floor(random() * 2_000),
            y: clientIndex * 100 + turn,
          });
          applyCandidate(local, candidate);
          pending.push({
            mutationId: `mutation-${mutationSequence}`,
            candidate,
          });

          if (pending.length > 0 && random() > 0.25) {
            const index = Math.floor(random() * pending.length);
            const [mutation] = pending.splice(index, 1);
            if (mutation) {
              deliver(mutation);
              if (random() > 0.75) deliver(mutation);
            }
          }
          if (turn % 31 === 0) {
            for (const serverElement of server.values()) {
              for (const client of clients) applyCandidate(client, serverElement);
            }
          }
        }

        while (pending.length > 0) {
          const index = Math.floor(random() * pending.length);
          const [mutation] = pending.splice(index, 1);
          if (mutation) deliver(mutation);
        }
        for (const serverElement of server.values()) {
          for (const client of clients) applyCandidate(client, serverElement);
        }

        expect(headSeq).toBeGreaterThan(0);
        expect(receipts.size).toBe(mutationSequence);
        expect(sceneEvidence(clients[0]!)).toEqual(sceneEvidence(server));
        expect(sceneEvidence(clients[1]!)).toEqual(sceneEvidence(server));
      },
    );
  });
});

describe("canvas document identity", () => {
  const uuidV7 = createUuidV7FromTimestamp(1_785_491_085_000);

  describe("Canvas document identity", () => {
    test("accepts user UUID-v7 and deterministic primary identities", () => {
      const primaryBlockId = primaryCanvasBlockId("project:default");
      const primaryDocumentId = primaryCanvasDocumentId("project:default");

      expect(isPrimaryCanvasBlockId(primaryBlockId)).toBe(true);
      expect(isPrimaryCanvasDocumentId(primaryDocumentId)).toBe(true);
      expect(assertExistingCanvasBlockId(uuidV7)).toBe(uuidV7);
      expect(assertExistingCanvasBlockId(primaryBlockId)).toBe(primaryBlockId);
      expect(assertExistingCanvasDocumentId(uuidV7)).toBe(uuidV7);
      expect(assertExistingCanvasDocumentId(primaryDocumentId)).toBe(primaryDocumentId);
    });

    test("rejects malformed primary identities and non-v7 UUIDs", () => {
      const malformed = [
        "canvas:primary:",
        "canvas:primary: project-1",
        "canvas:primary:project-1 ",
        "canvas:primary:project-\n1",
        `canvas:primary:${"p".repeat(512)}`,
        "canvas:secondary:project-1",
      ];
      for (const value of malformed) {
        expect(isPrimaryCanvasBlockId(value)).toBe(false);
        expect(() => assertExistingCanvasBlockId(value)).toThrow("primary Canvas Block ID");
      }

      expect(isPrimaryCanvasDocumentId("document:canvas:primary:")).toBe(false);
      expect(() => assertExistingCanvasDocumentId("document:canvas:primary: project-1")).toThrow(
        "primary Canvas Document ID",
      );
      expect(() => assertExistingCanvasBlockId("550e8400-e29b-41d4-a716-446655440000")).toThrow(
        "UUID-v7",
      );
    });
  });
});

describe("canvas document", () => {
  const element = (
    id: string,
    input: {
      readonly version?: number;
      readonly versionNonce?: number;
      readonly isDeleted?: boolean;
      readonly index?: string;
      readonly text?: string;
      readonly x?: number;
    } = {},
  ) => ({
    id,
    type: "text",
    version: input.version ?? 1,
    versionNonce: input.versionNonce ?? 100,
    isDeleted: input.isDeleted ?? false,
    index: input.index ?? "a0",
    text: input.text ?? id,
    x: input.x ?? 0,
  });

  const materializedElementsJson = (document: Y.Doc): string =>
    JSON.stringify(inspectCanvasDocument(document).materialization.elements);

  const cloneFromUpdate = (documentId: string, update: Uint8Array): Y.Doc => {
    const document = new Y.Doc({ guid: documentId });
    Y.applyUpdate(document, update);
    return document;
  };

  const mergeInOrder = (
    documentId: string,
    genesis: Uint8Array,
    updates: readonly Uint8Array[],
  ): Y.Doc => {
    const document = cloneFromUpdate(documentId, genesis);
    updates.forEach((update) => Y.applyUpdate(document, update));
    return document;
  };

  describe("legacy Canvas Y.Doc migration codec", () => {
    test("owns exact scene roots and canonicalizes legacy Card references", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:roots",
        initialScene: {
          elements: [
            {
              ...element("card-element"),
              customData: {
                type: "nodex-card",
                cardId: "card-1",
                columnId: "triage",
              },
              label: { text: "Card title snapshot" },
            },
          ],
          appState: {
            collaborators: { remote: true },
            selectedElementIds: { "card-element": true },
            gridModeEnabled: true,
            gridSize: 20,
            gridStep: 5,
            viewBackgroundColor: "#ffffff",
          },
          files: {
            "file-1": {
              id: "file-1",
              source: "nodex://assets/file-1.png",
              mimeType: "image/png",
            },
          },
        },
      });
      const inspection = inspectCanvasDocument(envelope.document);
      expect(JSON.stringify([...envelope.document.share.keys()].sort())).toBe(
        '["appState","elements","files","order"]',
      );
      expect(JSON.stringify(inspection.materialization.appState)).toBe(
        JSON.stringify({
          gridModeEnabled: true,
          gridSize: 20,
          gridStep: 5,
          viewBackgroundColor: "#ffffff",
        }),
      );
      expect(JSON.stringify(inspection.materialization.pageReferences)).toBe(
        JSON.stringify([
          {
            sourceElementId: "card-element",
            targetBlockId: "card-1",
            titleHint: "Card title snapshot",
          },
        ]),
      );
      const customData = inspection.materialization.elements[0]?.customData as
        | Readonly<Record<string, unknown>>
        | undefined;
      expect(customData?.type).toBe("nodex-card-reference");
      expect(customData?.targetBlockId).toBe("card-1");
      expect(customData?.cardId === undefined).toBe(true);
    });

    test("treats appState and files as exact roots without inferring element deletion", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:exact-roots",
        initialScene: {
          elements: [element("retained")],
          appState: { gridModeEnabled: true, gridSize: 20 },
          files: {
            old: {
              id: "old",
              source: "nodex://assets/old.png",
              mimeType: "image/png",
            },
          },
        },
      });
      applyCanvasSceneSnapshot(envelope, {
        elements: [],
        appState: { gridStep: null, viewBackgroundColor: "#101010" },
        files: {},
      });
      const materialization = inspectCanvasDocument(envelope.document).materialization;
      expect(materialization.elements.length).toBe(1);
      expect(JSON.stringify(materialization.appState)).toBe(
        JSON.stringify({ gridStep: null, viewBackgroundColor: "#101010" }),
      );
      expect(Object.keys(materialization.files).length).toBe(0);
    });

    test("atomically rebases local intent over current winners, files, and appState", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:rebased-observation",
        initialScene: {
          elements: [
            {
              ...element("local", { version: 1 }),
              type: "image",
              fileId: "local-file",
            },
          ],
          appState: { gridSize: 20, viewBackgroundColor: "#ffffff" },
          files: {
            "local-file": {
              id: "local-file",
              source: "nodex://assets/local.png",
              mimeType: "image/png",
            },
          },
        },
      });
      applyCanvasSceneSnapshot(
        envelope,
        {
          elements: [
            {
              ...element("remote", { version: 1, index: "a1" }),
              type: "image",
              fileId: "remote-file",
            },
          ],
          appState: { gridSize: 40, viewBackgroundColor: "#ffffff" },
          files: {
            "local-file": {
              id: "local-file",
              source: "nodex://assets/local.png",
              mimeType: "image/png",
            },
            "remote-file": {
              id: "remote-file",
              source: "nodex://assets/remote.png",
              mimeType: "image/png",
            },
          },
        },
        "remote-before-upload",
      );
      let transactionCount = 0;
      envelope.document.on("afterTransaction", () => {
        transactionCount += 1;
      });

      applyRebasedCanvasSceneObservation(envelope, {
        elementsIncludingDeleted: [
          {
            ...element("local", { version: 2, x: 25 }),
            type: "image",
            fileId: "local-file",
          },
        ],
        appStatePatch: {
          gridSize: { expected: 20, value: 30 },
          viewBackgroundColor: { expected: "#ffffff", value: "#101010" },
        },
        fileAdditions: {
          "local-file": {
            id: "local-file",
            source: "nodex://assets/local.png",
            mimeType: "image/png",
          },
        },
      });

      const materialization = inspectCanvasDocument(envelope.document).materialization;
      expect(transactionCount).toBe(1);
      expect(materialization.appState.gridSize).toBe(40);
      expect(materialization.appState.viewBackgroundColor).toBe("#101010");
      expect(Object.keys(materialization.files).sort().join(",")).toBe("local-file,remote-file");
      expect(materialization.elements.find((candidate) => candidate.id === "local")?.x).toBe(25);
      expect(materialization.elements.some((candidate) => candidate.id === "remote")).toBe(true);
    });

    test("prunes an uploaded file when the post-merge remote element wins", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:rebased-file-winner",
        initialScene: {
          elements: [
            {
              ...element("image", { version: 2, versionNonce: 10 }),
              type: "image",
              fileId: "remote-file",
            },
          ],
          files: {
            "remote-file": {
              id: "remote-file",
              source: "nodex://assets/remote.png",
              mimeType: "image/png",
            },
          },
        },
      });
      applyRebasedCanvasSceneObservation(envelope, {
        elementsIncludingDeleted: [
          {
            ...element("image", { version: 1, versionNonce: 20 }),
            type: "image",
            fileId: "stale-file",
          },
        ],
        appStatePatch: {},
        fileAdditions: {
          "stale-file": {
            id: "stale-file",
            source: "nodex://assets/stale.png",
            mimeType: "image/png",
          },
        },
      });
      const materialization = inspectCanvasDocument(envelope.document).materialization;
      expect(Object.keys(materialization.files).join(",")).toBe("remote-file");
      expect(materialization.elements[0]?.fileId).toBe("remote-file");
    });

    test("rejects unsupported roots and malformed revision keys", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:invalid",
        initialScene: { elements: [element("one")] },
      });
      envelope.document.getMap("foreign").set("body", "not a scene root");
      let rootError: unknown;
      try {
        inspectCanvasDocument(envelope.document);
      } catch (error) {
        rootError = error;
      }
      expect(rootError instanceof CanvasDocumentSchemaError).toBe(true);

      const malformed = createCanvasDocument({
        documentId: "document:canvas:bad-key",
      });
      malformed.elements.set("element-id", element("element-id"));
      let keyError: unknown;
      try {
        inspectCanvasDocument(malformed.document);
      } catch (error) {
        keyError = error;
      }
      expect(keyError instanceof CanvasDocumentSchemaError).toBe(true);
    });

    test("keeps stored Canvas elements strictly portable", () => {
      let error: unknown;
      try {
        createCanvasDocument({
          documentId: "document:canvas:stored-undefined",
          initialScene: {
            elements: [{ ...element("undefined"), customData: undefined }],
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof CanvasDocumentSchemaError).toBe(true);
    });

    test("rejects inline file payloads before they can enter the Y.Doc", () => {
      let error: unknown;
      try {
        createCanvasDocument({
          documentId: "document:canvas:inline-file",
          initialScene: {
            elements: [],
            files: {
              inline: {
                id: "inline",
                mimeType: "image/png",
                dataURL: "data:image/png;base64,AA==",
              },
            },
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof CanvasDocumentSchemaError).toBe(true);
    });

    test("rejects non-canonical managed asset URIs", () => {
      let error: unknown;
      try {
        createCanvasDocument({
          documentId: "document:canvas:non-canonical-asset",
          initialScene: {
            elements: [],
            files: {
              encoded: {
                id: "encoded",
                mimeType: "image/png",
                source: "nodex://assets/%66ile.png",
              },
            },
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof CanvasDocumentSchemaError).toBe(true);
    });

    test("fails closed when a stored derived projection is tampered", () => {
      const envelope = createCanvasDocument({
        documentId: "document:canvas:stored-corruption",
        initialScene: {
          elements: [element("text", { text: "Derived text" })],
        },
      });
      const materialization = inspectCanvasDocument(envelope.document).materialization;
      let error: unknown;
      try {
        parseCanvasSceneMaterialization({
          documentId: envelope.documentId,
          value: { ...materialization, plainText: "tampered" },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof CanvasDocumentSchemaError).toBe(true);
    });

    test("canonicalizes trusted scene state beyond the public update envelope", () => {
      const largeText = "canvas-state-".repeat(65_000);
      const envelope = createCanvasDocument({
        documentId: "document:canvas:trusted-large-state",
        initialScene: {
          elements: [
            element("large-a", { index: "a0", text: `${largeText}:a` }),
            element("large-b", { index: "a1", text: `${largeText}:b` }),
            element("large-c", { index: "a2", text: `${largeText}:c` }),
          ],
        },
      });
      const materialization = inspectCanvasDocument(envelope.document).materialization;
      expect(Y.encodeStateAsUpdate(envelope.document).byteLength > 2 * 1024 * 1024).toBe(true);
      const parsed = parseCanvasSceneMaterialization({
        documentId: envelope.documentId,
        value: materialization,
      });
      expect(canonicalCanvasSceneFingerprint(parsed)).toBe(
        canonicalCanvasSceneFingerprint(materialization),
      );
    });

    test("keeps same-element contenders visible and converges in opposite update order", () => {
      const base = createCanvasDocument({
        documentId: "document:canvas:concurrent",
        initialScene: { elements: [element("same", { index: "a0" })] },
      });
      const genesis = Y.encodeStateAsUpdate(base.document);
      const baseline = Y.encodeStateVector(base.document);
      const first = cloneFromUpdate("document:canvas:concurrent", genesis);
      const second = cloneFromUpdate("document:canvas:concurrent", genesis);
      applyCanvasSceneSnapshot(
        inspectCanvasDocument(first).envelope,
        {
          elements: [
            element("same", {
              version: 2,
              versionNonce: 900,
              text: "first",
              x: 10,
            }),
          ],
        },
        "first-client",
      );
      applyCanvasSceneSnapshot(
        inspectCanvasDocument(second).envelope,
        {
          elements: [
            element("same", {
              version: 2,
              versionNonce: 100,
              text: "second",
              x: 20,
            }),
          ],
        },
        "second-client",
      );
      const firstUpdate = Y.encodeStateAsUpdate(first, baseline);
      const secondUpdate = Y.encodeStateAsUpdate(second, baseline);
      const left = mergeInOrder("document:canvas:concurrent", genesis, [firstUpdate, secondUpdate]);
      const right = mergeInOrder("document:canvas:concurrent", genesis, [
        secondUpdate,
        firstUpdate,
      ]);
      expect(materializedElementsJson(left)).toBe(materializedElementsJson(right));
      expect(inspectCanvasDocument(left).materialization.elements[0]?.text).toBe("second");
      expect(inspectCanvasDocument(left).envelope.elements.size).toBe(2);
      expect(Array.from(Y.encodeStateVector(left)).join(",")).toBe(
        Array.from(Y.encodeStateVector(right)).join(","),
      );
    });

    test("uses canonical payload as the final equal-version and nonce tie-break", () => {
      const left = element("same", {
        version: 3,
        versionNonce: 55,
        text: "alpha",
      });
      const right = element("same", {
        version: 3,
        versionNonce: 55,
        text: "omega",
      });
      const winner = chooseCanvasElementWinner(left, right);
      const reverseWinner = chooseCanvasElementWinner(right, left);
      expect(JSON.stringify(winner)).toBe(JSON.stringify(reverseWinner));
      expect(canvasElementRevisionKey(left) === canvasElementRevisionKey(right)).toBe(false);
    });

    test("merges disjoint edits without whole-scene replacement", () => {
      const base = createCanvasDocument({
        documentId: "document:canvas:disjoint",
        initialScene: {
          elements: [element("one", { index: "a0" }), element("two", { index: "a1" })],
        },
      });
      const genesis = Y.encodeStateAsUpdate(base.document);
      const baseline = Y.encodeStateVector(base.document);
      const first = cloneFromUpdate("document:canvas:disjoint", genesis);
      const second = cloneFromUpdate("document:canvas:disjoint", genesis);
      applyCanvasSceneSnapshot(inspectCanvasDocument(first).envelope, {
        elements: [element("one", { version: 2, text: "one changed" })],
      });
      applyCanvasSceneSnapshot(inspectCanvasDocument(second).envelope, {
        elements: [element("two", { version: 2, text: "two changed", index: "a1" })],
      });
      const merged = mergeInOrder("document:canvas:disjoint", genesis, [
        Y.encodeStateAsUpdate(first, baseline),
        Y.encodeStateAsUpdate(second, baseline),
      ]);
      expect(
        inspectCanvasDocument(merged)
          .materialization.elements.map((entry) => entry.text)
          .join(","),
      ).toBe("one changed,two changed");
    });

    test("converges delete-versus-edit and preserves the winning tombstone", () => {
      const base = createCanvasDocument({
        documentId: "document:canvas:delete-edit",
        initialScene: { elements: [element("same")] },
      });
      const genesis = Y.encodeStateAsUpdate(base.document);
      const baseline = Y.encodeStateVector(base.document);
      const editing = cloneFromUpdate("document:canvas:delete-edit", genesis);
      const deleting = cloneFromUpdate("document:canvas:delete-edit", genesis);
      applyCanvasSceneSnapshot(inspectCanvasDocument(editing).envelope, {
        elements: [
          element("same", {
            version: 2,
            versionNonce: 500,
            text: "edited",
          }),
        ],
      });
      applyCanvasSceneSnapshot(inspectCanvasDocument(deleting).envelope, {
        elements: [
          element("same", {
            version: 2,
            versionNonce: 10,
            isDeleted: true,
            text: "",
          }),
        ],
      });
      const editUpdate = Y.encodeStateAsUpdate(editing, baseline);
      const deleteUpdate = Y.encodeStateAsUpdate(deleting, baseline);
      const left = mergeInOrder("document:canvas:delete-edit", genesis, [editUpdate, deleteUpdate]);
      const right = mergeInOrder("document:canvas:delete-edit", genesis, [
        deleteUpdate,
        editUpdate,
      ]);
      expect(materializedElementsJson(left)).toBe(materializedElementsJson(right));
      expect(inspectCanvasDocument(left).materialization.elements[0]?.isDeleted).toBe(true);
    });

    test("canonical contender cleanup reaches a no-op without a repair loop", () => {
      const base = createCanvasDocument({
        documentId: "document:canvas:cleanup",
        initialScene: { elements: [element("same")] },
      });
      const genesis = Y.encodeStateAsUpdate(base.document);
      const baseline = Y.encodeStateVector(base.document);
      const first = cloneFromUpdate("document:canvas:cleanup", genesis);
      const second = cloneFromUpdate("document:canvas:cleanup", genesis);
      applyCanvasSceneSnapshot(inspectCanvasDocument(first).envelope, {
        elements: [element("same", { version: 2, versionNonce: 80, text: "first" })],
      });
      applyCanvasSceneSnapshot(inspectCanvasDocument(second).envelope, {
        elements: [element("same", { version: 2, versionNonce: 20, text: "winner" })],
      });
      const merged = mergeInOrder("document:canvas:cleanup", genesis, [
        Y.encodeStateAsUpdate(first, baseline),
        Y.encodeStateAsUpdate(second, baseline),
      ]);
      const winner = inspectCanvasDocument(merged).materialization.elements[0];
      if (!winner) throw new TypeError("Expected a winner");
      const beforeCleanup = Y.encodeStateVector(merged);
      applyCanvasSceneSnapshot(inspectCanvasDocument(merged).envelope, {
        elements: [winner],
      });
      const cleanup = Y.encodeStateAsUpdate(merged, beforeCleanup);
      let noOpUpdateCount = 0;
      const countUpdate = () => {
        noOpUpdateCount += 1;
      };
      merged.on("update", countUpdate);
      applyCanvasSceneSnapshot(inspectCanvasDocument(merged).envelope, {
        elements: [winner],
      });
      merged.off("update", countUpdate);
      expect(cleanup.byteLength > 2).toBe(true);
      expect(noOpUpdateCount).toBe(0);
      expect(inspectCanvasDocument(merged).envelope.elements.size).toBe(1);
    });

    test("restores a checkpoint as a forward update with newer tombstones", () => {
      const targetEnvelope = createCanvasDocument({
        documentId: "document:canvas:forward-restore",
        initialScene: {
          elements: [element("kept", { version: 1, text: "checkpoint" })],
          appState: { gridModeEnabled: true },
          files: {
            target: {
              id: "target",
              source: "nodex://assets/target.png",
              mimeType: "image/png",
            },
          },
        },
      });
      const target = inspectCanvasDocument(targetEnvelope.document).materialization;
      const currentEnvelope = createCanvasDocument({
        documentId: "document:canvas:forward-restore",
        initialScene: {
          elements: [
            element("kept", { version: 5, text: "current" }),
            element("current-only", { version: 7, text: "remove me", index: "a1" }),
          ],
          appState: { gridModeEnabled: false, gridSize: 40 },
          files: {
            current: {
              id: "current",
              source: "nodex://assets/current.png",
              mimeType: "image/png",
            },
          },
        },
      });
      const current = inspectCanvasDocument(currentEnvelope.document).materialization;
      const plan = compileCanvasForwardRestorePlan({
        current,
        target,
        restoreIdentity: "restore:canvas:one",
      });
      const repeatedPlan = compileCanvasForwardRestorePlan({
        current,
        target,
        restoreIdentity: "restore:canvas:one",
      });
      expect(JSON.stringify(plan)).toBe(JSON.stringify(repeatedPlan));

      const beforeUpdate = Y.encodeStateAsUpdate(currentEnvelope.document);
      const beforeVector = Y.encodeStateVector(currentEnvelope.document);
      applyCanvasForwardRestorePlan(currentEnvelope, plan);
      const forwardUpdate = Y.encodeStateAsUpdate(currentEnvelope.document, beforeVector);
      const restored = inspectCanvasDocument(currentEnvelope.document).materialization;
      const kept = restored.elements.find((entry) => entry.id === "kept");
      const removed = restored.elements.find((entry) => entry.id === "current-only");
      expect(kept?.text).toBe("checkpoint");
      expect(kept?.version).toBe(6);
      expect(removed?.isDeleted).toBe(true);
      expect(removed?.version).toBe(8);
      expect(JSON.stringify(restored.appState)).toBe(JSON.stringify({ gridModeEnabled: true }));
      expect(Object.keys(restored.files).join(",")).toBe("target");
      expect(canonicalCanvasSceneSemanticFingerprint(restored)).toBe(
        canonicalCanvasSceneSemanticFingerprint(target),
      );
      expect(forwardUpdate.byteLength > 2).toBe(true);

      const replica = new Y.Doc({ guid: "document:canvas:forward-restore" });
      Y.applyUpdate(replica, beforeUpdate);
      Y.applyUpdate(replica, forwardUpdate);
      expect(materializedElementsJson(replica)).toBe(
        materializedElementsJson(currentEnvelope.document),
      );
    });
  });
});

describe("Canvas scene HTTP contract", () => {
  const emptyScene = {
    kind: "canvas_scene",
    schemaVersion: 2,
    elements: [],
    appState: {},
    files: {},
    pageReferences: [],
    plainText: "",
    preview: "",
  } as const;
  test("round-trips bounded sync and mutation requests with exact route scope", () => {
    const sync = decodeCanvasSceneSyncRequestHttp(
      encodeCanvasSceneSyncRequestHttp({
        syncRequestId: "sync-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        clientSessionId: "client-1",
        knownStoreEpoch: "store-1",
        knownGeneration: 1,
        knownHeadSeq: 2,
        knownSceneHash: "a".repeat(64),
      }),
      { kind: "project", projectId: "project-1" },
      "canvas-1",
    );
    expect(sync.knownHeadSeq).toBe(2);
    const mutation = decodeCanvasSceneMutationRequestHttp(
      encodeCanvasSceneMutationRequestHttp({
        mutationId: "mutation-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        storeEpoch: "store-1",
        generation: 1,
        baseHeadSeq: 2,
        clientSessionId: "client-1",
        elementCandidates: [],
        appStateIntents: {},
        fileAdditions: {},
      }),
      { kind: "project", projectId: "project-1" },
      "canvas-1",
    );
    expect(mutation.mutationId).toBe("mutation-1");
  });

  test("rejects a request whose Project route does not match", () => {
    const serialized = encodeCanvasSceneSyncRequestHttp({
      syncRequestId: "sync-2",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "canvas-1",
      clientSessionId: "client-1",
    });
    expect(() =>
      decodeCanvasSceneSyncRequestHttp(
        serialized,
        { kind: "project", projectId: "project-2" },
        "canvas-1",
      ),
    ).toThrow("does not match its route");
  });

  test("rejects malformed successful sync and mutation envelopes", () => {
    expect(() =>
      decodeCanvasSceneSyncResultHttp(
        JSON.stringify({
          ok: true,
          value: {
            kind: "snapshot",
            syncRequestId: "sync-1",
            libraryId: "library-1",
            routingContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 0,
            scene: emptyScene,
          },
        }),
      ),
    ).toThrow("sceneHash");
    expect(() =>
      decodeCanvasSceneMutationResultHttp(
        JSON.stringify({
          ok: true,
          value: {
            mutationId: "mutation-1",
            libraryId: "library-1",
            routingContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            baseHeadSeq: 0,
            headSeq: 1,
            duplicate: false,
            outcome: "committed",
            sceneHash: "a".repeat(64),
            changedElementIds: [],
            appliedAppStateKeys: [],
            skippedAppStateKeys: [],
            addedFileIds: [],
            removedFileIds: [],
          },
        }),
      ),
    ).toThrow();
  });

  test("rejects malformed realtime coordinates and non-commit mutation events", () => {
    expect(() =>
      decodeCanvasSceneSseEvent(
        JSON.stringify({
          type: "canvas_scene_resync_required",
          libraryId: "library-1",
          routingContext: { kind: "project", projectId: "project-1" },
          documentId: "canvas-1",
          storeEpoch: "store-1",
          generation: 1,
          headSeq: "1",
        }),
      ),
    ).toThrow("headSeq");
    const value = {
      mutationId: "mutation-1",
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "canvas-1",
      storeEpoch: "store-1",
      generation: 1,
      baseHeadSeq: 0,
      headSeq: 1,
      duplicate: false,
      outcome: "committed",
      sceneHash: "a".repeat(64),
      changedElementIds: [],
      appliedAppStateKeys: [],
      skippedAppStateKeys: [],
      addedFileIds: [],
      removedFileIds: [],
      committedAt: "2026-07-13T00:00:00.000Z",
      committedDelta: {
        elementUpdates: [],
        appState: {},
        fileAdditions: {},
        removedFileIds: [],
      },
    };
    expect(() =>
      decodeCanvasSceneMutationResultHttp(
        JSON.stringify({
          ok: true,
          value,
          localCommit: committedLocalCommit("store-1", 1),
          event: {
            type: "canvas_scene_resync_required",
            libraryId: "library-1",
            routingContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 1,
          },
        }),
      ),
    ).toThrow("must be a committed event");
  });
});

describe("canvas scene sync", () => {
  const request = () => ({
    mutationId: "mutation-1",
    routingContext: { kind: "project", projectId: "project-1" },
    documentId: "document-1",
    storeEpoch: "epoch-1",
    generation: 1,
    baseHeadSeq: 4,
    clientSessionId: "client-1",
    elementCandidates: [
      {
        id: "shape",
        type: "rectangle",
        isDeleted: false,
        version: 2,
        versionNonce: 4,
        customData: undefined,
      },
    ],
    appStateIntents: {
      gridSize: {
        expected: { kind: "absent" },
        value: { kind: "value", value: 20 },
      },
    },
    fileAdditions: {},
  });

  describe("Canvas scene sync contract", () => {
    test("canonicalizes runtime candidates and represents absence portably", () => {
      const canonical = canonicalizeCanvasSceneMutationRequest(request());
      expect(canonical.elementCandidates).toEqual([
        {
          id: "shape",
          type: "rectangle",
          isDeleted: false,
          version: 2,
          versionNonce: 4,
        },
      ]);
      expect(canonical.appStateIntents.gridSize).toEqual({
        expected: { kind: "absent" },
        value: { kind: "value", value: 20 },
      });
      expect(JSON.parse(encodeCanonicalCanvasSceneMutationRequest(canonical))).toMatchObject({
        mutationId: "mutation-1",
      });
    });

    test("canonical request encoding is independent of input object key order", () => {
      const first = canonicalizeCanvasSceneMutationRequest(request());
      const raw = request();
      const reversed = Object.fromEntries(Object.entries(raw).reverse());
      const second = canonicalizeCanvasSceneMutationRequest(reversed);
      expect(encodeCanonicalCanvasSceneMutationRequest(first)).toBe(
        encodeCanonicalCanvasSceneMutationRequest(second),
      );
    });

    test("keeps renderer delivery identity out of durable semantic intent", () => {
      const rawIntent = Object.fromEntries(
        Object.entries(request()).filter(([key]) => key !== "clientSessionId"),
      );
      const intent = canonicalizeCanvasSceneMutationIntent(rawIntent);

      expect(encodeCanonicalCanvasSceneMutationIntent(intent)).not.toContain("clientSessionId");
      expect(
        canonicalizeCanvasSceneMutationRequest({
          ...intent,
          clientSessionId: "replacement-window",
        }),
      ).toMatchObject({
        mutationId: intent.mutationId,
        clientSessionId: "replacement-window",
      });
    });

    test("rejects duplicate candidates and non-durable app state", () => {
      const duplicate = request();
      duplicate.elementCandidates.push({
        ...duplicate.elementCandidates[0]!,
        customData: undefined,
        version: 3,
      });
      expect(() => canonicalizeCanvasSceneMutationRequest(duplicate)).toThrow(
        "repeats an element id",
      );

      expect(() =>
        canonicalizeCanvasSceneMutationRequest({
          ...request(),
          appStateIntents: {
            scrollX: {
              expected: { kind: "value", value: 0 },
              value: { kind: "value", value: 1 },
            },
          },
        }),
      ).toThrow("non-durable appState key");
    });

    test("rejects ambiguous undefined instead of losing it on JSON transport", () => {
      expect(() =>
        canonicalizeCanvasSceneMutationRequest({
          ...request(),
          appStateIntents: {
            gridSize: {
              expected: undefined,
              value: { kind: "value", value: 20 },
            },
          },
        }),
      ).toThrow("expected must be an object");
    });

    test("validates app state intent values against field semantics", () => {
      expect(() =>
        canonicalizeCanvasSceneMutationRequest({
          ...request(),
          appStateIntents: {
            gridSize: {
              expected: { kind: "absent" },
              value: { kind: "value", value: 0 },
            },
          },
        }),
      ).toThrow("must be a positive number or null");
    });

    test("rejects extra contract fields", () => {
      expect(() =>
        canonicalizeCanvasSceneMutationRequest({ ...request(), authority: "yjs" }),
      ).toThrow("authority is not supported");
    });
  });
});
