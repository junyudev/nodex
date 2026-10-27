import * as Context from "effect/Context";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { layer as scopedCallbackRuntimeLayer } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAttachments, live } from "./CodexAttachments";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ExecutionHostRuntimeError } from "./ExecutionHostRuntime";

const emptyRegistry = Buffer.from(
  JSON.stringify({
    attachmentPaths: [],
    pendingRemovalPaths: [],
    textExcerptsByPath: {},
  }),
  "utf8",
).toString("base64");

it.effect(
  "routes owned attachments through their selected host and preserves resource bytes on retries",
  () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly hostId: string;
        readonly method: string;
        readonly path: string;
      }> = [];
      const files = new Map<string, string>();
      const remoteCodexHome = "/remote/home/.codex";
      const remoteHostId = "ssh:test";

      const requestOnHost = (hostId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          const input = params as {
            readonly path: string;
            readonly dataBase64?: string;
            readonly recursive?: boolean;
            readonly sourcePath?: string;
            readonly destinationPath?: string;
          };
          requests.push({ hostId, method, path: input.path ?? input.destinationPath ?? "" });
          if (method === "fs/copy") {
            const source = files.get(input.sourcePath!);
            if (!source) throw new Error("Source is missing");
            files.set(input.destinationPath!, source);
            return {};
          }
          if (method === "fs/createDirectory") return {};
          if (method === "fs/writeFile") {
            files.set(input.path, input.dataBase64 ?? "");
            return {};
          }
          if (method === "fs/readFile") {
            const dataBase64 =
              files.get(input.path) ??
              (input.path.endsWith("/pasted-text-attachments.json") ? emptyRegistry : undefined);
            if (dataBase64 === undefined) throw new Error(`ENOENT: ${input.path}`);
            return { dataBase64 };
          }
          if (method === "fs/remove") {
            if (input.recursive) {
              for (const filePath of files.keys()) {
                if (filePath === input.path || filePath.startsWith(`${input.path}/`)) {
                  files.delete(filePath);
                }
              }
            } else {
              files.delete(input.path);
            }
            return {};
          }
          throw new Error(`Unexpected request ${method}`);
        });

      const gateway = CodexGateway.of({
        localHostId: "local",
        events: Stream.empty,
        requestOnHost,
      } as unknown as CodexGateway["Service"]);
      let uploads = 0;
      const executionHosts = ExecutionHostRuntime.of({
        resolve: (hostId: string) =>
          Effect.succeed({
            descriptor: {
              hostId,
              displayName: hostId,
              kind: hostId === "local" ? "local" : "ssh",
              nodexHome: hostId === "local" ? "/local/.nodex" : "/remote/home/.nodex",
              codexHome: hostId === "local" ? "/local/.codex" : remoteCodexHome,
              managedRoot: "/worktrees",
              handoffStagingRoot: "/handoffs",
              repositoryRoots: [],
              capabilities: [],
              supportsFileTransfer: true,
            },
            transfer: {
              describe: (sourcePath: string) =>
                Effect.gen(function* () {
                  const value = files.get(sourcePath);
                  if (value === undefined)
                    return yield* new ExecutionHostRuntimeError({
                      operation: "describe",
                      cause: new Error(`ENOENT: ${sourcePath}`),
                    });
                  const bytes = Buffer.from(value, "base64");
                  return {
                    path: sourcePath,
                    size: bytes.byteLength,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                  };
                }),
              upload: (input: {
                localPath: string;
                operationId: string;
                fileName: string;
                sha256: string;
                size: number;
              }) =>
                Effect.promise(async () => {
                  const bytes = await readFile(input.localPath);
                  assert.equal(bytes.byteLength, input.size);
                  assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256);
                  const target = `/staging/${input.operationId}/${input.fileName}`;
                  files.set(target, bytes.toString("base64"));
                  uploads += 1;
                  return { path: target, size: input.size, sha256: input.sha256 };
                }),
              cleanup: (operationId: string) =>
                Effect.sync(() => {
                  for (const target of files.keys())
                    if (target.startsWith(`/staging/${operationId}/`)) files.delete(target);
                }),
            },
            request: () => Effect.die("unused"),
          }),
      } as unknown as ExecutionHostRuntime["Service"]);
      const dependencies = Layer.mergeAll(
        Layer.succeed(CodexGateway, gateway),
        Layer.succeed(ExecutionHostRuntime, executionHosts),
        scopedCallbackRuntimeLayer,
      );
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(live.pipe(Layer.provide(dependencies)), scope);
      const attachments = Context.get(context, CodexAttachments);

      const pasted = yield* attachments.createPastedText({
        text: "source text",
        hostId: remoteHostId,
      });
      assert.strictEqual(pasted.hostId, remoteHostId);
      assert.strictEqual(pasted.file.hostId, remoteHostId);
      assert.isTrue(pasted.file.fsPath.startsWith(`${remoteCodexHome}/attachments/`));
      assert.strictEqual(yield* attachments.readPastedText(pasted.file), "source text");

      const goal = yield* attachments.materializeGoal(remoteHostId, {
        objective: "Ship the change",
        pastedTextAttachments: [pasted],
        imageAttachments: [],
      });
      assert.isTrue(goal.objective.includes(`${remoteCodexHome}/attachments/`));
      assert.isTrue(
        goal.attachmentDirectory?.startsWith(`${remoteCodexHome}/attachments/`) ?? false,
      );

      const longGoal = yield* attachments.materializeGoal(remoteHostId, {
        objective: "x".repeat(4001),
        pastedTextAttachments: [],
        imageAttachments: [],
      });
      assert.strictEqual(
        yield* attachments.readEditableObjective(remoteHostId, longGoal.objective),
        "x".repeat(4001),
      );

      yield* attachments.cleanupMaterializedGoal(remoteHostId, goal.attachmentDirectory);
      yield* attachments.cleanupMaterializedGoal(remoteHostId, longGoal.attachmentDirectory);
      yield* attachments.removePastedText(pasted.file);

      // A normal file exceeds the JSON RPC frame: bytes must use the host's streaming transfer.
      const local = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "nodex-resource-test-")),
      );
      try {
        const localPath = path.join(local, "report.txt");
        const bytes = Buffer.alloc(17 * 1024 * 1024, 65);
        yield* Effect.promise(() => writeFile(localPath, bytes));
        const resources = [
          {
            name: "report.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
            source: localPath,
          },
          {
            name: "picture.png",
            mimeType: "image/png",
            sizeBytes: 3,
            source: "data:image/png;base64,YWJj",
          },
        ];
        const prepared = yield* attachments.materializeResources(remoteHostId, resources);
        const file = prepared.fileAttachments![0]!;
        assert.equal(file.hostId, remoteHostId);
        assert.isTrue(file.fsPath.startsWith(`${remoteCodexHome}/attachments/resources/`));
        assert.notEqual(file.fsPath, localPath);
        assert.equal(files.get(file.fsPath), bytes.toString("base64"));
        assert.equal(files.get(prepared.images![0]!.source), "YWJj");
        assert.deepEqual(
          yield* attachments.materializeResources(remoteHostId, resources),
          prepared,
        );
        assert.equal(
          uploads,
          2,
          "Same resources reuse their immutable destination without uploading again",
        );
        assert.equal([...files.keys()].filter((entry) => entry.startsWith("/staging/")).length, 0);

        yield* Effect.promise(() => writeFile(localPath, Buffer.alloc(bytes.length, 66)));
        const changed = yield* attachments.materializeResources(remoteHostId, [resources[0]!]);
        assert.notEqual(changed.fileAttachments![0]!.fsPath, file.fsPath);
        assert.equal(
          files.get(file.fsPath),
          bytes.toString("base64"),
          "New content cannot overwrite queued bytes",
        );
        files.set(file.fsPath, Buffer.from("external change").toString("base64"));
        yield* Effect.promise(() => writeFile(localPath, bytes));
        assert.isTrue(
          (yield* attachments
            .materializeResources(remoteHostId, [resources[0]!])
            .pipe(Effect.result))._tag === "Failure",
        );
        assert.equal(files.get(file.fsPath), Buffer.from("external change").toString("base64"));
      } finally {
        yield* Effect.promise(() => rm(local, { recursive: true, force: true }));
      }

      assert.isTrue(requests.length > 0);
      assert.isTrue(requests.every((request) => request.hostId === remoteHostId));
      assert.isTrue(requests.some((request) => request.method === "fs/createDirectory"));
      assert.isTrue(requests.some((request) => request.method === "fs/writeFile"));
      assert.isTrue(requests.some((request) => request.method === "fs/readFile"));
      assert.isTrue(requests.some((request) => request.method === "fs/remove"));

      yield* Scope.close(scope, Exit.void);
    }),
);
