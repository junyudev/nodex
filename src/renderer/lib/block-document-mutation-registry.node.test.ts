import { describe, expect, test, vi } from "vite-plus/test";
import {
  registerBlockDocumentStructuralMutationParticipant,
  prepareBlockDocumentStructuralReplay,
  resolveBlockDocumentStructuralMutationParticipant,
  resolveBlockDocumentStructuralMutationParticipantByDocumentId,
} from "./block-document-mutation-registry";

describe("Block Document structural mutation participant registry", () => {
  test("replay waits for every affected live Document and rejects a changed authority", async () => {
    let finish = () => {};
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const releases = ["source", "target"].map((documentId) =>
      registerBlockDocumentStructuralMutationParticipant(documentId, {
        documentId,
        prepareAndFence: async () => {
          order.push(documentId);
          if (documentId === "source") await saved;
          return { documentId, generation: 1, storeEpoch: "epoch", expectedHeadSeq: 3 };
        },
      }),
    );
    try {
      const replay = prepareBlockDocumentStructuralReplay("epoch", [
        { documentId: "source", generation: 1 },
        { documentId: "target", generation: 1 },
        { documentId: "unopened", generation: 1 },
      ]);
      await vi.waitFor(() => expect(order).toEqual(["source"]));
      finish();
      await replay;
      expect(order).toEqual(["source", "target"]);
      await expect(
        prepareBlockDocumentStructuralReplay("old-epoch", [
          { documentId: "source", generation: 1 },
        ]),
      ).rejects.toThrow("authority changed");
      await expect(
        prepareBlockDocumentStructuralReplay("epoch", [{ documentId: "source", generation: 2 }]),
      ).rejects.toThrow("authority changed");
    } finally {
      finish();
      releases.forEach((release) => release());
    }
  });
  test("does not let an older surface disposer remove the current runtime", () => {
    const first = { prepareAndFence: async () => undefined } as never;
    const second = { prepareAndFence: async () => undefined } as never;
    const unregisterFirst = registerBlockDocumentStructuralMutationParticipant("surface-1", first);
    const unregisterSecond = registerBlockDocumentStructuralMutationParticipant(
      "surface-1",
      second,
    );

    expect(resolveBlockDocumentStructuralMutationParticipant("surface-1")).toBe(second);
    unregisterFirst();
    expect(resolveBlockDocumentStructuralMutationParticipant("surface-1")).toBe(second);
    unregisterSecond();
    expect(resolveBlockDocumentStructuralMutationParticipant("surface-1")).toBeNull();
  });

  test("finds the latest mounted participant by durable Document identity", () => {
    const first = { documentId: "document-1", prepareAndFence: async () => undefined } as never;
    const second = { documentId: "document-1", prepareAndFence: async () => undefined } as never;
    const unregisterFirst = registerBlockDocumentStructuralMutationParticipant("surface-1", first);
    const unregisterSecond = registerBlockDocumentStructuralMutationParticipant(
      "surface-2",
      second,
    );

    expect(resolveBlockDocumentStructuralMutationParticipantByDocumentId("document-1")).toBe(
      second,
    );
    unregisterSecond();
    expect(resolveBlockDocumentStructuralMutationParticipantByDocumentId("document-1")).toBe(first);
    unregisterFirst();
    expect(resolveBlockDocumentStructuralMutationParticipantByDocumentId("document-1")).toBeNull();
  });
});
