import * as Context from "effect/Context";
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

const emptyRegistry = Buffer.from(
  JSON.stringify({
    attachmentPaths: [],
    pendingRemovalPaths: [],
    textExcerptsByPath: {},
  }),
  "utf8",
).toString("base64");

it.effect("routes pasted text and goal files through the selected execution host", () =>
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
        };
        requests.push({ hostId, method, path: input.path });
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
          transfer: null,
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
    assert.isTrue(goal.attachmentDirectory?.startsWith(`${remoteCodexHome}/attachments/`) ?? false);

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

    assert.isTrue(requests.length > 0);
    assert.isTrue(requests.every((request) => request.hostId === remoteHostId));
    assert.isTrue(requests.some((request) => request.method === "fs/createDirectory"));
    assert.isTrue(requests.some((request) => request.method === "fs/writeFile"));
    assert.isTrue(requests.some((request) => request.method === "fs/readFile"));
    assert.isTrue(requests.some((request) => request.method === "fs/remove"));

    yield* Scope.close(scope, Exit.void);
  }),
);
