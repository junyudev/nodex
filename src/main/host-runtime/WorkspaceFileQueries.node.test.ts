import { assert, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
import { GitWorkerRuntime } from "./GitWorkerRuntime";

const hostId = "ssh:fixture";
const textPath = "/workspace/report.md";
const videoPath = "/workspace/media.bin";
const video = readFileSync("tests/fixtures/workspace-media/vp9-opus.webm");
const pngPath = "/workspace/report.png";
const directoryPath = "/workspace/output";
const deniedPath = "/workspace/denied";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixture(
  options: {
    readonly disconnected?: boolean;
    readonly missingEpoch?: boolean;
    readonly retire?: "generation" | "epoch";
    readonly invalidBase64?: boolean;
    readonly gitMetadata?: boolean;
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
      params: { path: string; command?: string[] },
      fence: { expectedHostId: string; expectedGeneration: number },
    ) =>
      Effect.suspend<unknown, CodexRuntimeError, never>(() => {
        assert.strictEqual(selected, hostId);
        assert.strictEqual(fence.expectedHostId, hostId);
        assert.strictEqual(fence.expectedGeneration, 7);
        const filePath =
          params.command?.[3] === "nodex-file-read" ? params.command[4]! : params.path;
        requests.push({ method, path: filePath });
        if (method === "command/exec") {
          if (options.gitMetadata && params.command?.[0] === "git") {
            if (options.retire === "generation") generation += 1;
            if (options.retire === "epoch") epoch = "endpoint-b";
            const value =
              params.command[3] === "rev-parse"
                ? "/workspace"
                : params.command[3] === "branch"
                  ? "feature/menu"
                  : "git@github.com:team/project.git";
            return Effect.succeed({ exitCode: 0, stdout: `${value}\n`, stderr: "" });
          }
          if (params.command?.[3] !== "nodex-file-read")
            return Effect.succeed({ exitCode: 0, stdout: "/home/fixture", stderr: "" });
          if (options.retire === "generation") generation += 1;
          if (options.retire === "epoch") epoch = "endpoint-b";
          const contents =
            filePath === pngPath
              ? png
              : filePath === videoPath
                ? video
                : Buffer.from("# Remote report\n");
          const maxBytes = Number(params.command[5]);
          const maxFileBytes = Number(params.command[6]);
          const encoded = options.invalidBase64
            ? "not-base64"
            : contents.subarray(0, maxBytes).toString("base64");
          return Effect.succeed({
            exitCode: 0,
            stdout: `${contents.length}\n${contents.length > maxFileBytes ? "" : encoded}`,
            stderr: "",
          });
        }
        if (method === "fs/readDirectory") {
          if (options.retire === "generation") generation += 1;
          if (options.retire === "epoch") epoch = "endpoint-b";
          return Effect.succeed({
            entries: [
              { fileName: "src10", isDirectory: true, isFile: false },
              { fileName: "note.md", isDirectory: false, isFile: true },
              { fileName: ".config", isDirectory: true, isFile: false },
              { fileName: "src2", isDirectory: true, isFile: false },
              { fileName: "../escape", isDirectory: true, isFile: false },
            ],
          });
        }
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
        Layer.succeed(GitWorkerRuntime, {
          request: () =>
            Effect.succeed({
              root: "/repo",
              currentBranch: "main",
              originUrl: "git@github.com:team/project.git",
            }),
        } as unknown as GitWorkerRuntime["Service"]),
      ),
    ),
  );
  return { layer, requests };
}

it.effect("exports complete remote bytes through the same captured host", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.deepStrictEqual(yield* queries.exportBytes({ hostId, path: pngPath }), png);
    assert.deepStrictEqual(
      f.requests.map(({ method }) => method),
      ["fs/getMetadata", "fs/readFile"],
    );
  }).pipe(Effect.provide(f.layer));
});

for (const retire of ["generation", "epoch"] as const) {
  it.effect(`rejects remote export after native ${retire} retirement`, () => {
    const f = fixture({ retire });
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      assert.strictEqual(
        (yield* Effect.result(queries.exportBytes({ hostId, path: pngPath })))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(f.layer));
  });
}

it.effect("builds local GitHub references from the Git worker's current origin and branch", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.strictEqual(
      yield* queries.githubUrl({ path: "/repo/src/file.ts", line: 4 }),
      "https://github.com/team/project/blob/main/src/file.ts#L4",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("queries GitHub metadata on the source host without local filesystem access", () => {
  const f = fixture({ gitMetadata: true });
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.strictEqual(
      yield* queries.githubUrl({ hostId, path: "/workspace/src/file.ts", line: 5 }),
      "https://github.com/team/project/blob/feature/menu/src/file.ts#L5",
    );
    assert.strictEqual(f.requests.filter(({ method }) => method === "command/exec").length, 3);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects a GitHub URL prepared across a remote endpoint replacement", () => {
  const f = fixture({ gitMetadata: true, retire: "epoch" });
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.strictEqual(
      (yield* Effect.result(queries.githubUrl({ hostId, path: "/workspace/file.ts" })))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(f.layer));
});

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
    assert.strictEqual(f.requests.filter((request) => request.method === "command/exec").length, 3);
  }).pipe(Effect.provide(f.layer));
});

it.effect("samples remote content and reports its source-host size", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.deepStrictEqual(yield* queries.metadata({ hostId, path: textPath }), {
      isFile: true,
      createdAtMs: null,
      mtimeMs: 123,
      sizeBytes: 16,
      contentKind: "text",
    });
    assert.strictEqual(f.requests.length, 3);
    assert.deepStrictEqual(
      yield* queries.metadata({ hostId, path: pngPath, contentSampleByteLimit: 4096 }),
      {
        isFile: true,
        createdAtMs: null,
        mtimeMs: 123,
        sizeBytes: png.length,
        contentKind: "image",
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

it.effect("lists host directories with canonical home roots, filters and numeric sorting", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const queries = yield* WorkspaceFileQueries;
    assert.deepStrictEqual(
      yield* queries.directory({
        hostId,
        workspaceRoot: "~",
        directoryPath: "repo",
        directoriesOnly: true,
      }),
      {
        workspaceRoot: "/home/fixture",
        directoryPath: "repo",
        parentPath: "",
        entries: [
          { name: "src2", path: "repo/src2", type: "directory", isSymlink: false },
          { name: "src10", path: "repo/src10", type: "directory", isSymlink: false },
        ],
      },
    );
    assert.deepStrictEqual(
      f.requests.map(({ method, path }) => [method, path]),
      [
        ["command/exec", undefined],
        ["fs/readDirectory", "/home/fixture/repo"],
      ],
    );
    const all = yield* queries.directory({ hostId, workspaceRoot: "/repo", includeHidden: true });
    assert.deepStrictEqual(
      all.entries.map((entry) => entry.name),
      [".config", "src2", "src10", "note.md"],
    );
    assert.strictEqual(all.parentPath, null);
    const escaped = yield* Effect.result(
      queries.directory({ hostId, workspaceRoot: "/repo", directoryPath: "../escape" }),
    );
    assert.strictEqual(escaped._tag, "Failure");
    assert.isFalse(f.requests.some((request) => request.path === "/escape"));
  }).pipe(Effect.provide(f.layer));
});

for (const retire of ["generation", "epoch"] as const) {
  it.effect(`rejects directory entries after native ${retire} retirement`, () => {
    const f = fixture({ retire });
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      const result = yield* Effect.result(queries.directory({ hostId, workspaceRoot: "/repo" }));
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.provide(f.layer));
  });
}

it.effect(
  "bounds remote binary reads and skips sampling files above the requested metadata limit",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      const result = yield* Effect.result(
        queries.binary({ hostId, path: pngPath, maxBytes: png.length - 1 }),
      );
      assert.strictEqual(result._tag, "Failure");
      const metadata = yield* queries.metadata({
        hostId,
        path: pngPath,
        contentSampleMaxFileBytes: 1,
      });
      assert.strictEqual(metadata.sizeBytes, png.length);
      assert.isUndefined(metadata.contentKind);
      assert.isFalse(f.requests.some(({ method }) => method === "fs/readFile"));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "sniffs remote video metadata and returns playable media bytes from the same host",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const queries = yield* WorkspaceFileQueries;
      const metadata = yield* queries.metadata({ hostId, path: videoPath });
      assert.strictEqual(metadata.contentKind, "video");
      assert.strictEqual(metadata.mimeType, "video/webm");
      assert.strictEqual(metadata.sizeBytes, video.length);
      const bytes = yield* queries.binary({ hostId, path: videoPath, maxBytes: video.length });
      assert.strictEqual(bytes.contentsBase64, video.toString("base64"));
      assert.strictEqual(bytes.mimeType, "video/webm");
      assert.strictEqual(bytes.contentKind, "video");
    }).pipe(Effect.provide(f.layer));
  },
);
