import { describe, expect, test } from "vite-plus/test";
import {
  canonicalizeCanvasSceneMutationIntent,
  canonicalizeCanvasSceneMutationRequest,
  encodeCanonicalCanvasSceneMutationIntent,
  encodeCanonicalCanvasSceneMutationRequest,
} from "./canvas-scene-sync";

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
