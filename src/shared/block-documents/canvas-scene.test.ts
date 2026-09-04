import { describe, expect, test } from "vite-plus/test";
import {
  CanvasSceneContractError,
  canonicalPortableCanvasSceneSemanticFingerprint,
  canonicalizeCanvasSceneElement,
  canvasSceneElementHash,
  chooseCanvasSceneElementWinner,
  compilePortableCanvasSceneForwardRestore,
  materializePortableCanvasScene,
  parsePortableCanvasScene,
  type CanvasSceneElement,
} from "./canvas-scene";

const element = (
  id: string,
  version: number,
  versionNonce: number,
  extra: Readonly<Record<string, unknown>> = {},
): CanvasSceneElement =>
  canonicalizeCanvasSceneElement({
    id,
    type: "rectangle",
    isDeleted: false,
    version,
    versionNonce,
    index: `a${id}`,
    ...extra,
  });

describe("portable Canvas scene kernel", () => {
  test("normalizes Excalidraw runtime undefined fields only at observation boundaries", () => {
    const runtime = {
      id: "shape",
      type: "rectangle",
      isDeleted: false,
      version: 1,
      versionNonce: 2,
      index: "a0",
      customData: undefined,
      label: { text: "hello", optional: undefined },
    };

    expect(canonicalizeCanvasSceneElement(runtime, { runtime: true })).toEqual({
      id: "shape",
      type: "rectangle",
      isDeleted: false,
      version: 1,
      versionNonce: 2,
      index: "a0",
      label: { text: "hello" },
    });
    expect(() => canonicalizeCanvasSceneElement(runtime)).toThrow("bounded portable JSON");
  });

  test("rejects cyclic and non-plain runtime values", () => {
    const cyclic: Record<string, unknown> = {
      id: "cyclic",
      type: "rectangle",
      isDeleted: false,
      version: 1,
      versionNonce: 1,
    };
    cyclic.customData = cyclic;
    expect(() => canonicalizeCanvasSceneElement(cyclic, { runtime: true })).toThrow(
      "must not be cyclic",
    );

    class CustomData {}
    expect(() =>
      canonicalizeCanvasSceneElement(
        {
          id: "classed",
          type: "rectangle",
          isDeleted: false,
          version: 1,
          versionNonce: 1,
          customData: new CustomData(),
        },
        { runtime: true },
      ),
    ).toThrow("plain JSON objects");
  });

  test("winner selection is commutative, associative, and idempotent", () => {
    const candidates = [
      element("same", 3, 99, { x: 1 }),
      element("same", 4, 77, { x: 2 }),
      element("same", 4, 12, { x: 3 }),
      element("same", 4, 12, { x: 4 }),
    ];
    const choose = chooseCanvasSceneElementWinner;
    for (const left of candidates) {
      expect(choose(left, left)).toEqual(left);
      for (const right of candidates) {
        expect(choose(left, right)).toEqual(choose(right, left));
        for (const third of candidates) {
          expect(choose(choose(left, right), third)).toEqual(choose(left, choose(right, third)));
        }
      }
    }
    const winner = candidates.reduce(choose);
    expect(winner.version).toBe(4);
    expect(winner.versionNonce).toBe(12);
    expect(winner).toEqual(
      [candidates[2]!, candidates[3]!].sort((left, right) =>
        canvasSceneElementHash(left).localeCompare(canvasSceneElementHash(right)),
      )[0],
    );
  });

  test("rejects contenders from different element identities", () => {
    expect(() =>
      chooseCanvasSceneElementWinner(element("left", 1, 1), element("right", 2, 1)),
    ).toThrow("same id");
  });

  test("materializes canonical references, text, files, and durable app state", () => {
    const scene = materializePortableCanvasScene({
      elements: [
        {
          id: "page",
          type: "rectangle",
          isDeleted: false,
          version: 1,
          versionNonce: 1,
          index: "a0",
          label: { text: "Card label" },
          customData: {
            type: "nodex-card",
            cardId: "target-card",
            titleHint: "Hint",
          },
        },
        {
          id: "image",
          type: "image",
          fileId: "file-1",
          isDeleted: false,
          version: 1,
          versionNonce: 2,
          index: "a1",
        },
      ],
      appState: {
        gridModeEnabled: true,
        gridSize: 20,
        scrollX: 500,
      },
      files: {
        "file-1": {
          id: "file-1",
          mimeType: "image/png",
          source: "nodex://files/image.png",
          fileVersion: 1,
          defaultName: "image.png",
        },
      },
    });

    expect(scene.appState).toEqual({ gridModeEnabled: true, gridSize: 20 });
    expect(scene.pageReferences).toEqual([
      {
        sourceElementId: "page",
        targetBlockId: "target-card",
        titleHint: "Hint",
      },
    ]);
    expect(scene.elements[0]?.customData).toEqual({
      type: "nodex-card-reference",
      targetBlockId: "target-card",
      titleHint: "Hint",
    });
    expect(scene.plainText).toBe("Card label");
    expect(parsePortableCanvasScene(scene)).toEqual(scene);
  });

  test("fails closed for missing managed image files and tampered projections", () => {
    expect(() =>
      materializePortableCanvasScene({
        elements: [
          {
            id: "image",
            type: "image",
            fileId: "missing",
            isDeleted: false,
            version: 1,
            versionNonce: 1,
          },
        ],
      }),
    ).toThrow("missing managed file");

    const scene = materializePortableCanvasScene({
      elements: [element("text", 1, 1, { type: "text", text: "truth" })],
    });
    expect(() => parsePortableCanvasScene({ ...scene, preview: "tampered" })).toThrow(
      "does not match its derived projection",
    );
  });

  test("compiles deterministic forward restore candidates and tombstones", () => {
    const current = materializePortableCanvasScene({
      elements: [element("kept", 8, 4, { x: 100 }), element("removed", 6, 5)],
    });
    const target = materializePortableCanvasScene({
      elements: [element("kept", 3, 9, { x: 5 })],
      appState: { viewBackgroundColor: "#fff" },
    });
    const first = compilePortableCanvasSceneForwardRestore({
      current,
      target,
      restoreIdentity: "restore-1",
    });
    const second = compilePortableCanvasSceneForwardRestore({
      current,
      target,
      restoreIdentity: "restore-1",
    });
    expect(first).toEqual(second);
    expect(first.elementCandidates).toEqual([
      expect.objectContaining({ id: "kept", version: 9, x: 5 }),
      expect.objectContaining({ id: "removed", version: 7, isDeleted: true }),
    ]);

    const restored = materializePortableCanvasScene({
      elements: first.elementCandidates,
      appState: first.appState,
      files: first.files,
    });
    expect(canonicalPortableCanvasSceneSemanticFingerprint(restored)).toBe(
      canonicalPortableCanvasSceneSemanticFingerprint(target),
    );
    expect(first.targetSemanticFingerprint).toBe(
      canonicalPortableCanvasSceneSemanticFingerprint(target),
    );
  });

  test("refuses restore version overflow", () => {
    const current = materializePortableCanvasScene({
      elements: [element("max", Number.MAX_SAFE_INTEGER, 1)],
    });
    expect(() =>
      compilePortableCanvasSceneForwardRestore({
        current,
        target: current,
        restoreIdentity: "overflow",
      }),
    ).toThrow(CanvasSceneContractError);
  });
  test("keeps two slot versions of one File as independent exact targets", () => {
    const scene = materializePortableCanvasScene({
      elements: [
        element("old", 1, 1, { type: "image", fileId: "old-slot" }),
        element("new", 1, 2, { type: "image", fileId: "new-slot" }),
      ],
      files: {
        "old-slot": {
          id: "old-slot",
          source: "nodex://files/shared",
          fileVersion: 1,
          defaultName: "Old.png",
          mimeType: "image/png",
        },
        "new-slot": {
          id: "new-slot",
          source: "nodex://files/shared",
          fileVersion: 4,
          defaultName: "New.png",
          mimeType: "image/png",
        },
      },
    });
    expect(scene.schemaVersion).toBe(2);
    expect(scene.files["old-slot"]?.fileVersion).toBe(1);
    expect(scene.files["new-slot"]?.fileVersion).toBe(4);
    expect(scene.files["old-slot"]?.source).toBe(scene.files["new-slot"]?.source);
  });
});
