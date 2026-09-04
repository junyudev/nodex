import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { materializePageDocument } from "./block-document-codec";
import { assertValidBlockDocument } from "./block-structure";

interface BridgeSummary {
  readonly title: string;
  readonly body_semantic: unknown;
  readonly state_vector: readonly number[];
}

interface AwarenessBridgeSummary {
  readonly client_id: number;
  readonly state: unknown;
}

interface FixtureManifest {
  readonly matrix: {
    readonly blockTypes: readonly string[];
  };
}

type RandomizedEdit =
  | {
      readonly kind: "insert";
      readonly target: "title" | "body";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly kind: "delete";
      readonly target: "title" | "body";
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly kind: "format";
      readonly target: "title" | "body";
      readonly index: number;
      readonly length: number;
      readonly mark: "bold" | "italic" | "underline" | "strike" | "code";
      readonly enabled: boolean;
    };

interface RandomizedCase {
  readonly seed: number;
  readonly operations: readonly RandomizedEdit[];
}

interface RandomizedProductSummary {
  readonly body_semantic: unknown;
  readonly materialization: unknown;
}

interface RandomizedCaseSummary {
  readonly seed: number;
  readonly rust_local: RandomizedProductSummary;
  readonly yjs_update: RandomizedProductSummary;
}

interface SemanticOperationSummary {
  readonly materialization: unknown;
  readonly stateVectorV1: readonly number[];
  readonly writeFenceBlockIds: readonly string[];
  readonly titleWriteFenceRequired: boolean;
}

const fixtureRoot = path.resolve("crates/nodex-core/tests/fixtures/yjs-yrs");
const bridgeExecutable = requiredNativeExecutable("yjs-yrs-bridge");
const temporaryRoots: string[] = [];

const firstXmlText = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText => {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) {
      try {
        return firstXmlText(child);
      } catch {
        // Continue with the next branch.
      }
    }
  }
  throw new Error("fixture does not contain Y.XmlText");
};

const runBridge = <T = BridgeSummary>(args: readonly string[]): T =>
  JSON.parse(
    execFileSync(bridgeExecutable, [...args], { cwd: path.resolve("."), encoding: "utf8" }),
  ) as T;

const normalizedStateVector = (bytes: Uint8Array): readonly (readonly [number, number])[] =>
  [...Y.decodeStateVector(bytes).entries()].sort(([left], [right]) => left - right);

const exactElementNames = (body: Y.XmlFragment): readonly string[] =>
  [...body.createTreeWalker((node) => node instanceof Y.XmlElement)].map(
    (node) => (node as Y.XmlElement).nodeName,
  );

const semanticValue = (value: unknown): unknown => {
  if (value === undefined) return { $yrs: "undefined" };
  if (typeof value === "bigint") {
    return { $yrs: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { $yrs: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) return value.map(semanticValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, semanticValue(entry)]),
  );
};

const semanticXmlNode = (node: unknown): unknown => {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as readonly {
      readonly insert: unknown;
      readonly attributes?: Readonly<Record<string, unknown>>;
    }[];
    return {
      kind: "text",
      delta: delta.map((chunk) => ({
        insert: semanticValue(chunk.insert),
        attributes: semanticValue(chunk.attributes ?? {}),
      })),
    };
  }
  if (!(node instanceof Y.XmlElement)) {
    throw new TypeError(`Unsupported fixture XML node: ${typeof node}`);
  }
  return {
    kind: "element",
    name: node.nodeName,
    attributes: semanticValue(node.getAttributes()),
    children: node.toArray().map((child) => semanticXmlNode(child)),
  };
};

const semanticXml = (body: Y.XmlFragment): unknown =>
  body.toArray().map((node) => semanticXmlNode(node));

const materializeWithSearchUnits = (document: Y.Doc): unknown => ({
  ...materializePageDocument(document),
  searchUnits: assertValidBlockDocument(document.getXmlFragment("body")).map((block, ordinal) => ({
    blockId: block.id,
    parentBlockId: block.parentBlockId,
    ordinal,
    blockType: block.blockType,
    text: block.text,
  })),
});

const utf16Boundaries = (value: string): readonly number[] => {
  const boundaries = [0];
  let offset = 0;
  for (const character of value) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries;
};

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
};

const applyRandomizedEdit = (document: Y.Doc, operation: RandomizedEdit): void => {
  const target =
    operation.target === "title"
      ? document.getText("title")
      : firstXmlText(document.getXmlFragment("body"));
  if (operation.kind === "insert") {
    target.insert(operation.index, operation.text);
    return;
  }
  if (operation.kind === "delete") {
    target.delete(operation.index, operation.length);
    return;
  }
  target.format(operation.index, operation.length, {
    [operation.mark]: operation.enabled ? true : null,
  });
};

const generateRandomizedCase = (
  seed: number,
  base: Uint8Array,
): { readonly fixture: RandomizedCase; readonly document: Y.Doc } => {
  const random = createRandom(seed);
  const document = new Y.Doc({ guid: `randomized-yjs-${seed}` });
  Y.applyUpdate(document, base);
  const operations: RandomizedEdit[] = [];
  const insertedText = ["a", " 😀", "中", "e\u0301", "\n", " * "] as const;
  const marks = ["bold", "italic", "underline", "strike", "code"] as const;

  for (let step = 0; step < 36; step += 1) {
    const target = random() % 2 === 0 ? "title" : "body";
    const shared =
      target === "title"
        ? document.getText("title")
        : firstXmlText(document.getXmlFragment("body"));
    const boundaries = utf16Boundaries(shared.toString());
    const requestedKind = step % 3;
    let operation: RandomizedEdit;
    if (requestedKind === 0 || boundaries.length === 1) {
      operation = {
        kind: "insert",
        target,
        index: boundaries[random() % boundaries.length] ?? 0,
        text: insertedText[random() % insertedText.length] ?? "a",
      };
    } else {
      const startBoundary = random() % (boundaries.length - 1);
      const remaining = boundaries.length - 1 - startBoundary;
      const span = 1 + (random() % Math.min(3, remaining));
      const index = boundaries[startBoundary] ?? 0;
      const end = boundaries[startBoundary + span] ?? index;
      operation =
        requestedKind === 1
          ? { kind: "delete", target, index, length: end - index }
          : {
              kind: "format",
              target,
              index,
              length: end - index,
              mark: marks[random() % marks.length] ?? "bold",
              enabled: random() % 2 === 0,
            };
    }
    document.transact(() => applyRandomizedEdit(document, operation));
    operations.push(operation);
  }
  return { fixture: { seed, operations }, document };
};

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) rmSync(root, { recursive: true });
  }
});

describe("Yjs/Yrs compatibility", () => {
  test("materializes the same schema matrix after a Rust BlockTree round trip", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-block-tree-"));
    temporaryRoots.push(temporaryRoot);
    const roundtripUpdatePath = path.join(temporaryRoot, "matrix-roundtrip.bin");
    runBridge(["matrix-block-tree-roundtrip", fixtureRoot, roundtripUpdatePath]);

    const source = new Y.Doc({ guid: "matrix-source" });
    Y.applyUpdate(source, readFileSync(path.join(fixtureRoot, "matrix-base.bin")));
    const roundtrip = new Y.Doc({ guid: "matrix-roundtrip" });
    Y.applyUpdate(roundtrip, readFileSync(roundtripUpdatePath));

    expect(materializePageDocument(roundtrip)).toEqual(materializePageDocument(source));
    expect(semanticXml(roundtrip.getXmlFragment("body"))).toEqual(
      semanticXml(source.getXmlFragment("body")),
    );
  }, 30_000);

  test("continues editing a rich Page in both engines after a bidirectional round trip", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-yjs-yrs-"));
    temporaryRoots.push(temporaryRoot);
    const rustUpdatePath = path.join(temporaryRoot, "rust-update.bin");
    const thirdUpdatePath = path.join(temporaryRoot, "third-update.bin");

    const rustAfterConcurrent = runBridge(["generate", fixtureRoot, rustUpdatePath]);

    const yjsDocument = new Y.Doc({ guid: "nodex-yjs-yrs-conformance" });
    for (const name of ["base.bin", "first.bin", "second.bin"]) {
      Y.applyUpdate(yjsDocument, readFileSync(path.join(fixtureRoot, name)));
    }
    Y.applyUpdate(yjsDocument, readFileSync(rustUpdatePath));
    expect(yjsDocument.getText("title").toString()).toBe(rustAfterConcurrent.title);
    expect(semanticXml(yjsDocument.getXmlFragment("body"))).toEqual(
      rustAfterConcurrent.body_semantic,
    );

    const beforeThird = Y.encodeStateVector(yjsDocument);
    yjsDocument.transact(() => {
      const title = yjsDocument.getText("title");
      title.insert(title.length, " · JS3");
      const text = firstXmlText(yjsDocument.getXmlFragment("body"));
      text.insert(text.length, " third");
    }, "third-js-edit");
    writeFileSync(thirdUpdatePath, Y.encodeStateAsUpdate(yjsDocument, beforeThird));

    const rustAfterThird = runBridge(["inspect", fixtureRoot, rustUpdatePath, thirdUpdatePath]);
    expect(rustAfterThird.title).toBe(yjsDocument.getText("title").toString());
    expect(rustAfterThird.body_semantic).toEqual(semanticXml(yjsDocument.getXmlFragment("body")));
    expect(rustAfterThird.state_vector.length).toBeGreaterThan(1);
    expect(normalizedStateVector(Uint8Array.from(rustAfterThird.state_vector))).toEqual(
      normalizedStateVector(Y.encodeStateVector(yjsDocument)),
    );
  }, 60_000);

  test("consumes Rust semantic title and stable Block operations as one relative update", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-semantic-operations-"));
    temporaryRoots.push(temporaryRoot);
    const corpusPath = path.join(temporaryRoot, "operations.json");
    const updatePath = path.join(temporaryRoot, "operations.bin");
    writeFileSync(
      corpusPath,
      JSON.stringify({
        operations: [
          {
            kind: "set_rich_title",
            richTitle: [
              { type: "text", text: "Rust ", styles: { bold: true } },
              {
                type: "link",
                text: "authority",
                href: "https://nodex.local/core",
                styles: {},
              },
            ],
          },
          {
            kind: "insert_block",
            block: {
              id: "rust-semantic-insert",
              type: "paragraph",
              props: {
                backgroundColor: "default",
                textColor: "default",
                textAlignment: "left",
              },
              content: [{ type: "text", text: "Inserted by Rust", styles: {} }],
              children: [],
            },
            beforeBlockId: "matrix-heading",
          },
          {
            kind: "update_block",
            blockId: "matrix-heading",
            patch: {
              content: [
                {
                  type: "text",
                  text: "Updated heading",
                  styles: { bold: true },
                },
              ],
            },
          },
          {
            kind: "move_block",
            blockId: "matrix-quote",
            parentBlockId: "matrix-toggle",
          },
          { kind: "delete_block", blockId: "matrix-divider" },
        ],
      }),
    );

    const summary = runBridge<SemanticOperationSummary>([
      "semantic-operations",
      fixtureRoot,
      corpusPath,
      updatePath,
    ]);
    const consumer = new Y.Doc({ guid: "nodex-yjs-yrs-schema-matrix" });
    Y.applyUpdate(consumer, readFileSync(path.join(fixtureRoot, "matrix-base.bin")));
    Y.applyUpdate(consumer, readFileSync(updatePath));

    expect(materializeWithSearchUnits(consumer)).toEqual(summary.materialization);
    expect(summary.writeFenceBlockIds).toEqual([
      "matrix-divider",
      "matrix-heading",
      "matrix-quote",
    ]);
    expect(summary.titleWriteFenceRequired).toBe(true);
    expect(normalizedStateVector(Uint8Array.from(summary.stateVectorV1))).toEqual(
      normalizedStateVector(Y.encodeStateVector(consumer)),
    );
  }, 60_000);

  test("consumes a Rust exact-NFM body replacement and rich title atomically", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-nfm-patch-"));
    temporaryRoots.push(temporaryRoot);
    const corpusPath = path.join(temporaryRoot, "nfm-patch.json");
    const updatePath = path.join(temporaryRoot, "nfm-patch.bin");
    writeFileSync(
      corpusPath,
      JSON.stringify({
        patches: [
          {
            oldNfm: "## Heading",
            newNfm: "## Heading from an exact Rust patch",
            expectedMatches: 1,
          },
        ],
        richTitle: [
          {
            type: "text",
            text: "Patched by Rust",
            styles: { bold: true },
          },
        ],
      }),
    );

    const summary = runBridge<SemanticOperationSummary>([
      "nfm-patch",
      fixtureRoot,
      corpusPath,
      updatePath,
    ]);
    const consumer = new Y.Doc({ guid: "nodex-yjs-yrs-schema-matrix" });
    Y.applyUpdate(consumer, readFileSync(path.join(fixtureRoot, "matrix-base.bin")));
    Y.applyUpdate(consumer, readFileSync(updatePath));

    expect(materializeWithSearchUnits(consumer)).toEqual(summary.materialization);
    expect(summary.writeFenceBlockIds).toHaveLength(20);
    expect(summary.titleWriteFenceRequired).toBe(true);
    expect(normalizedStateVector(Uint8Array.from(summary.stateVectorV1))).toEqual(
      normalizedStateVector(Y.encodeStateVector(consumer)),
    );
  }, 60_000);

  test("consumes a Rust portable subtree copy with remapped nested identities", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-subtree-copy-"));
    temporaryRoots.push(temporaryRoot);
    const updatePath = path.join(temporaryRoot, "subtree-copy.bin");
    const summary = runBridge<SemanticOperationSummary>(["subtree-copy", fixtureRoot, updatePath]);
    const consumer = new Y.Doc({ guid: "nodex-yjs-yrs-schema-matrix" });
    Y.applyUpdate(consumer, readFileSync(path.join(fixtureRoot, "matrix-base.bin")));
    Y.applyUpdate(consumer, readFileSync(updatePath));

    expect(materializeWithSearchUnits(consumer)).toEqual(summary.materialization);
    expect(summary.writeFenceBlockIds).toEqual([
      "bridge-copy-matrix-toggle",
      "bridge-copy-matrix-toggle-child",
    ]);
    expect(summary.titleWriteFenceRequired).toBe(false);
    expect(normalizedStateVector(Uint8Array.from(summary.stateVectorV1))).toEqual(
      normalizedStateVector(Y.encodeStateVector(consumer)),
    );
  }, 60_000);

  test("round-trips every registered Block and inline shape with exact XML tags", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-yjs-yrs-matrix-"));
    temporaryRoots.push(temporaryRoot);
    const rustUpdatePath = path.join(temporaryRoot, "matrix-rust-update.bin");
    const thirdUpdatePath = path.join(temporaryRoot, "matrix-third-update.bin");
    const manifest = JSON.parse(
      readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"),
    ) as FixtureManifest;

    const rustAfterMatrix = runBridge(["matrix-generate", fixtureRoot, rustUpdatePath]);
    const yjsDocument = new Y.Doc({ guid: "nodex-yjs-yrs-schema-matrix" });
    Y.applyUpdate(yjsDocument, readFileSync(path.join(fixtureRoot, "matrix-base.bin")));
    Y.applyUpdate(yjsDocument, readFileSync(rustUpdatePath));
    expect(yjsDocument.getText("title").toString()).toBe(rustAfterMatrix.title);
    expect(semanticXml(yjsDocument.getXmlFragment("body"))).toEqual(rustAfterMatrix.body_semantic);

    const nodeNames = exactElementNames(yjsDocument.getXmlFragment("body"));
    expect(nodeNames).toContain("blockGroup");
    expect(nodeNames).toContain("blockContainer");
    for (const blockType of manifest.matrix.blockTypes) {
      expect(nodeNames, blockType).toContain(blockType);
    }

    const beforeThird = Y.encodeStateVector(yjsDocument);
    yjsDocument.transact(() => {
      const title = yjsDocument.getText("title");
      title.insert(title.length, " · matrix JS3");
      const text = firstXmlText(yjsDocument.getXmlFragment("body"));
      text.insert(text.length, " · matrix third");
    }, "matrix-third-js-edit");
    writeFileSync(thirdUpdatePath, Y.encodeStateAsUpdate(yjsDocument, beforeThird));

    const rustAfterThird = runBridge([
      "matrix-inspect",
      fixtureRoot,
      rustUpdatePath,
      thirdUpdatePath,
    ]);
    expect(rustAfterThird.title).toBe(yjsDocument.getText("title").toString());
    expect(rustAfterThird.body_semantic).toEqual(semanticXml(yjsDocument.getXmlFragment("body")));
    expect(normalizedStateVector(Uint8Array.from(rustAfterThird.state_vector))).toEqual(
      normalizedStateVector(Y.encodeStateVector(yjsDocument)),
    );
  }, 60_000);

  test("exchanges ephemeral Awareness state in both directions", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-yjs-yrs-awareness-"));
    temporaryRoots.push(temporaryRoot);
    const rustUpdatePath = path.join(temporaryRoot, "awareness-rust.bin");
    const rust = runBridge<AwarenessBridgeSummary>([
      "awareness",
      path.join(fixtureRoot, "awareness-added.bin"),
      rustUpdatePath,
    ]);

    expect(rust.client_id).toBeGreaterThan(0);
    expect(rust.client_id).toBeLessThanOrEqual(0xffff_ffff);
    const remoteDocument = new Y.Doc({ guid: "awareness-yjs-consumer" });
    const remoteAwareness = new Awareness(remoteDocument);
    remoteAwareness.setLocalState(null);
    applyAwarenessUpdate(remoteAwareness, readFileSync(rustUpdatePath), "rust-fixture");
    expect(remoteAwareness.getStates().get(rust.client_id)).toEqual(rust.state);
    expect(remoteAwareness.getStates().size).toBe(2);
    remoteAwareness.destroy();
  }, 60_000);

  test("preserves randomized UTF-16 insert delete and format properties bidirectionally", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-yjs-yrs-properties-"));
    temporaryRoots.push(temporaryRoot);
    const yjsUpdateRoot = path.join(temporaryRoot, "yjs");
    const rustUpdateRoot = path.join(temporaryRoot, "rust");
    mkdirSync(yjsUpdateRoot);
    mkdirSync(rustUpdateRoot);
    const corpusPath = path.join(temporaryRoot, "corpus.json");
    const base = readFileSync(path.join(fixtureRoot, "base.bin"));
    const cases: RandomizedCase[] = [];
    const expected = new Map<number, RandomizedProductSummary>();

    for (let seed = 1; seed <= 24; seed += 1) {
      const generated = generateRandomizedCase(seed, base);
      cases.push(generated.fixture);
      const baseVectorDocument = new Y.Doc({ guid: `randomized-vector-${seed}` });
      Y.applyUpdate(baseVectorDocument, base);
      writeFileSync(
        path.join(yjsUpdateRoot, `${seed}.bin`),
        Y.encodeStateAsUpdate(generated.document, Y.encodeStateVector(baseVectorDocument)),
      );
      expected.set(seed, {
        body_semantic: semanticXml(generated.document.getXmlFragment("body")),
        materialization: materializeWithSearchUnits(generated.document),
      });
    }
    writeFileSync(corpusPath, JSON.stringify({ cases }));

    const summaries = runBridge<readonly RandomizedCaseSummary[]>([
      "randomized",
      fixtureRoot,
      corpusPath,
      yjsUpdateRoot,
      rustUpdateRoot,
    ]);
    expect(summaries).toHaveLength(cases.length);
    for (const summary of summaries) {
      const oracle = expected.get(summary.seed);
      expect(oracle, `seed ${summary.seed}`).toBeDefined();
      expect(summary.rust_local, `Rust-local seed ${summary.seed}`).toEqual(oracle);
      expect(summary.yjs_update, `Yjs-to-Yrs seed ${summary.seed}`).toEqual(oracle);

      const consumer = new Y.Doc({ guid: `randomized-consumer-${summary.seed}` });
      Y.applyUpdate(consumer, base);
      Y.applyUpdate(consumer, readFileSync(path.join(rustUpdateRoot, `${summary.seed}.bin`)));
      expect(
        {
          body_semantic: semanticXml(consumer.getXmlFragment("body")),
          materialization: materializeWithSearchUnits(consumer),
        },
        `Yrs-to-Yjs seed ${summary.seed}`,
      ).toEqual(oracle);
    }
  }, 60_000);
});
