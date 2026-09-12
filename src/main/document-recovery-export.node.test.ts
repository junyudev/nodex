import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vite-plus/test";
import {
  makeDocumentRecoveryExportSink,
  RECOVERY_EXPORT_CHUNK_BYTES,
} from "./document-recovery-export";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it.effect("save confirms ordered, complete bytes and replaces the destination atomically", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "ndx-export-")));
    const sink = yield* makeDocumentRecoveryExportSink;
    try {
      const destination = path.join(root, "retained.nodex-recovery");
      yield* Effect.promise(() => writeFile(destination, "existing"));
      const bytes = new Uint8Array(RECOVERY_EXPORT_CHUNK_BYTES + 17).fill(237);
      const id = yield* sink.begin(1, "scope", destination, bytes.length, hash(bytes));
      yield* sink.append(1, "scope", id, 0, bytes.subarray(0, RECOVERY_EXPORT_CHUNK_BYTES));
      expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe("existing");
      expect(
        (yield* Effect.exit(
          sink.append(
            2,
            "scope",
            id,
            RECOVERY_EXPORT_CHUNK_BYTES,
            bytes.subarray(RECOVERY_EXPORT_CHUNK_BYTES),
          ),
        ))._tag,
      ).toBe("Failure");
      yield* sink.append(
        1,
        "scope",
        id,
        RECOVERY_EXPORT_CHUNK_BYTES,
        bytes.subarray(RECOVERY_EXPORT_CHUNK_BYTES),
      );
      yield* sink.complete(1, "scope", id);
      expect(new Uint8Array(yield* Effect.promise(() => readFile(destination)))).toEqual(bytes);
      expect(yield* Effect.promise(() => readdir(root))).toEqual(["retained.nodex-recovery"]);
    } finally {
      yield* sink.close();
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);

it.effect(
  "cancel, short output and digest mismatch preserve the existing file and remove temporary output",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "ndx-export-")));
      const sink = yield* makeDocumentRecoveryExportSink;
      const destination = path.join(root, "retained.nodex-recovery");
      try {
        yield* Effect.promise(() => writeFile(destination, "keep"));
        const bytes = new Uint8Array([0, 1, 255]);
        const cancelled = yield* sink.begin(1, "scope", destination, 3, hash(bytes));
        yield* sink.append(1, "scope", cancelled, 0, bytes);
        yield* sink.cancel(1, "scope", cancelled);
        const short = yield* sink.begin(1, "scope", destination, 3, hash(bytes));
        yield* sink.append(1, "scope", short, 0, bytes.subarray(0, 2));
        expect((yield* Effect.exit(sink.complete(1, "scope", short)))._tag).toBe("Failure");
        const wrong = yield* sink.begin(1, "scope", destination, 3, hash(bytes));
        yield* sink.append(1, "scope", wrong, 0, new Uint8Array([1, 2, 3]));
        expect((yield* Effect.exit(sink.complete(1, "scope", wrong)))._tag).toBe("Failure");
        expect(yield* Effect.promise(() => readFile(destination, "utf8"))).toBe("keep");
        expect(yield* Effect.promise(() => readdir(root))).toEqual(["retained.nodex-recovery"]);
      } finally {
        yield* sink.close();
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
);

it.effect("window release fences concurrent opens and removes incomplete output", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "ndx-export-")));
    const sink = yield* makeDocumentRecoveryExportSink;
    try {
      const bytes = new Uint8Array([1]);
      yield* Effect.all(
        [
          Effect.exit(sink.begin(1, "scope", path.join(root, "result"), 1, hash(bytes))),
          sink.closeOwner(1),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
      expect(
        (yield* Effect.exit(sink.begin(1, "scope", path.join(root, "late"), 1, hash(bytes))))._tag,
      ).toBe("Failure");
    } finally {
      yield* sink.close();
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);
