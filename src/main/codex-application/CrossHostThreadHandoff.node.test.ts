import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import { CodexLocalExecutionHostFileTransfer } from "../codex/codex-execution-host-file-transfer";
import { executeCodexWorktreeWorkerOperation } from "../codex/codex-worktree-worker-operation";
import type {
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerRequest,
} from "../codex/codex-worktree-worker-protocol";
import {
  CrossHostThreadHandoff,
  live as crossHostThreadHandoffLive,
} from "./CrossHostThreadHandoff";
import {
  type ExecutionHost,
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
} from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

const run = promisify(execFile);

const git = (cwd: string, ...args: string[]): Effect.Effect<string> =>
  Effect.tryPromise(async () =>
    (await run("git", args, { cwd, env: process.env })).stdout.trim(),
  ).pipe(Effect.orDie);

const workerRequest = (hostId: string): ExecutionHost["request"] =>
  ((request: CodexWorktreeWorkerRequest, options) =>
    Effect.gen(function* () {
      const events: CodexWorktreeWorkerEvent[] = [];
      const success = yield* Effect.tryPromise({
        try: (signal) =>
          executeCodexWorktreeWorkerOperation(request, {
            signal,
            onEvent: (event) => events.push(event),
          }),
        catch: (cause) =>
          new ExecutionHostRuntimeError({
            operation: `worktree-${request.operation}`,
            hostId,
            cause,
          }),
      });
      yield* Effect.forEach(events, (event) => options?.onEvent?.(event) ?? Effect.void, {
        discard: true,
      });
      if (success.operation !== request.operation) {
        return yield* Effect.die(new Error("Worktree worker result mismatch"));
      }
      return success.value;
    })) as ExecutionHost["request"];

const makeHost = (input: {
  readonly id: string;
  readonly codexHome: string;
  readonly repository: string;
  readonly root: string;
  readonly relayBaseRoot: string;
}): ExecutionHost => {
  const stagingRoot = path.join(input.codexHome, "nodex-handoffs");
  const port = new CodexLocalExecutionHostFileTransfer({
    hostId: input.id,
    stagingRoot,
    allowedReadRoots: [input.root, input.relayBaseRoot],
  });
  const transferError = (operation: string, cause: unknown) =>
    new ExecutionHostRuntimeError({ operation, hostId: input.id, cause });
  return {
    descriptor: {
      hostId: input.id,
      displayName: input.id,
      kind: "local",
      nodexHome: path.join(input.root, "nodex-home"),
      codexHome: input.codexHome,
      managedRoot: path.join(input.root, "worktrees"),
      handoffStagingRoot: stagingRoot,
      repositoryRoots: [input.repository],
      capabilities: ["export-handoff", "import-handoff", "cleanup-transfer-handoff"],
      supportsFileTransfer: true,
    },
    request: workerRequest(input.id),
    transfer: {
      describe: (sourcePath) =>
        Effect.tryPromise({
          try: (signal) => port.describe(sourcePath, signal),
          catch: (cause) => transferError("describe", cause),
        }),
      download: (download) =>
        Effect.tryPromise({
          try: (signal) => port.download({ ...download, signal }),
          catch: (cause) => transferError("download", cause),
        }),
      upload: (upload) =>
        Effect.tryPromise({
          try: (signal) => port.upload({ ...upload, signal }),
          catch: (cause) => transferError("upload", cause),
        }),
      cleanup: (operationId) =>
        Effect.tryPromise({
          try: () => port.cleanup(operationId),
          catch: (cause) => transferError("cleanup", cause),
        }),
    },
  };
};

it.effect("atomically relays verified Git and rollout state and releases newborn protection", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise(() =>
      mkdtemp(path.join(tmpdir(), "nodex-cross-host-capability-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
    );
    const bare = path.join(root, "origin.git");
    const source = path.join(root, "source", "repository");
    const destination = path.join(root, "destination", "repository");
    yield* Effect.tryPromise(() =>
      Promise.all([
        mkdir(path.dirname(source), { recursive: true }),
        mkdir(path.dirname(destination), { recursive: true }),
      ]),
    );
    yield* git(root, "init", "--bare", bare);
    yield* git(root, "clone", bare, source);
    yield* git(source, "config", "user.name", "Nodex Test");
    yield* git(source, "config", "user.email", "nodex@example.test");
    yield* Effect.tryPromise(() => writeFile(path.join(source, "tracked.txt"), "base\n"));
    yield* git(source, "add", ".");
    yield* git(source, "commit", "-m", "base");
    yield* git(source, "push", "origin", "HEAD:main");
    yield* git(root, "clone", "--branch", "main", bare, destination);
    yield* Effect.tryPromise(() => writeFile(path.join(source, "tracked.txt"), "moved\n"));
    yield* Effect.tryPromise(() => writeFile(path.join(source, "untracked.txt"), "untracked\n"));

    const relayBaseRoot = path.join(root, "main-private", "handoffs");
    const sourceCodexHome = path.join(root, "source", "codex-home");
    const destinationCodexHome = path.join(root, "destination", "codex-home");
    const sourceRolloutPath = path.join(
      sourceCodexHome,
      "sessions",
      "2026",
      "08",
      "14",
      "thread.jsonl",
    );
    yield* Effect.tryPromise(() => mkdir(path.dirname(sourceRolloutPath), { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(sourceRolloutPath, '{"type":"session_meta","id":"thread"}\n'),
    );

    const hosts = [
      makeHost({
        id: "source",
        codexHome: sourceCodexHome,
        repository: source,
        root: path.join(root, "source"),
        relayBaseRoot,
      }),
      makeHost({
        id: "destination",
        codexHome: destinationCodexHome,
        repository: destination,
        root: path.join(root, "destination"),
        relayBaseRoot,
      }),
    ];
    const hostById = new Map(hosts.map((host) => [host.descriptor.hostId, host]));
    const activeSshHosts = yield* SubscriptionRef.make<
      ReadonlyMap<string, CodexSshExecutionHostConfig>
    >(new Map());
    const executionHosts = ExecutionHostRuntime.of({
      activeSshHosts,
      hosts: () => Effect.succeed(hosts.map((host) => host.descriptor)),
      get: (hostId) => Effect.succeed(hostById.get(hostId) ?? null),
      resolve: (hostId) => {
        const host = hostById.get(hostId);
        return host
          ? Effect.succeed(host)
          : Effect.fail(
              new ExecutionHostRuntimeError({
                operation: "resolve-host",
                hostId,
                cause: new Error("unknown host"),
              }),
            );
      },
      updateLocalManagedRoot: () => Effect.void,
      settings: Effect.succeed({ sshHosts: [] }),
      updateSettings: () => Effect.succeed({ sshHosts: [] }),
      reconcile: () => Effect.void,
    });
    const newborns = new Set<string>();
    const managed = ManagedWorktreeRuntime.of({
      list: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      restore: () => Effect.die("unused"),
      setOwner: () => Effect.die("unused"),
      registerNewborn: (input) =>
        Effect.sync(() => newborns.add(`${input.hostId}\0${input.worktreeGitRoot}`)).pipe(
          Effect.asVoid,
        ),
      releaseNewborn: (input) =>
        Effect.sync(() => newborns.delete(`${input.hostId}\0${input.worktreeGitRoot}`)).pipe(
          Effect.asVoid,
        ),
      isNewborn: (input) =>
        Effect.sync(() => newborns.has(`${input.hostId}\0${input.worktreeGitRoot}`)),
      newborns: Effect.sync(() =>
        [...newborns].map((entry) => {
          const [hostId, worktreeGitRoot] = entry.split("\0");
          return { hostId: hostId!, worktreeGitRoot: worktreeGitRoot! };
        }),
      ),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      crossHostThreadHandoffLive({ relayBaseRoot }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ExecutionHostRuntime, executionHosts),
            Layer.succeed(ManagedWorktreeRuntime, managed),
            NodeFileSystem.layer,
          ),
        ),
      ),
      scope,
    );
    const handoff = Context.get(context, CrossHostThreadHandoff);
    const prepared = yield* handoff.prepare({
      operationId: "transfer-1",
      threadId: "thread",
      threadTitle: "Cross host",
      projectId: "project",
      sourceHostId: "source",
      destinationHostId: "destination",
      sourceCwd: source,
      sourceWorkspaceRoot: source,
      sourceManagedWorktreePath: null,
      sourceRolloutPath,
      destinationRepositoryPaths: [destination],
    });

    assert.isTrue(newborns.has(`destination\0${prepared.managedWorktreePath}`));
    assert.strictEqual(
      yield* Effect.tryPromise(() =>
        readFile(path.join(prepared.destinationWorkspaceRoot, "tracked.txt"), "utf8"),
      ),
      "moved\n",
    );
    assert.strictEqual(
      yield* Effect.tryPromise(() => readFile(prepared.destinationRollout.path, "utf8")),
      '{"type":"session_meta","id":"thread"}\n',
    );

    assert.deepEqual(yield* handoff.cleanup(prepared, "committed"), []);
    assert.isFalse(newborns.has(`destination\0${prepared.managedWorktreePath}`));
    assert.strictEqual(
      yield* Effect.tryPromise(() =>
        readFile(path.join(prepared.destinationWorkspaceRoot, "untracked.txt"), "utf8"),
      ),
      "untracked\n",
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(git(source, "rev-parse", prepared.sourceTemporaryRef))),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(git(destination, "rev-parse", prepared.destinationTemporaryRef)),
      ),
    );
    yield* Scope.close(scope, Exit.void);
  }),
);
