/* oxlint-disable effecttsgo/strict-effect-provide -- Each case acquires the complete isolated query Layer at its managed test entry point. */
import { assert, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { live, WorkspaceFileQueries } from "./WorkspaceFileQueries";

const hostId = "ssh:fixture";
const textPath = "/workspace/report.md";
const pngPath = "/workspace/report.png";
const directoryPath = "/workspace/output";
const deniedPath = "/workspace/denied";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);

function fixture(
  options: {
    readonly disconnected?: boolean;
    readonly missingEpoch?: boolean;
    readonly retire?: "generation" | "epoch";
    readonly invalidBase64?: boolean;
  } = {},
) {
  let generation = 7;
  let epoch = "endpoint-a";
  const requests: { method: string; path: string }[] = [];
  const snapshot = () =>
    createCodexAppServerCapabilitySnapshot({
      hostId,
      generation,
      userAgent: "codex/0.162.0-alpha.17.2",
      ...(options.missingEpoch ? {} : { sourceEpoch: epoch }),
    });
  const gateway = {
    connection: () =>
      Effect.sync(() =>
        options.disconnected
          ? ({ kind: "stopped", hostId } as const)
          : ({
              kind: "ready",
              hostId,
              generation,
              source: { sourceEpoch: epoch, transportKind: "stdio" },
            } as const),
      ),
    requestOnHost: (
      selected: string,
      method: string,
      params: { path: string },
      fence: { expectedHostId: string; expectedGeneration: number },
    ) =>
      Effect.suspend<unknown, CodexRuntimeError, never>(() => {
        assert.strictEqual(selected, hostId);
        assert.strictEqual(fence.expectedHostId, hostId);
        assert.strictEqual(fence.expectedGeneration, 7);
        requests.push({ method, path: params.path });
        if (params.path === deniedPath)
          return Effect.fail(
            codexRuntimeError({
              operation: "request",
              reason: "request",
              retryable: false,
              cause: new Error("Access denied"),
            }),
          );
        if (method === "fs/getMetadata")
          return Effect.succeed({
            isFile: params.path !== directoryPath,
            isDirectory: params.path === directoryPath,
            isSymlink: false,
            createdAtMs: 0,
            modifiedAtMs: 123,
          });
        if (options.retire === "generation") generation += 1;
        if (options.retire === "epoch") epoch = "endpoint-b";
        return Effect.succeed({
          dataBase64: options.invalidBase64
            ? "not-base64"
            : (params.path === pngPath ? png : Buffer.from("# Remote report\n")).toString("base64"),
        });
      }),
  } as unknown as CodexGateway["Service"];
  const capabilities = CodexAppServerCapabilities.of({
    forHost: () => Effect.sync(snapshot),
    forThread: () => Effect.die("File queries do not derive hosts from Threads"),
    isCurrent: (captured) =>
      Effect.sync(() => captured.generation === generation && captured.sourceEpoch === epoch),
  });
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CodexGateway, gateway),
        Layer.succeed(CodexAppServerCapabilities, capabilities),
      ),
    ),
  );
  return { layer, requests };
}

it.effect("checks real local files and directories without entering a native host", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-workspace-query-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const file = path.join(root, "report ");
      const directory = path.join(root, "output");
      yield* Effect.promise(() => writeFile(file, "local"));
      yield* Effect.promise(() => mkdir(directory));
      const queries = yield* WorkspaceFileQueries;
      assert.deepStrictEqual(
        yield* queries.pathsExist({ paths: [directory, path.join(root, "missing"), file] }),
        {
          existingPaths: [directory, file],
        },
      );
      assert.deepStrictEqual(f.requests, []);
    }).pipe(Effect.provide(f.layer)),
  );
});

it.effect("keeps remote existence order, includes directories and omits per-path failures", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.deepStrictEqual(
      yield* queries.pathsExist({ hostId, paths: [directoryPath, deniedPath, textPath] }),
      {
        existingPaths: [directoryPath, textPath],
      },
    );
    assert.isTrue(f.requests.every((request) => request.method === "fs/getMetadata"));
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses the exact remote filename for metadata, text and binary reads", () => {
  const f = fixture();
  const exactPath = `${textPath} `;
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    yield* queries.metadata({ hostId, path: exactPath });
    yield* queries.text({ hostId, path: exactPath, maxBytes: 100 });
    yield* queries.binary({ hostId, path: exactPath });
    assert.isTrue(f.requests.length > 0);
    assert.isTrue(f.requests.every((request) => request.path === exactPath));
    assert.strictEqual(f.requests.filter((request) => request.method === "fs/readFile").length, 2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("leaves unavailable native file size unknown and derives content only from bytes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.deepStrictEqual(yield* queries.metadata({ hostId, path: textPath }), {
      isFile: true,
      createdAtMs: null,
      mtimeMs: 123,
      sizeBytes: null,
    });
    assert.strictEqual(f.requests.length, 1);
    assert.deepStrictEqual(
      yield* queries.metadata({ hostId, path: pngPath, contentSampleByteLimit: 64 }),
      {
        isFile: true,
        createdAtMs: null,
        mtimeMs: 123,
        sizeBytes: png.length,
        contentKind: "binary",
        mimeType: "image/png",
      },
    );
    assert.deepStrictEqual(yield* queries.text({ hostId, path: textPath, maxBytes: 64 }), {
      contents: "# Remote report\n",
    });
    const binary = yield* queries.binary({ hostId, path: pngPath });
    assert.strictEqual(binary.contentsBase64, png.toString("base64"));
    assert.strictEqual(binary.mimeType, "image/png");
  }).pipe(Effect.provide(f.layer));
});

for (const retire of ["generation", "epoch"] as const) {
  it.effect(`rejects file contents after native ${retire} retirement`, () => {
    const f = fixture({ retire });
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      assert.isTrue(
        (yield* Effect.result(queries.text({ hostId, path: textPath, maxBytes: 64 })))._tag ===
          "Failure",
      );
    }).pipe(Effect.provide(f.layer));
  });
}

for (const option of [{ disconnected: true }, { missingEpoch: true }]) {
  it.effect("rejects unavailable or unproven remote hosts before filesystem dispatch", () => {
    const f = fixture(option);
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      assert.isTrue(
        (yield* Effect.result(queries.pathsExist({ hostId, paths: [textPath] })))._tag ===
          "Failure",
      );
      assert.deepStrictEqual(f.requests, []);
    }).pipe(Effect.provide(f.layer));
  });
}

it.effect("enforces the requested byte limit and rejects malformed native contents", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.isTrue(
      (yield* Effect.result(queries.text({ hostId, path: textPath, maxBytes: 4 })))._tag ===
        "Failure",
    );
    assert.isTrue(
      (yield* Effect.result(queries.text({ hostId, path: "relative.md", maxBytes: 64 })))._tag ===
        "Failure",
    );
    assert.isFalse(f.requests.some((request) => request.path === "relative.md"));
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects malformed base64 instead of displaying a silently decoded prefix", () => {
  const f = fixture({ invalidBase64: true });
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.isTrue(
      (yield* Effect.result(queries.binary({ hostId, path: pngPath })))._tag === "Failure",
    );
  }).pipe(Effect.provide(f.layer));
});
